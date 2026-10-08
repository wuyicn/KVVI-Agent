import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionList } from '../src/list.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const header = (id: string): SessionHeader => ({
  id: SessionId(id), version: SESSION_FORMAT_VERSION, createdAt: 100, cwd: '/customer', isSeeded: false,
})
const standalone: SessionEvent[] = [
  { type: 'permission/preset', seq: SessionSeq(0), time: 101, data: { preset: 'danger-full-access' } },
  { type: 'sandbox/mode', seq: SessionSeq(1), time: 102, data: { mode: 'danger-full-access' } },
  { type: 'session/end-seed', seq: SessionSeq(2), time: 103, data: {} },
]

describe('cold list metadata recovery', () => {
  it('recovers blankness from durable logs and keeps subsequent lists body-free after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-list-recovery-'))
    const metas = [header('old-blank'), header('old-conversation')]
    const logs = [standalone, [
      ...standalone,
      { type: 'turn/start', seq: SessionSeq(3), time: 200, data: { turn: 0 } },
      { type: 'user/message', seq: SessionSeq(4), time: 300,
        data: createUserMessage({ content: [{ type: 'text', text: 'register customer' }], source: { kind: 'user' } }),
        surfaceOp: 'append' },
    ] as SessionEvent[]]
    const inspect = vi.fn(async (id: SessionId) => {
      const i = metas.findIndex(meta => meta.id === id)
      return { meta: metas[i]!, events: logs[i]! }
    })
    const boot = async () => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      installSessionReadTestServices(ctx)
      ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
        list: async () => metas, inspect,
      }) as never)
      const list = new ApiSessionList(ctx, true)
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5000 })
      return { ctx, list }
    }
    let active: Context | undefined
    try {
      const first = await boot()
      active = first.ctx
      const rows = await first.list.list()
      expect(rows.find(row => row.sessionId === 'old-blank')?.blank).toBe(true)
      expect(rows.find(row => row.sessionId === 'old-conversation')).toMatchObject({ blank: false, updatedAt: 300 })
      expect(first.ctx.sessions.list()).toHaveLength(0)
      expect(first.ctx.agents.list()).toHaveLength(0)
      await vi.waitFor(() => {
        expect(first.ctx.sessionProjectionCache.cachedSnapshot(metas[0]!, SessionLogOffset(0))?.values)
          .toMatchObject({ sessionListMetadata: { blank: true } })
        expect(first.ctx.sessionProjectionCache.cachedSnapshot(metas[1]!, SessionLogOffset(0))?.values)
          .toMatchObject({ sessionListMetadata: { blank: false } })
      })
      await first.ctx.fiber.dispose()
      const second = await boot()
      active = second.ctx
      inspect.mockClear()
      expect((await second.list.list()).find(row => row.sessionId === 'old-blank')?.blank).toBe(true)
      expect(inspect).not.toHaveBeenCalled()
      expect(second.ctx.agents.list()).toHaveLength(0)
    } finally {
      await active?.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps unreadable history visible instead of hiding it as empty', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header('unreadable')],
      inspect: async () => { throw new Error('stored log unavailable') },
    }) as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    try {
      const rows = await new ApiSessionList(ctx, true).list()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.blank).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })
  it('propagates cancellation and closes the recovery read handle', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const cancellation = new AbortController()
    const close = vi.fn(async () => {})
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: async () => [header('cancelled')],
      open: async () => ({
        header: header('cancelled'), inheritedEventCount: SessionLogOffset(0),
        read: async () => {
          cancellation.abort(new Error('cancelled list'))
          return { eventState: 'detached', events: standalone }
        }, close,
      }) as never,
    }) as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    try {
      await expect(new ApiSessionList(ctx, true).list(cancellation.signal)).rejects.toThrow('cancelled list')
      expect(close).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
})

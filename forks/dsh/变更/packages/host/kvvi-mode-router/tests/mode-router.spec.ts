import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  assertOwnedSessionId, assertPresetAllowed, authorizeRuntimeRequest,
  enforceCreateRequest, filterControlFrame, KvviModeRouter, ownedSessionId,
  signModeHeaders, verifyModeHeaders, presetFor,
} from '../src/index.ts'

const secret = 'stage8-mode-router-secret'
const context = {
  sessionId: 'a0000000-0000-4000-8000-000000000099',
  userId: 'a0000000-0000-4000-8000-000000000002',
  companyId: 'a0000000-0000-4000-8000-000000000001',
  gateway: 'USER' as const,
}

describe('KVVI mode router', () => {
  it('maps only trusted gateways to fixed presets', () => {
    expect(presetFor('BUILDER')).toBe('kvvi-builder')
    expect(presetFor('USER')).toBe('kvvi-worker')
    expect(() => presetFor('admin')).toThrow('KVVI_GATEWAY_INVALID')
  })

  it('accepts a fresh platform-signed context and rejects tampering', () => {
    const headers = signModeHeaders(context, secret, 1_700_000_000_000)
    expect(verifyModeHeaders(headers, secret, 1_700_000_000_500)).toEqual({
      ...context, preset: 'kvvi-worker', issuedAt: 1_700_000_000_000,
    })
    expect(() => verifyModeHeaders({ ...headers, 'x-kvvi-gateway': 'BUILDER' },
      secret, 1_700_000_000_500)).toThrow('KVVI_RUNTIME_CONTEXT_INVALID')
  })

  it('fails closed for missing, stale, or unknown context', () => {
    expect(() => verifyModeHeaders({}, secret, 1_700_000_000_500))
      .toThrow('KVVI_RUNTIME_CONTEXT_REQUIRED')
    const stale = signModeHeaders(context, secret, 1_699_999_000_000)
    expect(() => verifyModeHeaders(stale, secret, 1_700_000_000_500))
      .toThrow('KVVI_RUNTIME_CONTEXT_EXPIRED')
    expect(() => signModeHeaders({ ...context, gateway: 'ADMIN' as never }, secret))
      .toThrow('KVVI_GATEWAY_INVALID')
  })

  it('overrides caller-selected presets and locks later selection', () => {
    const mode = { ...context, preset: 'kvvi-worker' as const, issuedAt: 1 }
    expect(enforceCreateRequest({ cwd: '/work', sessionId: 'local', agentPreset: 'kvvi-builder' }, mode))
      .toEqual({ cwd: '/work', sessionId: ownedSessionId(mode, 'local'), agentPreset: 'kvvi-worker' })
    expect(() => assertPresetAllowed('kvvi-builder', 'kvvi-worker'))
      .toThrow('KVVI_PRESET_LOCKED_TO_SESSION_MODE')
    expect(() => assertPresetAllowed('kvvi-worker', 'kvvi-worker')).not.toThrow()
  })

  it('namespaces sessions by company, user, and gateway and rejects cross-mode access', () => {
    const worker = { ...context, preset: 'kvvi-worker' as const, issuedAt: 1 }
    const builder = { ...worker, gateway: 'BUILDER' as const, preset: 'kvvi-builder' as const }
    const workerId = ownedSessionId(worker, 'shared-name')
    const builderId = ownedSessionId(builder, 'shared-name')
    expect(workerId).not.toBe(builderId)
    expect(() => assertOwnedSessionId(workerId, worker)).not.toThrow()
    expect(() => assertOwnedSessionId(builderId, worker)).toThrow('KVVI_SESSION_ACCESS_DENIED')
    expect(() => authorizeRuntimeRequest('session/prompt',
      { args: { request: { sessionId: builderId } } }, worker))
      .toThrow('KVVI_SESSION_ACCESS_DENIED')
    expect(() => authorizeRuntimeRequest('session/fork',
      { args: { request: { sessionId: workerId } } }, worker))
      .toThrow('KVVI_SESSION_FORK_DISABLED')
  })

  it('blocks generic plugin management and filters host-wide control state', () => {
    const worker = { ...context, preset: 'kvvi-worker' as const, issuedAt: 1 }
    const workerId = ownedSessionId(worker, 'worker')
    const builder = { ...worker, gateway: 'BUILDER' as const, preset: 'kvvi-builder' as const }
    const builderId = ownedSessionId(builder, 'builder')
    expect(() => authorizeRuntimeRequest('pluginManager/installBundle', { args: {} }, worker))
      .toThrow('KVVI_PLUGIN_MANAGEMENT_DISABLED')
    expect(filterControlFrame({ type: 'baseline', value: {
      jobs: { [workerId]: ['own'], [builderId]: ['other'] },
      projections: { [workerId]: { own: true }, [builderId]: { other: true } },
    } }, worker)).toEqual({ type: 'baseline', value: {
      jobs: { [workerId]: ['own'] }, projections: { [workerId]: { own: true } },
    } })
    expect(filterControlFrame({ type: 'jobs', sessionId: builderId, jobs: [] }, worker))
      .toBeUndefined()
  })

  it('binds create and preset-select calls to the signed request context', async () => {
    const ctx = new Context()
    const creates: unknown[] = []
    ctx.provide('connection' as never, {} as never)
    ctx.provide('sessionController', {
      create: async (request: Record<string, unknown>) => { creates.push(request); return request },
      list: async () => ({ items: [] }),
      search: async () => ({ items: [], hasMore: false }),
      control: async function * () { yield { type: 'baseline', value: { jobs: {}, projections: {} } } },
    })
    ctx.provide('agentPresets', {
      select: async (_agent: unknown, requested: string) => requested,
    })
    await ctx.plugin(KvviModeRouter, { secret })

    const headers = signModeHeaders(context, secret)
    const response = {
      writeHead: () => response,
      end: () => response,
    }
    await ctx.waterfall('connection/request', { headers } as never, response as never,
      async () => {
        await ctx.sessionController.create({ cwd: '/work', agentPreset: 'kvvi-builder' })
        await expect(ctx.agentPresets.select({} as never, 'kvvi-builder'))
          .rejects.toThrow('KVVI_PRESET_LOCKED_TO_SESSION_MODE')
        await expect(ctx.agentPresets.select({} as never, 'kvvi-worker')).resolves.toBe('kvvi-worker')
      })

    await ctx.waterfall('typert-gateway/upgrade', { headers } as never, {} as never,
      Buffer.alloc(0), async () => {
        await expect(ctx.serial('typert-gateway/request', 'pluginManager/listPlugins',
          { args: {} })).rejects.toThrow('KVVI_PLUGIN_MANAGEMENT_DISABLED')
      })

    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({ cwd: '/work', agentPreset: 'kvvi-worker' })
    expect((creates[0] as Record<string, unknown>).sessionId).toMatch(/^kvvi1\./u)
    await ctx.fiber.dispose()
  })
})

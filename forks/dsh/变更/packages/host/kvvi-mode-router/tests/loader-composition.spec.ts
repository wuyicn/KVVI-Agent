import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as business from '@deepseek-ai/dsh-tool-kvvi-business'
import { expect, it } from 'vitest'
import KvviModeRouter, { ownedSessionId, signModeHeaders } from '../src/index.ts'

const secret = 'loader-background-identity-secret'
const identity = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  companyId: '33333333-3333-4333-8333-333333333333',
  gateway: 'USER' as const,
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind a port')
  return `http://127.0.0.1:${String(address.port)}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

it('loads background workflow identity and mandatory confirmation through YAML and records platform revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kvvi-background-loader-'))
  const ctx = new Context()
  const posts: { path: string; method: string; body: unknown; headers: Record<string, string | string[] | undefined> }[] = []
  let revoked = false
  const platform = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      posts.push({ path: request.url!, method: request.method!, body: JSON.parse(body), headers: request.headers })
      response.writeHead(revoked ? 401 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(revoked ? { error: 'KVVI_SESSION_REVOKED' }
        : { recordId: 'record-1', from: 'pending', state: 'approved', rowVersion: 8 }))
    })().catch(error => { response.writeHead(500); response.end(String(error)) })
  })
  let agent!: Agent
  const ingress = createServer((request, response) => {
    void ctx.waterfall('connection/request', request, response, async () => {
      const mode = ctx.kvviModeRouter.requireMode()
      agent = (await ctx.agents.create({
        sessionId: SessionId(ownedSessionId(mode, 'loader-worker')),
        meta: { agentPreset: mode.preset },
      })).agent
      response.end(JSON.stringify({ sessionId: agent.id }))
    }).catch(error => { response.writeHead(500); response.end(String(error)) })
  })
  try {
    const platformUrl = await listen(platform)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- name: cordis:llm',
      '- name: cordis:session',
      '- name: cordis:projections',
      '- name: cordis:prompt',
      '- name: cordis:tools',
      '- name: cordis:agents',
      '- name: cordis:loop',
      '  config: { agents: [] }',
      '- name: cordis:approval',
      '  config: { policy: ask }',
      '- name: cordis:unused-gui-facades',
      '- name: cordis:mode-router',
      `  config: { secret: ${JSON.stringify(secret)} }`,
      '- name: cordis:business',
      `  config: { platformUrl: ${JSON.stringify(platformUrl)}, contextSecret: ${JSON.stringify(secret)} }`,
      '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include, llm: LlmRuntime, session: SessionStore, projections: SessionProjectionRegistry,
      prompt: SystemPrompt, tools: ToolRuntime, agents: AgentRegistry, loop: AgentLoop,
      approval: ApprovalService, 'mode-router': KvviModeRouter, business,
      // These GUI facades are constructor dependencies only. Fail if the
      // exercised identity/approval/tool path ever tries to call a facade.
      'unused-gui-facades': {
        name: 'unused-gui-facades',
        apply(scope: Context) {
          const unused = (): never => { throw new Error('GUI facade is outside this composition test') }
          scope.provide('connection' as never, {} as never)
          scope.provide('sessionController', {
            create: unused, list: unused, search: unused, control: unused,
          })
          scope.provide('agentPresets', { select: unused, remoteExportList: unused })
        },
      },
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    expect(ctx.tools.schemas().some(tool => tool.name === 'workflow_act')).toBe(true)

    const ingressUrl = await listen(ingress)
    const created = await fetch(ingressUrl, { method: 'POST', headers: signModeHeaders(identity, secret) })
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ sessionId: agent.id })
    expect(() => ctx.kvviModeRouter.requireMode()).toThrow('KVVI_RUNTIME_CONTEXT_REQUIRED')
    agent.session.append('turn/start', { turn: 1 })
    const seen: { sessionId: string; callId: string | undefined; reason: string | undefined }[] = []
    let answer: ApprovalOutcome = 'allowed-once'
    ctx.on('approval/request', async (request) => {
      seen.push({ sessionId: ctx.kvviModeRouter.requireMode().sessionId,
        callId: request.callId, reason: request.reason })
      expect(request.agent).toBe(agent)
      return answer
    })
    const args = { system: 'leave', id: 'record-1', action: 'approve', rowVersion: 7 }
    const run = (callId: string) => ctx.tools.execute({
      agent, name: 'workflow_act', arguments: args,
      callId: ToolCallId(callId), signal: new AbortController().signal,
    })

    expect(await run('approved')).toMatchObject({ isError: false,
      value: { recordId: 'record-1', from: 'pending', state: 'approved', rowVersion: 8 } })
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ method: 'POST',
      path: '/api/v1/systems/leave/records/record-1/transitions',
      body: { action: 'approve', rowVersion: 7 } })
    answer = 'rejected'
    expect(await run('denied')).toMatchObject({ isError: true })
    expect(posts).toHaveLength(1)
    answer = 'allowed-once'
    revoked = true
    const refused = await run('revoked')
    expect(refused.isError).toBe(true)
    expect(refused.error?.message).toBe('KVVI_SESSION_REVOKED')
    expect(posts).toHaveLength(2)
    for (const post of posts) {
      expect(post.headers).toMatchObject({ 'x-kvvi-session': identity.sessionId,
        'x-kvvi-user': identity.userId, 'x-kvvi-company': identity.companyId, 'x-kvvi-gateway': 'USER' })
      const expected = createHmac('sha256', secret).update([
        'v1', identity.sessionId, identity.userId, identity.companyId, identity.gateway,
        post.headers['x-kvvi-issued-at'],
      ].join('\n')).digest('hex')
      expect(post.headers['x-kvvi-signature']).toBe(expected)
    }
    expect(seen.map(request => [request.sessionId, request.callId])).toEqual([
      [identity.sessionId, 'approved'], [identity.sessionId, 'denied'], [identity.sessionId, 'revoked'],
    ])
    for (const request of seen) {
      expect(request.reason).toBe(`确认流程变更：系统=leave，记录=record-1，动作=approve，版本=7。企业=${identity.companyId}，用户=${identity.userId}。`)
    }
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(agent.session.snapshotEvents().filter(event => event.type.startsWith('approval/'))
      .map(event => event.type === 'approval/asked'
        ? { type: event.type, callId: event.data.callId, toolName: event.data.toolName }
        : event.type === 'approval/decided' ? { type: event.type, outcome: event.data.outcome } : { type: event.type }))
      .toEqual([
        { type: 'approval/asked', callId: 'approved', toolName: 'workflow_act' },
        { type: 'approval/decided', outcome: 'allowed-once' },
        { type: 'approval/asked', callId: 'denied', toolName: 'workflow_act' },
        { type: 'approval/decided', outcome: 'rejected' },
        { type: 'approval/asked', callId: 'revoked', toolName: 'workflow_act' },
        { type: 'approval/decided', outcome: 'allowed-once' },
      ])
  } finally {
    await close(ingress)
    await ctx.fiber.dispose()
    await close(platform)
    await rm(root, { recursive: true, force: true })
  }
})

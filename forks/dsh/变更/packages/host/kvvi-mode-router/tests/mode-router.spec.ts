import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import TypertGatewayService, {
  type TypertRemoteEventDispatch, type TypertRemoteEventOutcome,
} from '@deepseek-ai/dsh-api-gateway'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as business from '@deepseek-ai/dsh-tool-kvvi-business'
import {
  assertOwnedSessionId, assertPresetAllowed, authorizeRuntimeRequest,
  enforceCreateRequest, filterControlFrame, KvviModeRouter, ownedSessionId,
  projectRuntimeFrame, RuntimeOwnership, signModeHeaders, verifyModeHeaders, presetFor,
} from '../src/index.ts'

const secret = 'stage8-mode-router-secret'
const context = {
  sessionId: 'a0000000-0000-4000-8000-000000000099',
  userId: 'a0000000-0000-4000-8000-000000000002',
  companyId: 'a0000000-0000-4000-8000-000000000001',
  gateway: 'USER' as const,
}

class EventBroadcast {
  private readonly queues = new Set<{
    frames: TypertRemoteEventDispatch[]
    wake: (() => void) | undefined
  }>()

  readonly source = (signal: AbortSignal): AsyncIterable<TypertRemoteEventDispatch> => {
    const queue = { frames: [] as TypertRemoteEventDispatch[], wake: undefined as (() => void) | undefined }
    this.queues.add(queue)
    return this.iterate(queue, signal)
  }

  publish(frame: TypertRemoteEventDispatch): void {
    for (const queue of this.queues) {
      queue.frames.push(frame)
      queue.wake?.()
      queue.wake = undefined
    }
  }

  private async *iterate(queue: { frames: TypertRemoteEventDispatch[]; wake: (() => void) | undefined },
    signal: AbortSignal): AsyncGenerator<TypertRemoteEventDispatch> {
    try {
      while (!signal.aborted) {
        while (queue.frames.length > 0) yield queue.frames.shift() as TypertRemoteEventDispatch
        if (signal.aborted) return
        await new Promise<void>((resolve) => {
          queue.wake = resolve
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        queue.wake = undefined
      }
    } finally { this.queues.delete(queue) }
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

async function openEvents(port: number, headers: Record<string, string>, streamId: string):
Promise<{ socket: WebSocket; frames: Record<string, unknown>[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/remote.mux`, { headers })
  await once(socket, 'open')
  const frames: Record<string, unknown>[] = []
  socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }))
  await vi.waitFor(() => {
    expect(frames.some(frame => frame.type === 'item' && frame.streamId === streamId
      && typeof frame.value === 'object' && frame.value !== null
      && Reflect.get(frame.value, 'type') === 'ready'), JSON.stringify(frames)).toBe(true)
  })
  return { socket, frames }
}

async function toolHarness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  ctx.provide('connection' as never, {} as never)
  const disposers = new Map<Agent, () => Promise<void>>()
  ctx.provide('sessionController', {
    create: async (request) => {
      const handle = await ctx.agents.create({
        sessionId: SessionId(request.sessionId!), meta: { agentPreset: request.agentPreset! },
      })
      disposers.set(handle.agent, () => handle.dispose())
      return handle.agent
    },
    list: async () => ({ items: [] }),
    search: async () => ({ items: [] }),
    control: async function * () {},
  })
  ctx.provide('agentPresets', {
    select: async (_agent: unknown, requested: string) => requested,
    remoteExportList: async () => ({ presets: [], authorable: false, modeSelectionEnabled: false }),
  })
  const router = await ctx.plugin(KvviModeRouter, { secret })
  const observed: string[] = []
  ctx.tools.register(defineTool({
    name: 'identity_probe', description: 'Read the runtime platform identity', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      await Promise.resolve()
      const mode = ctx.kvviModeRouter.requireMode()
      observed.push(mode.sessionId)
      return mode.sessionId
    },
  }))
  const request = async (identity: Parameters<typeof signModeHeaders>[0], next: () => Promise<void>) => {
    const response = { writeHead: () => response, end: () => response }
    await ctx.waterfall('connection/request', { headers: signModeHeaders(identity, secret) } as never,
      response as never, next)
  }
  const create = async (identity: Parameters<typeof signModeHeaders>[0], id: string) => {
    let agent!: Agent
    await request(identity, async () => {
      agent = await ctx.sessionController.create({ sessionId: id }) as Agent
    })
    return agent
  }
  const execute = (agent?: Agent, args: unknown = {}) => ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('probe'),
    name: 'identity_probe', arguments: args, ...agent === undefined ? {} : { agent },
  })
  const dispose = (agent: Agent) => disposers.get(agent)!()
  return { ctx, router, request, create, execute, dispose, observed }
}

describe('KVVI background tool identity', () => {
  it('recovers the original platform session for pre-execute, approval and dispatch after the request ends', async () => {
    const { ctx, create, execute } = await toolHarness()
    try {
      const agent = await create(context, 'background')
      agent.session.append('turn/start', { turn: 1 })
      expect(() => ctx.kvviModeRouter.requireMode()).toThrow('KVVI_RUNTIME_CONTEXT_REQUIRED')
      const stages: string[] = []
      ctx.on('tools/pre-execute', async (_exec, _next) => {
        stages.push(`pre:${ctx.kvviModeRouter.requireMode().sessionId}`)
        return { kind: 'ask' }
      })
      ctx.on('approval/request', async (_req, _next) => {
        stages.push(`approval:${ctx.kvviModeRouter.requireMode().sessionId}`)
        return 'allowed-once'
      })
      const result = await execute(agent)
      expect(result.isError).toBe(false)
      expect(result.value).toBe(context.sessionId)
      expect(stages).toEqual([`pre:${context.sessionId}`, `approval:${context.sessionId}`])
      expect(() => ctx.kvviModeRouter.requireMode()).toThrow('KVVI_RUNTIME_CONTEXT_REQUIRED')
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses an unknown agent despite a valid-looking namespace or model-supplied identity', async () => {
    const { ctx, execute, observed } = await toolHarness()
    try {
      const mode = { ...context, preset: 'kvvi-worker' as const, issuedAt: 1 }
      const agent = (await ctx.agents.create({ sessionId: SessionId(ownedSessionId(mode, 'unverified')) })).agent
      for (const candidate of [agent, undefined]) {
        const result = await execute(candidate, { ...context })
        expect(result.isError).toBe(true)
        expect(result.error?.message).toBe('KVVI_RUNTIME_CONTEXT_REQUIRED')
      }
      expect(observed).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a different current caller session even in the same owner namespace', async () => {
    const { ctx, create, request, execute, observed } = await toolHarness()
    try {
      const agent = await create(context, 'original')
      await request({ ...context, sessionId: 'another-platform-session' }, async () => {
        const result = await execute(agent)
        expect(result.isError).toBe(true)
        expect(result.error?.message).toBe('KVVI_SESSION_ACCESS_DENIED')
      })
      expect(observed).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps concurrent background sessions isolated', async () => {
    const { ctx, create, execute } = await toolHarness()
    try {
      const other = { ...context, gateway: 'BUILDER' as const, userId: 'other-user',
        companyId: 'other-company', sessionId: 'other-session' }
      const [first, second] = await Promise.all([create(context, 'first'), create(other, 'second')])
      const results = await Promise.all([execute(first), execute(second), execute(first)])
      expect(results.map(result => result.value)).toEqual([context.sessionId, other.sessionId, context.sessionId])
      expect(results.every(result => !result.isError)).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects cross-company, cross-user and cross-mode current callers before policy runs', async () => {
    const { ctx, create, request, execute, observed } = await toolHarness()
    try {
      const agent = await create(context, 'owner')
      const policy: string[] = []
      ctx.on('tools/pre-execute', async (_exec, next) => { policy.push('entered'); return next() })
      for (const caller of [
        { ...context, companyId: 'another-company' },
        { ...context, userId: 'another-user' },
        { ...context, gateway: 'BUILDER' as const },
      ]) {
        await request(caller, async () => {
          const result = await execute(agent)
          expect(result.error?.message).toBe('KVVI_SESSION_ACCESS_DENIED')
        })
      }
      expect(policy).toEqual([])
      expect(observed).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('loses background authority after router restart even for the same live Agent', async () => {
    const { ctx, router, create, execute } = await toolHarness()
    try {
      const agent = await create(context, 'before-restart')
      expect((await execute(agent)).value).toBe(context.sessionId)
      await router.dispose()
      await ctx.plugin(KvviModeRouter, { secret })
      const result = await execute(agent)
      expect(result.error?.message).toBe('KVVI_RUNTIME_CONTEXT_REQUIRED')
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses agentless tool calls inside an authenticated request', async () => {
    const { ctx, request, execute, observed } = await toolHarness()
    try {
      await request(context, async () => {
        const result = await execute(undefined, context)
        expect(result.error?.message).toBe('KVVI_RUNTIME_CONTEXT_REQUIRED')
      })
      expect(observed).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses authenticated publication of an Agent outside the caller namespace', async () => {
    const { ctx, request } = await toolHarness()
    try {
      const other = { ...context, companyId: 'another-company', preset: 'kvvi-worker' as const, issuedAt: 1 }
      const sessionId = SessionId(ownedSessionId(other, 'cross-company'))
      await request(context, async () => {
        await expect(ctx.agents.create({ sessionId, meta: { agentPreset: 'kvvi-worker' } }))
          .rejects.toThrow('KVVI_SESSION_ACCESS_DENIED')
      })
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('removes identity when the Agent is disposed', async () => {
    const { ctx, create, execute, dispose } = await toolHarness()
    try {
      const agent = await create(context, 'disposed')
      expect((await execute(agent)).value).toBe(context.sessionId)
      await dispose(agent)
      const result = await execute(agent)
      expect(result.error?.message).toBe('KVVI_RUNTIME_CONTEXT_REQUIRED')
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['disposed', 'session-replaced'] as const)(
    'refuses a late workflow approval after its Agent is %s', async invalidation => {
      const { ctx, create, dispose } = await toolHarness()
      let agent: Agent | undefined
      let originalSession: Session | undefined
      const answer = Promise.withResolvers<'allowed-once'>()
      try {
        await ctx.plugin(business, { platformUrl: 'http://platform.test', contextSecret: secret })
        agent = await create(context, `approval-${invalidation}`)
        originalSession = agent.session
        originalSession.append('turn/start', { turn: 1 })
        const entered = Promise.withResolvers<void>()
        ctx.on('approval/request', async () => { entered.resolve(); return answer.promise })
        const posts: string[] = []
        vi.stubGlobal('fetch', async (url: string) => {
          posts.push(url)
          return new Response(JSON.stringify({
            recordId: 'record-1', from: 'pending', state: 'approved', rowVersion: 8,
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        })
        const signal = new AbortController().signal
        const pending = ctx.tools.execute({
          agent, name: 'workflow_act', signal, callId: ToolCallId(`late-${invalidation}`),
          arguments: { system: 'leave', id: 'record-1', action: 'approve', rowVersion: 7 },
        })
        await entered.promise
        if (invalidation === 'disposed') await dispose(agent)
        else expect(Reflect.set(agent, 'session', Session.create(agent.id))).toBe(true)
        expect(signal.aborted).toBe(false)
        answer.resolve('allowed-once')
        const result = await pending
        expect(posts).toEqual([])
        expect(result.isError).toBe(true)
        expect(result.error?.message).toBe(invalidation === 'disposed'
          ? 'KVVI_RUNTIME_CONTEXT_REQUIRED' : 'KVVI_SESSION_ACCESS_DENIED')
      } finally {
        answer.resolve('allowed-once')
        if (agent !== undefined && originalSession !== undefined) Reflect.set(agent, 'session', originalSession)
        vi.unstubAllGlobals()
        await ctx.fiber.dispose()
      }
    },
  )
})

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
    expect(projectRuntimeFrame('$events', { type: 'emit', event: 'api-session/added',
      args: [{ sessionId: builderId }] }, worker)).toBeUndefined()
    expect(projectRuntimeFrame('$events', { type: 'emit', event: 'api-session/status',
      args: [workerId, true] }, worker)).toEqual({ type: 'emit',
      event: 'api-session/status', args: [workerId, true] })
  })

  it('projects every session-scoped event to its exact signed identity', () => {
    const worker = { ...context, preset: 'kvvi-worker' as const, issuedAt: 1 }
    const builder = { ...worker, gateway: 'BUILDER' as const, preset: 'kvvi-builder' as const }
    const workerId = ownedSessionId(worker, 'worker')
    const builderId = ownedSessionId(builder, 'builder')
    const ownership = new RuntimeOwnership()

    for (const frame of [
      { type: 'emit', event: 'agent-preset/selected', args: [builderId, 'kvvi-builder'] },
      { type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: builderId }] },
      { type: 'emit', event: 'cordis/request-run', args: [{ requestId: 'builder-request',
        agentId: builderId, pluginId: 'builder-plugin' }] },
      { type: 'emit', event: 'cordis/inspect-query', args: [{ requestId: 'builder-inspect',
        agentId: builderId }] },
    ]) {
      expect(projectRuntimeFrame('$events', frame, worker, ownership)).toBeUndefined()
      expect(projectRuntimeFrame('$events', frame, builder, ownership)).toEqual(frame)
    }

    expect(projectRuntimeFrame('$events', { type: 'emit', event: 'cordis/request-run',
      args: [{ requestId: 'worker-request', agentId: workerId, pluginId: 'worker-plugin' }] },
    worker, ownership)).toBeDefined()
    expect(projectRuntimeFrame('$events', { type: 'emit', event: 'cordis/request-run-resolved',
      args: [{ requestId: 'worker-request', outcome: 'approved' }] }, builder, ownership))
      .toBeUndefined()
    expect(projectRuntimeFrame('$events', { type: 'emit', event: 'cordis/dynamic-package',
      args: [{ pluginId: 'worker-plugin' }] }, builder, ownership)).toBeUndefined()
    expect(projectRuntimeFrame('$events', { type: 'emit', event: 'plugin-manager/changed',
      args: [] }, worker, ownership)).toBeUndefined()
  })

  it('binds dynamic Cordis request, inspect, plugin and inventory surfaces to the owner', () => {
    const worker = { ...context, preset: 'kvvi-worker' as const, issuedAt: 1 }
    const builder = { ...worker, gateway: 'BUILDER' as const, preset: 'kvvi-builder' as const }
    const workerId = ownedSessionId(worker, 'worker')
    const builderId = ownedSessionId(builder, 'builder')
    const ownership = new RuntimeOwnership()
    projectRuntimeFrame('$events', { type: 'emit', event: 'cordis/request-run',
      args: [{ requestId: 'builder-request', agentId: builderId, pluginId: 'builder-plugin' }] },
    builder, ownership)
    projectRuntimeFrame('$events', { type: 'emit', event: 'cordis/inspect-query',
      args: [{ requestId: 'builder-inspect', agentId: builderId }] }, builder, ownership)
    projectRuntimeFrame('$events', { type: 'emit', event: 'cordis/request-run',
      args: [{ requestId: 'worker-request', agentId: workerId, pluginId: 'worker-plugin' }] },
    worker, ownership)

    expect(() => authorizeRuntimeRequest('dynamicCordisRunner/resolveRequestRun',
      { args: { requestId: 'builder-request', resolution: { ok: false } } }, worker, ownership))
      .toThrow('KVVI_DYNAMIC_REQUEST_ACCESS_DENIED')
    expect(() => authorizeRuntimeRequest('dynamicCordisRunner/resolveInspectQuery',
      { args: { agentId: builderId, requestId: 'builder-inspect', resolution: { ok: false } } },
      worker, ownership))
      .toThrow('KVVI_SESSION_ACCESS_DENIED')
    expect(() => authorizeRuntimeRequest('dynamicCordisRunner/invoke',
      { args: { pluginId: 'builder-plugin', pluginRunId: 'run', method: 'method', args: {} } },
      worker, ownership))
      .toThrow('KVVI_DYNAMIC_PLUGIN_ACCESS_DENIED')
    expect(() => authorizeRuntimeRequest('dynamicCordisRunner/invoke', { args: {
      args: { pluginId: 'worker-plugin' }, pluginId: 'builder-plugin',
      pluginRunId: 'run', method: 'method',
    } }, worker, ownership)).toThrow('KVVI_DYNAMIC_PLUGIN_ACCESS_DENIED')
    expect(() => authorizeRuntimeRequest('dynamicCordisRunner/invoke', { args: {
      args: { agentId: 'customer-42', sessionId: 'business-record-id' },
      pluginId: 'worker-plugin', pluginRunId: 'run', method: 'method',
    } }, worker, ownership)).not.toThrow()
    expect(() => authorizeRuntimeRequest('dynamicCordisRunner/resolveRequestRun', { args: {
      resolution: { ok: false, requestId: 'worker-request' }, requestId: 'builder-request',
    } }, worker, ownership)).toThrow('KVVI_DYNAMIC_REQUEST_ACCESS_DENIED')
    expect(() => authorizeRuntimeRequest('dynamicCordisRunner/syncInspectManifest',
      { args: { providers: [] } }, worker, ownership))
      .toThrow('KVVI_DYNAMIC_INSPECTION_MANIFEST_DISABLED')
    expect(() => authorizeRuntimeRequest('dynamicCordisRunner/syncInspectManifest',
      { args: { providers: [] } }, builder, ownership)).not.toThrow()
    expect(projectRuntimeFrame('dynamicCordisRunner/inventory', [
      { agentId: workerId, pluginId: 'worker-plugin' },
      { agentId: builderId, pluginId: 'builder-plugin' },
    ], worker, ownership)).toEqual([{ agentId: workerId, pluginId: 'worker-plugin' }])
  })

  it('isolates two real $events WebSocket streams before browser delivery', async () => {
    const ctx = new Context()
    ctx.provide('connection' as never, {
      requestRejection: () => undefined,
      rpc: { intercept: () => () => {} },
    } as never)
    ctx.provide('sessionController', {
      create: async (request: unknown) => request,
      list: async () => ({ items: [] }),
      search: async () => ({ items: [], hasMore: false }),
      control: async function * () {},
    })
    ctx.provide('agentPresets', {
      select: async (_agent: unknown, requested: string) => requested,
      // 路由会收窄预置清单（问题 12），桩里必须有这一个方法 ——
      // 少了它插件在加载时就炸，而不是静默地不收窄。
      remoteExportList: async () => ({ presets: [], authorable: false, modeSelectionEnabled: false }),
    })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService)
    await ctx.plugin(KvviModeRouter, { secret })
    const broadcast = new EventBroadcast()
    const unregister = ctx.typertGateway.registerRemoteEvents(broadcast.source, { home: '/tmp' })
    const builderContext = { ...context, sessionId: 'a0000000-0000-4000-8000-000000000199',
      userId: 'a0000000-0000-4000-8000-000000000003', gateway: 'BUILDER' as const }
    const builder = { ...builderContext, preset: 'kvvi-builder' as const, issuedAt: 1 }
    const builderId = ownedSessionId(builder, 'builder')
    const workerClient = await openEvents(ctx.webServer.port,
      signModeHeaders(context, secret), 'worker-events')
    const builderClient = await openEvents(ctx.webServer.port,
      signModeHeaders(builderContext, secret), 'builder-events')
    try {
      const leaked = { event: 'cordis/request-run', args: [{
        requestId: 'builder-request', agentId: builderId, pluginId: 'builder-plugin',
      }] }
      broadcast.publish(leaked)
      broadcast.publish({ event: 'commands/change', args: [] })
      await vi.waitFor(() => {
        expect(builderClient.frames.some(frame => frame.type === 'item'
          && typeof frame.value === 'object' && frame.value !== null
          && Reflect.get(frame.value, 'event') === 'cordis/request-run')).toBe(true)
        expect(workerClient.frames.some(frame => frame.type === 'item'
          && typeof frame.value === 'object' && frame.value !== null
          && Reflect.get(frame.value, 'event') === 'commands/change')).toBe(true)
      })
      expect(workerClient.frames.some(frame => frame.type === 'item'
        && typeof frame.value === 'object' && frame.value !== null
        && Reflect.get(frame.value, 'event') === 'cordis/request-run')).toBe(false)
      await expect(ctx.waterfall('typert-gateway/upgrade', {
        headers: signModeHeaders(context, secret),
      } as never, new PassThrough(), Buffer.alloc(0), async () => {
        await ctx.serial('typert-gateway/request', 'dynamicCordisRunner/resolveRequestRun', {
          args: { requestId: 'builder-request', resolution: { ok: false } },
        })
      })).rejects.toThrow('KVVI_DYNAMIC_REQUEST_ACCESS_DENIED')

      const builderClosed = once(builderClient.socket, 'close')
      builderClient.socket.terminate()
      await builderClosed
      await vi.waitFor(() => {
        const clients = Reflect.get(ctx.typertGateway, 'remoteEventClients') as Map<unknown, unknown>
        expect(clients.size).toBe(1)
      })
      const settled = Promise.withResolvers<TypertRemoteEventOutcome>()
      const builderAgent = {}
      broadcast.publish({
        event: 'approval/request',
        request: { agent: builderAgent, prompt: 'builder-only' },
        context: { value: ctx, subject: builderAgent as never, agentId: builderId as never },
        resolve: settled.resolve,
        reject: settled.reject,
      })
      await expect(settled.promise).resolves.toEqual({ kind: 'next' })
      expect(workerClient.frames.some(frame => frame.type === 'item'
        && typeof frame.value === 'object' && frame.value !== null
        && Reflect.get(frame.value, 'event') === 'approval/request')).toBe(false)
    } finally {
      workerClient.socket.close()
      builderClient.socket.close()
      await unregister()
      await ctx.fiber.dispose()
    }
  })

  it('clamps the preset roster to the session mode, and turns mode selection off', async () => {
    // 问题 12：`select` 只在点下去之后拦，界面照样把五个模式摆出来。
    // 菜单里的模式清单、设置页的「允许切换 agent 模式」开关与六个预置的完整列表、
    // 以及「新任务默认」那个标记，全都来自这一次 `remoteExportList`。
    const full = {
      presets: [
        { id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'cordis' },
        { id: 'kvvi-builder' }, { id: 'kvvi-worker' },
      ],
      authorable: true,
      modeSelectionEnabled: true,
    }
    const seen: string[] = []
    const build = async (gateway: 'USER' | 'BUILDER') => {
      const ctx = new Context()
      ctx.provide('connection' as never, {} as never)
      ctx.provide('sessionController', {
        create: async (request: Record<string, unknown>) => request,
        list: async () => ({ items: [] }),
        search: async () => ({ items: [], hasMore: false }),
        control: async function * () { yield { type: 'baseline', value: { jobs: {}, projections: {} } } },
      })
      ctx.provide('agentPresets', {
        select: async (_agent: unknown, requested: string) => requested,
        remoteExportList: async () => full,
      })
      await ctx.plugin(KvviModeRouter, { secret })
      const headers = signModeHeaders({ ...context, gateway }, secret)
      const response = { writeHead: () => response, end: () => response }
      await ctx.waterfall('connection/request', { headers } as never, response as never,
        async () => {
          const roster = await ctx.agentPresets.remoteExportList()
          seen.push(roster.presets.map(row => row.id).join(','))
          // 只剩本会话被绑定的那一个 —— 别的模式连名字都不该出现在工位上。
          expect(roster.presets).toHaveLength(1)
          // 模式是登录门绑定的，工位上的会话只有一个可能取值，
          // 所以选择器与那个开关都必须消失。
          expect(roster.modeSelectionEnabled).toBe(false)
        })
      await ctx.fiber.dispose()
    }
    await build('USER')
    await build('BUILDER')
    expect(seen).toEqual(['kvvi-worker', 'kvvi-builder'])
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
      remoteExportList: async () => ({ presets: [], authorable: false, modeSelectionEnabled: false }),
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
        expect(() => ctx.agentPresets.select({} as never, 'kvvi-builder'))
          .toThrow('KVVI_PRESET_LOCKED_TO_SESSION_MODE')
        await expect(ctx.agentPresets.select({} as never, 'kvvi-worker')).resolves.toBe('kvvi-worker')
      })

    await ctx.waterfall('typert-gateway/upgrade', { headers } as never, new PassThrough(),
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

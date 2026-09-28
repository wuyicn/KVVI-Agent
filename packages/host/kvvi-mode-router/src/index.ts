/** KVVI platform-to-runtime identity and mode binding. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export type KvviGateway = 'USER' | 'BUILDER'
export type KvviPreset = 'kvvi-worker' | 'kvvi-builder'

export interface ModeContext {
  readonly sessionId: string
  readonly userId: string
  readonly companyId: string
  readonly gateway: KvviGateway
  readonly preset: KvviPreset
  readonly issuedAt: number
}

interface SignedContext {
  readonly sessionId: string
  readonly userId: string
  readonly companyId: string
  readonly gateway: KvviGateway
}

type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>
export type SessionCreateRequest = Readonly<Record<string, unknown>> & {
  readonly sessionId?: string
  readonly agentPreset?: string
}

interface SessionSummaryLike { readonly sessionId: string }
interface SessionListValueLike { readonly items: readonly SessionSummaryLike[] }
interface SessionSearchValueLike {
  readonly items: readonly SessionSummaryLike[]
  readonly hasMore?: boolean
}
interface SessionControllerLike {
  create(request: SessionCreateRequest): Promise<unknown>
  list(request: unknown, signal: AbortSignal): Promise<SessionListValueLike>
  search(request: unknown, signal: AbortSignal): Promise<SessionSearchValueLike>
  control(signal: AbortSignal): AsyncIterable<unknown>
}

/**
 * 一次会话能看见的预置清单 —— 只取路由器要收窄的那三个字段。
 *
 * 故意不 import `@deepseek-ai/dsh-agent-presets` 的类型：这个包与它的关系是
 * 「结构上对得上」，与 {@link SessionControllerLike} 同一路数，不为一次收窄多一条依赖。
 */
interface AgentPresetRosterLike {
  readonly presets: readonly { readonly id: string }[]
  readonly authorable: boolean
  readonly modeSelectionEnabled: boolean
}

interface AgentPresetsLike {
  select(agent: unknown, requested: string): Promise<string>
  remoteExportList(): Promise<AgentPresetRosterLike>
}

const VERSION = 'v1'
const OWNED_SESSION_VERSION = 'kvvi1'
const MAX_AGE_MS = 60_000

export function presetFor(gateway: string): KvviPreset {
  if (gateway === 'USER') return 'kvvi-worker'
  if (gateway === 'BUILDER') return 'kvvi-builder'
  throw new Error('KVVI_GATEWAY_INVALID')
}

function payload(input: SignedContext & { issuedAt: number }): string {
  return [VERSION, input.sessionId, input.userId, input.companyId, input.gateway,
    String(input.issuedAt)].join('\n')
}

function header(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

export function signModeHeaders(input: SignedContext, secret: string,
  now = Date.now()): Record<string, string> {
  if (secret.length === 0) throw new Error('KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED')
  presetFor(input.gateway)
  const issuedAt = Number(now)
  const signature = createHmac('sha256', secret)
    .update(payload({ ...input, issuedAt })).digest('hex')
  return {
    'x-kvvi-session': input.sessionId,
    'x-kvvi-user': input.userId,
    'x-kvvi-company': input.companyId,
    'x-kvvi-gateway': input.gateway,
    'x-kvvi-issued-at': String(issuedAt),
    'x-kvvi-signature': signature,
  }
}

export function verifyModeHeaders(headers: HeaderBag, secret: string,
  now = Date.now()): ModeContext {
  const sessionId = header(headers, 'x-kvvi-session')
  const userId = header(headers, 'x-kvvi-user')
  const companyId = header(headers, 'x-kvvi-company')
  const gateway = header(headers, 'x-kvvi-gateway')
  const rawIssuedAt = header(headers, 'x-kvvi-issued-at')
  const signature = header(headers, 'x-kvvi-signature')
  if (!sessionId || !userId || !companyId || !gateway || !rawIssuedAt || !signature) {
    throw new Error('KVVI_RUNTIME_CONTEXT_REQUIRED')
  }
  const preset = presetFor(gateway)
  const issuedAt = Number(rawIssuedAt)
  if (!Number.isSafeInteger(issuedAt) || Math.abs(Number(now) - issuedAt) > MAX_AGE_MS) {
    throw new Error('KVVI_RUNTIME_CONTEXT_EXPIRED')
  }
  const expected = createHmac('sha256', secret)
    .update(payload({ sessionId, userId, companyId,
      gateway: gateway as KvviGateway, issuedAt })).digest()
  const actual = Buffer.from(signature, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('KVVI_RUNTIME_CONTEXT_INVALID')
  }
  return { sessionId, userId, companyId, gateway: gateway as KvviGateway, preset, issuedAt }
}

function ownerToken(mode: Pick<ModeContext, 'companyId' | 'userId' | 'gateway'>): string {
  return Buffer.from(JSON.stringify([mode.companyId, mode.userId, mode.gateway]), 'utf8')
    .toString('base64url')
}

export function ownedSessionId(mode: ModeContext, requested: string = randomUUID()): string {
  if (requested.startsWith(`${OWNED_SESSION_VERSION}.`)) {
    assertOwnedSessionId(requested, mode)
    return requested
  }
  return `${OWNED_SESSION_VERSION}.${ownerToken(mode)}.${Buffer.from(requested, 'utf8').toString('base64url')}`
}

export function assertOwnedSessionId(sessionId: string, mode: ModeContext): void {
  const parts = sessionId.split('.')
  if (parts.length !== 3 || parts[0] !== OWNED_SESSION_VERSION
    || parts[1] !== ownerToken(mode) || parts[2] === '') {
    throw new Error('KVVI_SESSION_ACCESS_DENIED')
  }
}

export function enforceCreateRequest(request: SessionCreateRequest,
  mode: ModeContext): SessionCreateRequest {
  return {
    ...request,
    sessionId: ownedSessionId(mode, request.sessionId),
    agentPreset: mode.preset,
  }
}

export function assertPresetAllowed(requested: string, preset: KvviPreset): void {
  if (requested !== preset) throw new Error('KVVI_PRESET_LOCKED_TO_SESSION_MODE')
}

function visitSessionIds(value: unknown, mode: ModeContext, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'sessionId' || key === 'parentSessionId' || key === 'agentId')
      && typeof child === 'string') {
      assertOwnedSessionId(child, mode)
    } else {
      visitSessionIds(child, mode, seen)
    }
  }
}

function directString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function wireArgument(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  return directString((payload as Record<string, unknown>).args, key)
}

function assertDirectWireIdentity(payload: unknown, mode: ModeContext): void {
  for (const key of ['sessionId', 'parentSessionId', 'agentId']) {
    const value = wireArgument(payload, key)
    if (value !== undefined) assertOwnedSessionId(value, mode)
  }
}

/** Bounded ownership cache for correlation and plugin ids whose later calls omit an Agent. */
export class RuntimeOwnership {
  private readonly requests = new Map<string, string>()
  private readonly inspections = new Map<string, string>()
  private readonly plugins = new Map<string, string>()

  private remember(map: Map<string, string>, id: string, mode: ModeContext): void {
    map.delete(id)
    map.set(id, ownerToken(mode))
    if (map.size > 2048) map.delete(map.keys().next().value as string)
  }

  rememberRequest(id: string, mode: ModeContext): void { this.remember(this.requests, id, mode) }
  rememberInspection(id: string, mode: ModeContext): void { this.remember(this.inspections, id, mode) }
  rememberPlugin(id: string, mode: ModeContext): void { this.remember(this.plugins, id, mode) }

  assertRequest(id: string | undefined, mode: ModeContext): void {
    if (id === undefined || this.requests.get(id) !== ownerToken(mode)) {
      throw new Error('KVVI_DYNAMIC_REQUEST_ACCESS_DENIED')
    }
  }

  assertInspection(id: string | undefined, mode: ModeContext): void {
    if (id === undefined || this.inspections.get(id) !== ownerToken(mode)) {
      throw new Error('KVVI_DYNAMIC_INSPECTION_ACCESS_DENIED')
    }
  }

  assertPlugin(id: string | undefined, mode: ModeContext): void {
    if (id === undefined || this.plugins.get(id) !== ownerToken(mode)) {
      throw new Error('KVVI_DYNAMIC_PLUGIN_ACCESS_DENIED')
    }
  }

  ownsRequest(id: string | undefined, mode: ModeContext): boolean {
    return id !== undefined && this.requests.get(id) === ownerToken(mode)
  }

  ownsInspection(id: string | undefined, mode: ModeContext): boolean {
    return id !== undefined && this.inspections.get(id) === ownerToken(mode)
  }

  ownsPlugin(id: string | undefined, mode: ModeContext): boolean {
    return id !== undefined && this.plugins.get(id) === ownerToken(mode)
  }
}

export function authorizeRuntimeRequest(endpoint: string, wirePayload: unknown,
  mode: ModeContext, ownership = new RuntimeOwnership()): void {
  if (endpoint.startsWith('pluginManager/')) {
    throw new Error('KVVI_PLUGIN_MANAGEMENT_DISABLED')
  }
  if (endpoint === 'session/fork') {
    throw new Error('KVVI_SESSION_FORK_DISABLED')
  }
  if (endpoint !== 'session/create') assertDirectWireIdentity(wirePayload, mode)
  if (endpoint.startsWith('session/') && endpoint !== 'session/create') {
    visitSessionIds(wirePayload, mode)
  }
  if (endpoint === 'dynamicCordisRunner/syncInspectManifest' && mode.gateway !== 'BUILDER') {
    throw new Error('KVVI_DYNAMIC_INSPECTION_MANIFEST_DISABLED')
  }
  if (endpoint === 'dynamicCordisRunner/resolveRequestRun') {
    ownership.assertRequest(wireArgument(wirePayload, 'requestId'), mode)
  }
  if (endpoint === 'dynamicCordisRunner/resolveInspectQuery') {
    ownership.assertInspection(wireArgument(wirePayload, 'requestId'), mode)
  }
  if (endpoint.startsWith('dynamicCordisRunner/')) {
    const pluginId = wireArgument(wirePayload, 'pluginId')
    if (pluginId !== undefined) ownership.assertPlugin(pluginId, mode)
  }
}

function filterItems<T extends SessionListValueLike | SessionSearchValueLike>(
  value: T, mode: ModeContext): T {
  return { ...value, items: value.items.filter((item) => {
    try {
      assertOwnedSessionId(item.sessionId, mode)
      return true
    } catch {
      return false
    }
  }) } as T
}

export function filterControlFrame(frame: unknown, mode: ModeContext): unknown | undefined {
  if (typeof frame !== 'object' || frame === null) return undefined
  const value = frame as Record<string, unknown>
  if (value.type === 'baseline' && typeof value.value === 'object' && value.value !== null) {
    const baseline = value.value as Record<string, unknown>
    const filterMap = (map: unknown): Record<string, unknown> => Object.fromEntries(
      Object.entries(typeof map === 'object' && map !== null ? map : {})
        .filter(([sessionId]) => {
          try { assertOwnedSessionId(sessionId, mode); return true } catch { return false }
        }),
    )
    return { ...value, value: {
      ...baseline,
      jobs: filterMap(baseline.jobs),
      projections: filterMap(baseline.projections),
    } }
  }
  if (typeof value.sessionId === 'string') {
    try { assertOwnedSessionId(value.sessionId, mode) } catch { return undefined }
    return frame
  }
  return undefined
}

function eventArgument(frame: Record<string, unknown>): unknown {
  return Array.isArray(frame.args) ? frame.args[0] : undefined
}

function eventSessionId(event: string, first: unknown): string | undefined {
  if (event === 'agent-preset/selected') return typeof first === 'string' ? first : undefined
  if (event.startsWith('api-session/') && typeof first === 'string') return first
  if (typeof first !== 'object' || first === null) return undefined
  const record = first as Record<string, unknown>
  if (event.startsWith('api-session/')) return typeof record.sessionId === 'string'
    ? record.sessionId : undefined
  if (event === 'goal/activation-changed') return typeof record.sessionId === 'string'
    ? record.sessionId : undefined
  if (event === 'cordis/request-run' || event === 'cordis/inspect-query') {
    return typeof record.agentId === 'string' ? record.agentId : undefined
  }
  return undefined
}

/** Remove shared-runtime values and lifecycle events belonging to another KVVI identity. */
export function projectRuntimeFrame(endpoint: string, frame: unknown, mode: ModeContext,
  ownership = new RuntimeOwnership()): unknown | undefined {
  if (endpoint === 'dynamicCordisRunner/inventory') {
    if (!Array.isArray(frame)) return undefined
    return frame.filter(row => typeof row === 'object' && row !== null
      && typeof (row as Record<string, unknown>).agentId === 'string'
      && (() => {
        try {
          assertOwnedSessionId((row as Record<string, unknown>).agentId as string, mode)
          const pluginId = (row as Record<string, unknown>).pluginId
          if (typeof pluginId === 'string') ownership.rememberPlugin(pluginId, mode)
          return true
        } catch { return false }
      })())
  }
  if (typeof frame !== 'object' || frame === null) return frame
  const value = frame as Record<string, unknown>
  if (value.type === 'emit' && typeof value.event === 'string') {
    const event = value.event
    const first = eventArgument(value)
    if (event.startsWith('plugin-manager/')) return undefined
    if (event === 'cordis/request-run-resolved') {
      const requestId = directString(first, 'requestId')
      return ownership.ownsRequest(requestId, mode) ? frame : undefined
    }
    if (event === 'cordis/inspect-query-resolved') {
      const requestId = directString(first, 'requestId')
      return ownership.ownsInspection(requestId, mode) ? frame : undefined
    }
    if (event === 'cordis/dynamic-package' || event === 'cordis/dynamic-retract') {
      const pluginId = directString(first, 'pluginId')
      return ownership.ownsPlugin(pluginId, mode) ? frame : undefined
    }
    const scoped = event.startsWith('api-session/') || event === 'agent-preset/selected'
      || event === 'goal/activation-changed' || event === 'cordis/request-run'
      || event === 'cordis/inspect-query'
    if (scoped) {
      const sessionId = eventSessionId(event, first)
      if (typeof sessionId !== 'string') return undefined
      try { assertOwnedSessionId(sessionId, mode) } catch { return undefined }
      if (typeof first === 'object' && first !== null) {
        const requestId = directString(first, 'requestId')
        const pluginId = directString(first, 'pluginId')
        if (event === 'cordis/request-run' && requestId !== undefined) {
          ownership.rememberRequest(requestId, mode)
        }
        if (event === 'cordis/inspect-query' && requestId !== undefined) {
          ownership.rememberInspection(requestId, mode)
        }
        if (pluginId !== undefined) ownership.rememberPlugin(pluginId, mode)
      }
    }
  }
  if (value.type === 'waterfall' && typeof value.agentId === 'string') {
    try { assertOwnedSessionId(value.agentId, mode) } catch { return undefined }
  }
  return frame
}

async function *filteredControl(source: AsyncIterable<unknown>,
  mode: ModeContext): AsyncGenerator<unknown> {
  for await (const frame of source) {
    const filtered = filterControlFrame(frame, mode)
    if (filtered !== undefined) yield filtered
  }
}

export interface Config { readonly secret: string }

declare module '@deepseek-ai/cordis' {
  interface Context {
    kvviModeRouter: KvviModeRouter
    sessionController: SessionControllerLike
    agentPresets: AgentPresetsLike
  }
  interface Events {
    'connection/request'(request: IncomingMessage, response: ServerResponse,
      next: () => Promise<void>): Promise<void>
    'typert-gateway/upgrade'(request: IncomingMessage, socket: Duplex, head: Buffer,
      next: () => Promise<void>): Promise<void>
    'typert-gateway/request'(endpoint: string, payload: unknown): void | Promise<void>
    'typert-gateway/project'(endpoint: string, value: unknown,
      next: () => Promise<unknown>): Promise<unknown>
  }
}

/** Bind every HTTP and WebSocket Remote request to one signed KVVI identity. */
export class KvviModeRouter extends Service {
  static inject = ['connection', 'sessionController', 'agentPresets']
  static Config: z<Config> = z.object({ secret: z.string().required() })

  private readonly current = new AsyncLocalStorage<ModeContext>()
  private readonly ownership = new RuntimeOwnership()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'kvviModeRouter')
    if (config.secret.length === 0) throw new Error('KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED')

    ctx.on('connection/request', async (request, response, next) => {
      let mode: ModeContext
      try {
        mode = verifyModeHeaders(request.headers as HeaderBag, config.secret)
      } catch (error) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: error instanceof Error
          ? error.message : 'KVVI_RUNTIME_CONTEXT_INVALID' }))
        return
      }
      await this.current.run(mode, next)
    })
    ctx.on('typert-gateway/upgrade', async (request, _socket, _head, next) => {
      const mode = verifyModeHeaders(request.headers as HeaderBag, config.secret)
      const socket = _socket as Duplex & { emit: (...args: unknown[]) => boolean }
      const originalEmit = socket.emit
      // 用箭头函数而不是 `const that = this`：箭头函数继承外层的 `this`，
      // 正是这里要的语义（保留 Router 实例），也不需要别名。
      // `emit` 由 socket 自己调用，所以接收方仍是 socket —— 传给 originalEmit.apply。
      const boundEmit = (...args: unknown[]): boolean =>
        this.current.run(mode, () => originalEmit.apply(socket, args))
      socket.emit = boundEmit
      const restore = (): void => {
        if (socket.emit === boundEmit) socket.emit = originalEmit
      }
      socket.once('close', restore)
      try {
        await this.current.run(mode, next)
      } catch (error) {
        restore()
        throw error
      }
    })
    ctx.on('typert-gateway/request', (endpoint, wirePayload) => {
      authorizeRuntimeRequest(endpoint, wirePayload, this.requireMode(), this.ownership)
    })
    ctx.on('typert-gateway/project', async (endpoint, _value, next) => {
      const mode = this.requireMode()
      return projectRuntimeFrame(endpoint, await next(), mode, this.ownership)
    })

    const sessionController = ctx.sessionController
    const originalCreate = sessionController.create.bind(sessionController)
    const originalList = sessionController.list.bind(sessionController)
    const originalSearch = sessionController.search.bind(sessionController)
    const originalControl = sessionController.control.bind(sessionController)
    sessionController.create = ((request: SessionCreateRequest) =>
      originalCreate(enforceCreateRequest(request, this.requireMode()))) as typeof sessionController.create
    sessionController.list = (async (request, signal) => {
      const mode = this.requireMode()
      return filterItems(await originalList(request, signal), mode)
    }) as typeof sessionController.list
    sessionController.search = (async (request, signal) => {
      const mode = this.requireMode()
      return filterItems(await originalSearch(request, signal), mode)
    }) as typeof sessionController.search
    sessionController.control = ((signal) => {
      const mode = this.requireMode()
      return filteredControl(originalControl(signal), mode)
    }) as typeof sessionController.control

    const agentPresets = ctx.agentPresets
    const originalSelect = agentPresets.select.bind(agentPresets)
    agentPresets.select = ((agent, requested) => {
      assertPresetAllowed(requested, this.requireMode().preset)
      return originalSelect(agent, requested)
    }) as typeof agentPresets.select

    // ── 预置清单也要按会话收窄（问题 12）────────────────────────────────────
    //
    // 上面那个 `select` 只在**点下去之后**拦：界面照样把五个模式摆出来，
    // 员工能点开、能选中，只是建会话时才失败。§2.6 说的是「员工不应看到『模式』」，
    // 而不是「员工看到之后会被拒」—— 看得见就已经不成立了。
    //
    // 菜单里的模式清单、设置页的「允许切换 agent 模式」开关与六个预置的完整列表、
    // 以及「KVVI 搭建引擎」被标成「新任务默认」，全都来自这一次 `remoteExportList`。
    // 模式是登录门绑定的，工位上的会话只有一个可能的取值，所以这里收窄成：
    //   · 只剩本会话被绑定的那一个预置；
    //   · 模式选择关闭 —— 选择器与那个开关都必须消失，否则界面会
    //     把一个不存在的能力摆出来。
    //
    // **收窄的是「看见什么」，不是「能做什么」。** 能做什么由上面那些包装
    // 在真正的操作上判，两件事都要有，缺一个就成了「藏起来当权限」。
    const originalRoster = agentPresets.remoteExportList.bind(agentPresets)
    agentPresets.remoteExportList = (async () => {
      const preset = this.requireMode().preset
      const roster = await originalRoster()
      return {
        ...roster,
        presets: roster.presets.filter(row => row.id === preset),
        modeSelectionEnabled: false,
      }
    }) as typeof agentPresets.remoteExportList

    ctx.effect(() => () => {
      sessionController.create = originalCreate
      sessionController.list = originalList
      sessionController.search = originalSearch
      sessionController.control = originalControl
      agentPresets.select = originalSelect
      agentPresets.remoteExportList = originalRoster
    }, 'kvvi-mode-router: restore wrapped identity and mode surfaces')
  }

  requireMode(): ModeContext {
    const mode = this.current.getStore()
    if (mode === undefined) throw new Error('KVVI_RUNTIME_CONTEXT_REQUIRED')
    return mode
  }
}

export default KvviModeRouter

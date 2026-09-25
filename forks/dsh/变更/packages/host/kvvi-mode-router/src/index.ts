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

interface AgentPresetsLike {
  select(agent: unknown, requested: string): Promise<string>
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
    if ((key === 'sessionId' || key === 'parentSessionId') && typeof child === 'string') {
      assertOwnedSessionId(child, mode)
    } else {
      visitSessionIds(child, mode, seen)
    }
  }
}

export function authorizeRuntimeRequest(endpoint: string, wirePayload: unknown,
  mode: ModeContext): void {
  if (endpoint.startsWith('pluginManager/')) {
    throw new Error('KVVI_PLUGIN_MANAGEMENT_DISABLED')
  }
  if (endpoint === 'session/fork') {
    throw new Error('KVVI_SESSION_FORK_DISABLED')
  }
  if (endpoint !== 'session/create') visitSessionIds(wirePayload, mode)
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
  }
}

/** Bind every HTTP and WebSocket Remote request to one signed KVVI identity. */
export class KvviModeRouter extends Service {
  static inject = ['connection', 'sessionController', 'agentPresets']
  static Config: z<Config> = z.object({ secret: z.string().required() })

  private readonly current = new AsyncLocalStorage<ModeContext>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'kvviModeRouter')
    if (config.secret.length === 0) throw new Error('KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED')

    ctx.on('connection/request', async (request, response, next) => {
      try {
        const mode = verifyModeHeaders(request.headers as HeaderBag, config.secret)
        await this.current.run(mode, next)
      } catch (error) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: error instanceof Error
          ? error.message : 'KVVI_RUNTIME_CONTEXT_INVALID' }))
      }
    })
    ctx.on('typert-gateway/upgrade', async (request, _socket, _head, next) => {
      const mode = verifyModeHeaders(request.headers as HeaderBag, config.secret)
      await this.current.run(mode, next)
    })
    ctx.on('typert-gateway/request', (endpoint, wirePayload) => {
      authorizeRuntimeRequest(endpoint, wirePayload, this.requireMode())
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

    ctx.effect(() => () => {
      sessionController.create = originalCreate
      sessionController.list = originalList
      sessionController.search = originalSearch
      sessionController.control = originalControl
      agentPresets.select = originalSelect
    }, 'kvvi-mode-router: restore wrapped identity and mode surfaces')
  }

  requireMode(): ModeContext {
    const mode = this.current.getStore()
    if (mode === undefined) throw new Error('KVVI_RUNTIME_CONTEXT_REQUIRED')
    return mode
  }
}

export default KvviModeRouter

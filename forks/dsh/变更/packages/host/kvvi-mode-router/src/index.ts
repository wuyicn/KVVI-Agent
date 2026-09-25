/** KVVI platform-to-runtime mode binding. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export type KvviGateway = 'USER' | 'BUILDER'
export type KvviPreset = 'kvvi-worker' | 'kvvi-builder'

export interface ModeContext {
  readonly sessionId: string
  readonly companyId: string
  readonly gateway: KvviGateway
  readonly preset: KvviPreset
  readonly issuedAt: number
}

interface SignedContext {
  readonly sessionId: string
  readonly companyId: string
  readonly gateway: KvviGateway
}

type HeaderBag = Readonly<Record<string, string | readonly string[] | undefined>>
export type SessionCreateRequest = Readonly<Record<string, unknown>> & {
  readonly agentPreset?: string
}

interface SessionControllerLike {
  create(request: SessionCreateRequest): Promise<unknown>
}

interface AgentPresetsLike {
  select(agent: unknown, requested: string): Promise<string>
}

const VERSION = 'v1'
const MAX_AGE_MS = 60_000

export function presetFor(gateway: string): KvviPreset {
  if (gateway === 'USER') return 'kvvi-worker'
  if (gateway === 'BUILDER') return 'kvvi-builder'
  throw new Error('KVVI_GATEWAY_INVALID')
}

function payload(input: SignedContext & { issuedAt: number }): string {
  return [VERSION, input.sessionId, input.companyId, input.gateway,
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
    'x-kvvi-company': input.companyId,
    'x-kvvi-gateway': input.gateway,
    'x-kvvi-issued-at': String(issuedAt),
    'x-kvvi-signature': signature,
  }
}

export function verifyModeHeaders(headers: HeaderBag, secret: string,
  now = Date.now()): ModeContext {
  const sessionId = header(headers, 'x-kvvi-session')
  const companyId = header(headers, 'x-kvvi-company')
  const gateway = header(headers, 'x-kvvi-gateway')
  const rawIssuedAt = header(headers, 'x-kvvi-issued-at')
  const signature = header(headers, 'x-kvvi-signature')
  if (!sessionId || !companyId || !gateway || !rawIssuedAt || !signature) {
    throw new Error('KVVI_RUNTIME_CONTEXT_REQUIRED')
  }
  const preset = presetFor(gateway)
  const issuedAt = Number(rawIssuedAt)
  if (!Number.isSafeInteger(issuedAt) || Math.abs(Number(now) - issuedAt) > MAX_AGE_MS) {
    throw new Error('KVVI_RUNTIME_CONTEXT_EXPIRED')
  }
  const expected = createHmac('sha256', secret)
    .update(payload({ sessionId, companyId, gateway: gateway as KvviGateway, issuedAt })).digest()
  const actual = Buffer.from(signature, 'hex')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('KVVI_RUNTIME_CONTEXT_INVALID')
  }
  return { sessionId, companyId, gateway: gateway as KvviGateway, preset, issuedAt }
}

export function enforceCreateRequest(request: SessionCreateRequest,
  preset: KvviPreset): SessionCreateRequest {
  return { ...request, agentPreset: preset }
}

export function assertPresetAllowed(requested: string, preset: KvviPreset): void {
  if (requested !== preset) throw new Error('KVVI_PRESET_LOCKED_TO_SESSION_MODE')
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
  }
}

/**
 * The request middleware establishes an immutable async-local mode context.
 * The two DSH mutation surfaces are wrapped so request payloads cannot choose
 * or later switch to a preset outside that context.
 */
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

    const sessionController = ctx.sessionController
    const originalCreate = sessionController.create.bind(sessionController)
    sessionController.create = ((request: SessionCreateRequest) =>
      originalCreate(enforceCreateRequest(request, this.requirePreset()))) as typeof sessionController.create

    const agentPresets = ctx.agentPresets
    const originalSelect = agentPresets.select.bind(agentPresets)
    agentPresets.select = ((agent, requested) => {
      assertPresetAllowed(requested, this.requirePreset())
      return originalSelect(agent, requested)
    }) as typeof agentPresets.select

    ctx.effect(() => () => {
      sessionController.create = originalCreate
      agentPresets.select = originalSelect
    }, 'kvvi-mode-router: restore wrapped mode mutation surfaces')
  }

  requirePreset(): KvviPreset {
    const mode = this.current.getStore()
    if (mode === undefined) throw new Error('KVVI_RUNTIME_CONTEXT_REQUIRED')
    return mode.preset
  }
}

export default KvviModeRouter

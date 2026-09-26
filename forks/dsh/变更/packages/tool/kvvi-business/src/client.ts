/**
 * The narrow contract client the business tools call through.
 *
 * ── Why the runtime signs instead of carrying a token ───────────────────────
 *
 * A tool executes inside the DSH runtime, not in a browser. It therefore holds
 * no session cookie and no delegation token — those belong to the browser, and
 * there is no browser at that moment. What the runtime does hold is the signed
 * identity context the platform attached to the request that started this work
 * (`kvviModeRouter.requireMode()`), and the shared secret both processes already
 * have. So this client re-signs that context with the same protocol the platform
 * verifies (`runtime-auth.mjs`), and the platform resolves the session row from
 * it.
 *
 * ⚠️ The client never sends a company, user, or gateway it derived itself. The
 * signature covers exactly the identity the mode router verified; anything else
 * would be this file asserting a tenant.
 *
 * ── Failures are values, not exceptions ─────────────────────────────────────
 *
 * Every call resolves to a tagged result carrying the platform's own stable
 * code. A tool that turned a refusal into a thrown generic Error would erase the
 * one thing an operator can search for — and G8's whole criterion is that the UI
 * and the Agent report the same code for the same refusal.
 */
import { createHmac } from 'node:crypto'
import type { ModeContext } from '@deepseek-ai/dsh-host-kvvi-mode-router'

/**
 * The signed headers the platform verifies on `/api/v1`.
 *
 * Mirrors `runtimeContextHeaders` in the platform (`services/platform/src/runtime-auth.mjs`)
 * and `signModeHeaders` in the mode router. Three implementations of one wire
 * format is one too many; they are kept in step by the shared verification test
 * in `tests/`, and a drift shows up there rather than in production.
 * @param mode - the identity and mode the runtime verified for this session.
 * @param secret - the shared runtime-context secret.
 * @param now - current time, injectable for tests.
 * @returns the header bag.
 */
export function contextHeaders(
  mode: Pick<ModeContext, 'sessionId' | 'userId' | 'companyId' | 'gateway'>,
  secret: string,
  now = Date.now(),
): Record<string, string> {
  if (secret.length === 0) throw new Error('KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED')
  const issuedAt = Number(now)
  const body = ['v1', mode.sessionId, mode.userId, mode.companyId, mode.gateway,
    String(issuedAt)].join('\n')
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  return {
    'x-kvvi-session': mode.sessionId,
    'x-kvvi-user': mode.userId,
    'x-kvvi-company': mode.companyId,
    'x-kvvi-gateway': mode.gateway,
    'x-kvvi-issued-at': String(issuedAt),
    'x-kvvi-signature': signature,
  }
}

/** The platform's stable code for a refusal, or a transport-level one. */
export interface CallFailure {
  readonly ok: false
  readonly code: string
  readonly status: number
  readonly detail?: string
}

/** The platform's answer. */
export type CallResult<T> =
  | { readonly ok: true; readonly value: T }
  | CallFailure

/** Everything one call needs that does not come from the model. */
export interface CallContext {
  readonly mode: Pick<ModeContext, 'sessionId' | 'userId' | 'companyId' | 'gateway'>
  readonly baseUrl: string
  readonly secret: string
  /** Injectable for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/**
 * One JSON request against the KVVI product API.
 *
 * @param call - identity, base URL, and secret.
 * @param method - HTTP method.
 * @param path - path below `/api/v1`.
 * @param body - JSON body, omitted for reads.
 * @returns the parsed value, or the platform's stable refusal.
 */
export async function request<T>(
  call: CallContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<CallResult<T>> {
  const doFetch = call.fetchImpl ?? globalThis.fetch
  const headers: Record<string, string> = contextHeaders(call.mode, call.secret)
  if (body !== undefined) headers['content-type'] = 'application/json'

  let res: Response
  try {
    res = await doFetch(`${call.baseUrl}/api/v1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    return { ok: false, code: 'KVVI_PLATFORM_UNREACHABLE', status: 0, detail: String(error) }
  }

  if (!res.ok) {
    let parsed: unknown
    try {
      parsed = await res.json()
    } catch {
      // A gate or proxy answering 502 in HTML must not read as a well-formed refusal.
      return { ok: false, code: `KVVI_HTTP_${String(res.status)}`, status: res.status }
    }
    const record = (parsed ?? {}) as { error?: unknown; detail?: unknown; missing?: unknown }
    const code = typeof record.error === 'string' ? record.error : `KVVI_HTTP_${String(res.status)}`
    const detail = typeof record.detail === 'string'
      ? record.detail
      : Array.isArray(record.missing) ? record.missing.join(', ') : undefined
    return { ok: false, code, status: res.status, ...(detail === undefined ? {} : { detail }) }
  }

  try {
    return { ok: true, value: await res.json() as T }
  } catch {
    return { ok: false, code: 'KVVI_BAD_RESPONSE', status: res.status }
  }
}

/**
 * Turn a refusal into the message a tool reports to the model.
 *
 * The code leads, because a model that can read `KVVI_ROW_VERSION_CONFLICT` can
 * decide to re-read the record; one that only sees "failed" retries blindly.
 * @param failure - the platform's refusable answer.
 * @returns the model-facing message.
 */
export function refusalMessage(failure: CallFailure): string {
  return failure.detail === undefined
    ? failure.code
    : `${failure.code}: ${failure.detail}`
}

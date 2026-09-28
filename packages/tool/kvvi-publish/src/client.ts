/**
 * The platform client the publish tool calls through.
 *
 * ── 为什么这里**又**有一份签名实现，而不是从 `kvvi-business` 引一份 ────────
 *
 * 两个工具包都跑在 DSH 运行时里，都要向平台出示「运行时签过的身份上下文」。
 * 把它们并成一个包是最省事的，但那会让**搭建者拿到员工的数据工具**
 * （`record_*` / `workflow_*`）—— 搭建者不该有读业务数据的工具，
 * 哪怕平台会按模式拒。所以宁可让这段协议有两个实现。
 *
 * `kvvi-business/src/client.ts` 的注释里已经写了这条判断的代价与对策：
 * 「Three implementations of one wire format is one too many; they are kept in
 * step by the shared verification test in `tests/`」。这里沿用同一对策 ——
 * 两个包各自有 `contextHeaders` 的用例，**同一组向量**，漂移会在那里红。
 *
 * ⚠️ 本文件**不发**任何自己推导出来的公司/用户/网关。签名覆盖的正是模式路由
 * 验过的那个身份；多一分都是这个文件在断言租户。
 *
 * @module @deepseek-ai/dsh-tool-kvvi-publish/client
 */
import { createHmac } from 'node:crypto'
import type { ModeContext } from '@deepseek-ai/dsh-host-kvvi-mode-router'

/**
 * The signed headers the platform verifies on `/api/v1`.
 *
 * Mirrors `runtimeContextHeaders` in the platform (`services/platform/src/runtime-auth.mjs`)
 * and `signModeHeaders` in the mode router.
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
 * One `/api/v1` call.
 *
 * Failures come back as values, not exceptions: the platform's own code is the
 * one thing an operator can search for, and turning it into a thrown generic
 * Error would erase it.
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
      // 网关回了 HTML 的 502 时，不能把它读成一次格式良好的拒绝。
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
 * One line for the model, carrying the platform's code verbatim.
 * @param failure - the refusal.
 * @returns a message naming the code and the platform's own detail, if any.
 */
export function refusalMessage(failure: CallFailure): string {
  return failure.detail === undefined
    ? `${failure.code} (HTTP ${String(failure.status)})`
    : `${failure.code}: ${failure.detail}`
}

/**
 * Session-notice controller: turns "your sign-in ended" from a raw code into
 * something the person can see and act on.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * The platform half is done: `/api/*` answers 401 JSON with a stable code and
 * `relogin: true` instead of redirecting to a login page (a redirect made the
 * caller parse HTML and report `Unexpected token '<'`). The browser half was
 * missing entirely, so four different symptoms all meant the same thing and
 * none of them said it:
 *
 * | Surface | What the person saw |
 * |---|---|
 * | Runtime UI | "reconnecting…", forever, with no reason |
 * | Business panel | `KVVI_INVALID_TOKEN` |
 * | Directory picker | `Unexpected token '<', "<!DOCTYPE "…` |
 * | The prompt just typed | still in the box; sending does nothing |
 *
 * ── Why it wraps `fetch` ────────────────────────────────────────────────
 *
 * The UI reads from three sources — the runtime RPC (`/api/*`), the platform's
 * own endpoints (`/kvvi/*`), and the product API (`/api/v1/*`) — owned by
 * different callers. Wrapping `fetch` at the outermost layer is the only place
 * that sees all three.
 *
 * ⚠️ **The wrapper must be reversible.** A `fetch` wrapper that is installed
 * and never removed stacks on every plugin reload, and a stack of N wrappers
 * processes every response N times. That failure is invisible in the UI and
 * only shows up in counts, so the disposer is returned and always handed to
 * `ctx.effect`.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * Codes that mean "sign in again".
 *
 * ⚠️ These are **not** translated: they are what an operator searches for in a
 * bug report. The sentence next to them comes from the dictionary.
 */
export const RELOGIN_CODES: readonly string[] = [
  'KVVI_SESSION_REQUIRED',
  'KVVI_SESSION_EXPIRED',
  'KVVI_SESSION_ENDED',
  'KVVI_SESSION_UNKNOWN',
  'KVVI_AUTHORIZATION_CHANGED',
  'KVVI_ACCOUNT_NOT_ACTIVE',
  'KVVI_INVALID_TOKEN',
  'KVVI_TOKEN_REQUIRED',
]

/** One sign-in-end notice. */
export interface SessionNotice {
  /** Stable code, shown verbatim so it can be quoted in a report. */
  readonly code: string
  /** The platform's own sentence when it sent one; otherwise the code. */
  readonly message: string
}

/**
 * What the banner renders.
 *
 * ⚠️ **Not `readonly`.** The store's `update` hands this shape to immer as a
 * mutable draft; a `readonly` field there is a compile error, and the compile
 * error is the only thing that would notice if this were a plain mutating
 * object instead of a store.
 */
export interface SessionNoticeState {
  /** The live notice, or `null` when the session is fine. */
  notice: SessionNotice | null
}

const INITIAL: SessionNoticeState = { notice: null }

/**
 * Read one response for a sign-in-end notice.
 *
 * ⚠️ **Never throws.** It runs inside a `fetch` wrapper, so an exception here
 * would take the caller's own request down with it. A 401 body may be the
 * login page's HTML (the historical behaviour) or a truncated JSON document;
 * both must come back as `null`, not as an error.
 *
 * @param status - HTTP status.
 * @param body - The parsed body, or `null` when it was not JSON.
 * @returns The notice, or `null`.
 */
export function noticeOf(status: number, body: unknown): SessionNotice | null {
  if (status !== 401 || body === null || typeof body !== 'object') return null
  const outer = body as Record<string, unknown>
  // Two envelopes: the platform's own `{error, message}` and the runtime's
  // `{result: {error: {code, message, relogin}}}`.
  let code = outer.error
  let message = outer.message
  let relogin = outer.relogin === true
  const result = outer.result
  if (result !== null && typeof result === 'object') {
    const inner = (result as Record<string, unknown>).error
    if (inner !== null && typeof inner === 'object') {
      const shaped = inner as Record<string, unknown>
      code = shaped.code ?? code
      message = shaped.message ?? message
      relogin = relogin || shaped.relogin === true
    }
  }
  if (typeof code !== 'string') return null
  // `relogin` is the platform saying so explicitly; without it the code table
  // decides. A 401 that is neither is some other refusal and stays silent.
  if (!relogin && !RELOGIN_CODES.includes(code)) return null
  return { code, message: typeof message === 'string' && message !== '' ? message : code }
}

/** Owns the notice state and the `fetch` wrapper that feeds it. */
export class SessionNoticeController {
  /** Live notice, read by the banner through the injected hook seat. */
  readonly state: SnapshotStore<SessionNoticeState> = createSnapshotStore(INITIAL)

  private restoreFetch: (() => void) | undefined

  /**
   * Install the `fetch` wrapper. Idempotent: a second call while installed is
   * a no-op, so a re-run of the effect cannot stack wrappers.
   * @returns A disposer that restores the original `fetch`.
   */
  install(): () => void {
    if (this.restoreFetch !== undefined) return this.restoreFetch
    const original = globalThis.fetch
    // The arrow body below binds `this` lexically, so no alias is needed —
    // and an alias is what the lint rule (rightly) rejects.
    const wrapped: typeof fetch = async (input, init) => {
      const response = await original(input, init)
      try {
        // `clone()` so the caller still reads the body it was promised.
        const text = await response.clone().text()
        let parsed: unknown = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        const notice = noticeOf(response.status, parsed)
        if (notice !== null) this.notify(notice)
        else if (response.ok) this.recover()
      } catch {
        // Reading the body failed: not this layer's problem to report.
      }
      return response
    }
    globalThis.fetch = wrapped
    this.restoreFetch = () => { globalThis.fetch = original; this.restoreFetch = undefined }
    return this.restoreFetch
  }

  /**
   * Record a notice. Writing the same code twice does not notify again — the
   * banner is not a log, and re-rendering on every failed request would make
   * a scrolling list of identical lines.
   * @param notice - The notice to show.
   */
  notify(notice: SessionNotice): void {
    const current = this.state.getSnapshot()
    if (current.notice !== null && current.notice.code === notice.code) return
    this.state.update((draft) => { draft.notice = notice })
  }

  /**
   * Clear the notice. Called when any later request succeeds — which covers a
   * sign-in completed in another tab, since that tab's requests are not seen
   * here but the next one on this page is.
   */
  recover(): void {
    if (this.state.getSnapshot().notice === null) return
    this.state.update((draft) => { draft.notice = null })
  }
}

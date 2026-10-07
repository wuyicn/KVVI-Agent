/**
 * The platform's company-branding endpoint, as this browser half reads it.
 *
 * ── Why the platform and not the runtime ────────────────────────────────────
 *
 * The DSH runtime knows a session, not a company. Which name, logo, and
 * tagline the people of this tenant should see is a tenant fact, and the only
 * process that can answer it is the platform. The runtime is asked nothing.
 *
 * ── Same origin, on purpose ─────────────────────────────────────────────────
 *
 * `PLATFORM_BASE` is empty: the read asks whichever origin served this bundle,
 * which in a KVVI deployment is the platform itself. The session cookie it
 * relies on is `HttpOnly` and same-origin, so this code neither holds nor
 * forwards a token.
 *
 * ── Failures stay distinguishable ───────────────────────────────────────────
 *
 * "The platform refused" (a stable code), "the network failed", and "this
 * company has no branding" are three different facts, and this module reports
 * them as three. Collapsing them into one empty answer is what would make an
 * outage look like a tenant that never configured anything — the two need
 * opposite responses from whoever is looking.
 */

/** Origin serving both the client bundle and the product API. Empty = same origin. */
const PLATFORM_BASE = ''

/** Product API prefix, owned by the platform before the runtime's `/api` forwarder. */
const API = `${PLATFORM_BASE}/api/v1`

/**
 * One company's branding, as the platform stores it.
 *
 * Every field is nullable and null means "not set": the platform clears a value
 * with null (or an empty/whitespace write, which it normalizes to null), so no
 * field ever arrives as an empty string.
 */
export interface CompanyBranding {
  readonly name: string | null
  readonly logoUrl: string | null
  readonly tagline: string | null
}

/** Why a branding read produced nothing to render. */
export type BrandingFailure =
  | {
    /** The platform answered and refused: it sent a stable code. */
    readonly kind: 'refused'
    readonly code: string
    readonly detail?: string
  }
  | {
    /** The request never reached a product endpoint. */
    readonly kind: 'unreachable'
    readonly detail: string
  }

/** The outcome of one branding read. */
export type BrandingRead =
  | { readonly status: 'read'; readonly branding: CompanyBranding }
  | { readonly status: 'failed'; readonly failure: BrandingFailure }
  /** The caller withdrew; there is nothing to report and nothing to render. */
  | { readonly status: 'aborted' }

/**
 * Read the calling company's branding.
 *
 * A successful read whose three fields are all null is the "no branding" case
 * and comes back as `read` with nulls — never as a failure.
 * @param signal - aborts the request when its owner goes away.
 * @returns the branding, an unreachable report, or the platform's refusal.
 */
export async function readBranding(signal?: AbortSignal): Promise<BrandingRead> {
  let res: Response
  try {
    res = await fetch(`${API}/company/branding`, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    // An abort is the caller's own doing, not a network fact worth reporting.
    if (signal?.aborted === true) return { status: 'aborted' }
    return { status: 'failed', failure: { kind: 'unreachable', detail: String(error) } }
  }
  if (!res.ok) {
    return { status: 'failed', failure: { kind: 'refused', ...await refusalOf(res) } }
  }
  const branding = brandingOf(await bodyOf(res))
  // A 200 that is not a branding document is not branding. Reporting it as one
  // would let an HTML error page or a proxy's JSON reach the renderer as a
  // brand with no name.
  return branding === null
    ? { status: 'failed', failure: { kind: 'refused', code: 'KVVI_BAD_RESPONSE' } }
    : { status: 'read', branding }
}

/**
 * Read the platform's stable refusal code from one failed response body.
 * @param res - the failed response.
 * @returns the code and its optional detail.
 */
async function refusalOf(res: Response): Promise<{ code: string; detail?: string }> {
  const body = await bodyOf(res)
  if (typeof body !== 'object' || body === null) {
    return { code: `KVVI_HTTP_${String(res.status)}` }
  }
  const record = body as { error?: unknown; detail?: unknown }
  const code = typeof record.error === 'string' ? record.error : `KVVI_HTTP_${String(res.status)}`
  const detail = typeof record.detail === 'string' ? record.detail : undefined
  return detail === undefined ? { code } : { code, detail }
}

/**
 * Parse one response body, tolerating a body that is not JSON at all.
 * @param res - the response to read.
 * @returns the parsed body, or null when it is not JSON.
 */
async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json() as unknown
  } catch {
    // Not JSON is a fact about the answer, and the callers state it (a
    // KVVI_HTTP_<status> code or a bad-response refusal) rather than throwing.
    return null
  }
}

/**
 * Read the three branding values from one parsed body.
 *
 * This is a wire boundary, so each field is read defensively: a missing or
 * non-string field reads as "not set" exactly like an explicit null, and a body
 * that carries no document at all is rejected outright.
 * @param body - the parsed response body.
 * @returns the branding, or null when the body is not a branding document.
 */
function brandingOf(body: unknown): CompanyBranding | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  return {
    name: textOf(record.name),
    logoUrl: textOf(record.logoUrl),
    tagline: textOf(record.tagline),
  }
}

/**
 * One branding field as text, with anything empty read as absent.
 * @param value - the field as the wire carried it.
 * @returns the text, or null when there is none.
 */
function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

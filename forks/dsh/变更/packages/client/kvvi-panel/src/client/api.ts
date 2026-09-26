/**
 * The platform's product API, as this browser half uses it.
 *
 * ── Why the panel talks to the platform instead of the DSH runtime ───────────
 *
 * The runtime knows a session, not a company. Every question this panel asks —
 * which systems exist here, what this employee may read, which fields are
 * masked — is a tenant question, and the platform is the only process that can
 * answer it. The runtime is asked nothing.
 *
 * ── Same origin, on purpose ─────────────────────────────────────────────────
 *
 * `PLATFORM_BASE` is empty: the panel asks whichever origin served this bundle.
 * The KVVI deployment makes the platform the only browser entry, so that origin
 * *is* the platform. A hardcoded port here was the earlier bug — the client's
 * origin and the platform's origin are the same one.
 *
 * ── Failures stay distinguishable ───────────────────────────────────────────
 *
 * Every call resolves to a tagged result rather than throwing. "The platform
 * refused" (a stable code), "the network failed", and "there is nothing" are
 * three different facts, and one shared empty state would report them as one.
 */

/** Origin serving both the client bundle and the product API. Empty = same origin. */
const PLATFORM_BASE = ''

/** Product API prefix, owned by the platform before the runtime's `/api` forwarder. */
const API = `${PLATFORM_BASE}/api/v1`

/**
 * One system the company has published.
 *
 * `systemId` and `assetId` are both present and are not interchangeable:
 * `systemId` names the published release, `assetId` names the schema the
 * records belong to. The API addresses a system by `assetId`.
 */
export interface PublishedSystem {
  readonly systemId: string
  readonly assetId: string
  readonly name: string
  readonly schemaCode: string
  readonly publishedAt: string
}

/** One node of a published `componentsTree`. */
export interface ViewNode {
  readonly id: string
  readonly componentName: string
  readonly props?: Readonly<Record<string, unknown>>
  readonly children?: readonly ViewNode[]
}

/** A published `view-schema` document. */
export interface ViewSpec {
  readonly view_code: string
  readonly name?: string
  readonly view_type: string
  readonly componentsTree?: readonly ViewNode[]
}

/** A published `business-schema` field declaration. */
export interface ModelField {
  readonly field_code: string
  readonly label?: string
  readonly type?: string
  readonly required?: boolean
  readonly type_config?: {
    readonly options?: readonly { readonly code: string; readonly label?: string }[]
  }
}

/** A published `business-schema` document. */
export interface ModelSpec {
  readonly schema_code?: string
  readonly name?: string
  readonly description?: string
  readonly fields?: readonly ModelField[]
}

/** A published `workflow-spec` document, as the projection adds states. */
export interface WorkflowSpec {
  readonly states?: Readonly<Record<string, { readonly label?: string }>>
  readonly transitions?: readonly {
    readonly from_state?: string
    readonly to_state?: string
    readonly code?: string
    readonly label?: string
  }[]
}

/** The compiled runtime projection for one published system. */
export interface RuntimeProjection {
  readonly system: {
    readonly systemId: string
    readonly assetId: string
    readonly name: string
    readonly schemaCode: string
  }
  readonly models: Readonly<Record<string, ModelSpec>>
  readonly views: Readonly<Record<string, ViewSpec>>
  readonly workflows: Readonly<Record<string, WorkflowSpec>>
  readonly digest?: string
}

/** One record row, already filtered by the platform's field visibility. */
export interface RecordRow {
  readonly recordId: string
  readonly state?: string
  readonly recordNo?: string
  readonly rowVersion: number
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * One record together with the per-field visibility the platform decided.
 *
 * Flat, not nested: this is the response body as the platform writes it, and
 * re-nesting it here would invent a structure no endpoint serves.
 */
export interface RecordView extends RecordRow {
  readonly fieldVisibility: Readonly<Record<string, string>>
}

/** A record list together with the per-field visibility the platform decided. */
export interface RecordPage {
  readonly items: readonly RecordRow[]
  readonly fieldVisibility: Readonly<Record<string, string>>
}

/**
 * The outcome of one API call.
 *
 * `code` is the platform's own stable error code when it sent one, so a caller
 * can branch on `KVVI_ROW_VERSION_CONFLICT` without parsing a sentence.
 */
export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false
    readonly code: string
    readonly status: number
    readonly detail?: string
    /**
     * Present on `KVVI_ROW_VERSION_CONFLICT`: the version the record is at now.
     * Shown to the employee so they know how far behind their copy is.
     */
    readonly currentRowVersion?: number
  }

/**
 * Read the platform's error code from one failed response body.
 *
 * A body that is not JSON, or carries no `error`, is reported as
 * `KVVI_HTTP_<status>` rather than as success: a proxy or gate answering 502 in
 * HTML must not read as a well-formed refusal.
 * @param res - the failed response.
 * @returns the stable code and optional detail.
 */
async function errorOf(
  res: Response,
): Promise<{ code: string; detail?: string; currentRowVersion?: number }> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { code: `KVVI_HTTP_${String(res.status)}` }
  }
  const record = (body ?? {}) as {
    error?: unknown
    detail?: unknown
    missing?: unknown
    fields?: unknown
    currentRowVersion?: unknown
  }
  const code = typeof record.error === 'string' ? record.error : `KVVI_HTTP_${String(res.status)}`
  // A projection refusal names what is missing — the absent contracts, the
  // unbound fields, or the dangling states. It reaches the employee verbatim:
  // "the system cannot run" without "and this is what would fix it" is a dead end.
  const extra = record.missing ?? record.fields ?? record.states
  const detail = typeof record.detail === 'string'
    ? record.detail
    : Array.isArray(extra) ? extra.join(', ') : undefined
  return {
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(typeof record.currentRowVersion === 'number'
      ? { currentRowVersion: record.currentRowVersion } : {}),
  }
}

/**
 * One JSON request against the product API.
 *
 * Cookies are sent by the browser's default same-origin policy: the session
 * token is an `HttpOnly` cookie set by the platform's login gate, so this code
 * neither holds nor forwards it.
 * @param method - HTTP method.
 * @param path - path below `/api/v1`.
 * @param body - JSON body, omitted for reads.
 * @param signal - aborts the request when its caller goes away.
 * @returns the parsed value, or a stable failure.
 */
async function request<T>(
  method: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, code: 'KVVI_ABORTED', status: 0 }
    return { ok: false, code: 'KVVI_UNREACHABLE', status: 0, detail: String(error) }
  }
  if (!res.ok) {
    return { ok: false, status: res.status, ...await errorOf(res) }
  }
  if (res.status === 204) return { ok: true, value: undefined as T }
  try {
    return { ok: true, value: await res.json() as T }
  } catch {
    // A 200 whose body is not JSON is not a value: reporting it as one would
    // let an HTML error page reach the renderer as if it were a contract.
    return { ok: false, code: 'KVVI_BAD_RESPONSE', status: res.status }
  }
}

/**
 * List the systems this company has published.
 * @param signal - aborts the request.
 * @returns the systems, newest first.
 */
export function listSystems(signal?: AbortSignal): Promise<ApiResult<{ items: PublishedSystem[] }>> {
  return request('GET', '/systems', undefined, signal)
}

/**
 * Compile one published system into its runtime projection.
 * @param assetId - the system to load.
 * @param signal - aborts the request.
 * @returns the projection, or a contract error such as `KVVI_RUNTIME_CONTRACT_INCOMPLETE`.
 */
export function loadRuntime(assetId: string, signal?: AbortSignal): Promise<ApiResult<RuntimeProjection>> {
  return request('GET', `/systems/${encodeURIComponent(assetId)}/runtime`, undefined, signal)
}

/**
 * List this system's records.
 * @param assetId - the system.
 * @param signal - aborts the request.
 * @returns the rows the session may read, with visibility already applied.
 */
export function listRecords(assetId: string, signal?: AbortSignal): Promise<ApiResult<RecordPage>> {
  return request('GET', `/systems/${encodeURIComponent(assetId)}/records`, undefined, signal)
}

/**
 * Read one record.
 * @param assetId - the system.
 * @param recordId - the record.
 * @param signal - aborts the request.
 * @returns the record with visibility, or `KVVI_NO_SUCH_RECORD`.
 */
export function getRecord(
  assetId: string,
  recordId: string,
  signal?: AbortSignal,
): Promise<ApiResult<RecordView>> {
  return request('GET', `/systems/${encodeURIComponent(assetId)}/records/${encodeURIComponent(recordId)}`, undefined, signal)
}

/**
 * Create a record.
 * @param assetId - the system.
 * @param data - the field values that were actually rendered.
 * @returns the new record's identity.
 */
export function createRecord(
  assetId: string,
  data: Readonly<Record<string, string>>,
): Promise<ApiResult<{ recordId: string; rowVersion: number; recordNo?: string }>> {
  return request('POST', `/systems/${encodeURIComponent(assetId)}/records`, { data })
}

/**
 * Update a record.
 *
 * `rowVersion` is required, not optional: without it the write degrades to
 * last-writer-wins, which silently drops the other person's edit.
 * @param assetId - the system.
 * @param recordId - the record.
 * @param data - the changed fields.
 * @param rowVersion - the version this edit was made against.
 * @returns the new version, or `KVVI_ROW_VERSION_CONFLICT`.
 */
export function updateRecord(
  assetId: string,
  recordId: string,
  data: Readonly<Record<string, string>>,
  rowVersion: number,
): Promise<ApiResult<{ recordId: string; rowVersion: number }>> {
  return request('PATCH',
    `/systems/${encodeURIComponent(assetId)}/records/${encodeURIComponent(recordId)}`,
    { data, rowVersion })
}

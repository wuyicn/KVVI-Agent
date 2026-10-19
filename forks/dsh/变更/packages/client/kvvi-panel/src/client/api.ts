/**
 * The platform's product API, as this browser half uses it.
 *
 * ── Why the panel talks to the platform instead of the DSH runtime ───────────
 *
 * The runtime knows a session, not a company. Every question this panel asks —
 * which systems exist here, what this employee may read, which fields are
 * masked — is a tenant question, and the platform is the only process that can
 * answer it. The runtime serves only the separately authenticated managed-draft preview.
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
  readonly nullable?: boolean
  /**
   * `MUTABLE` / `CREATE_ONLY` / `SYSTEM`. A `CREATE_ONLY` field can be set when
   * the record is created but not changed afterwards, so the detail editor
   * leaves it out of an update payload rather than sending it back unchanged.
   */
  readonly write_policy?: string
  readonly type_config?: {
    readonly options?: readonly { readonly code: string; readonly label?: string; readonly enabled?: boolean }[]
    readonly precision?: number
    readonly scale?: number
    readonly currency_mode?: string
    readonly currency?: string
  }
}

/** A published `business-schema` document. */
export interface ModelSpec {
  readonly schema_code?: string
  readonly name?: string
  readonly description?: string
  readonly fields?: readonly ModelField[]
}

/**
 * A published `workflow-spec` document, as the projection returns it.
 *
 * `states` keeps the contract's **array** shape (the workflow runtime reads it
 * that way); the projection's derived code-to-state lookup is `stateLabels`.
 * Two shapes for one fact is how the two readers drift apart — the client reads
 * the derived one and never re-shapes the contract's own.
 */
export interface WorkflowSpec {
  readonly states?: readonly { readonly state_code?: string; readonly label?: string }[]
  readonly stateLabels?: Readonly<Record<string, { readonly label?: string }>>
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
    /** Server result is uncertain; callers must retain their original key. */
    readonly idempotencyKey?: string
    readonly retryWithSameKey?: boolean
    /**
     * Present on a field-level refusal such as `KVVI_BRANDING_INVALID`: which
     * field the platform rejected, and its own reason. Shown verbatim — a code
     * without the field it names is a dead end for whoever has to fix it.
     */
    readonly problems?: readonly ApiProblem[]
  }

/** One field a write was refused on, as the platform names it. */
export interface ApiProblem {
  /** The field the platform rejected. */
  readonly field: string
  /** The platform's own reason, shown verbatim. */
  readonly reason: string
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
): Promise<{
  code: string
  detail?: string
  currentRowVersion?: number
  idempotencyKey?: string
  retryWithSameKey?: boolean
  problems?: readonly ApiProblem[]
}> {
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
    states?: unknown
    currentRowVersion?: unknown
    idempotencyKey?: unknown
    retryWithSameKey?: unknown
    problems?: unknown
  }
  const code = typeof record.error === 'string' ? record.error : `KVVI_HTTP_${String(res.status)}`
  // A projection refusal names what is missing — the absent contracts, the
  // unbound fields, or the dangling states. It reaches the employee verbatim:
  // "the system cannot run" without "and this is what would fix it" is a dead end.
  const extra = record.missing ?? record.fields ?? record.states
  const detail = typeof record.detail === 'string'
    ? record.detail
    : Array.isArray(extra) ? extra.join(', ') : undefined
  const problems = problemsOf(record.problems)
  return {
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(typeof record.currentRowVersion === 'number'
      ? { currentRowVersion: record.currentRowVersion } : {}),
    ...(typeof record.idempotencyKey === 'string' ? { idempotencyKey: record.idempotencyKey } : {}),
    ...(typeof record.retryWithSameKey === 'boolean' ? { retryWithSameKey: record.retryWithSameKey } : {}),
    ...(problems === undefined ? {} : { problems }),
  }
}

/**
 * Read a field-level refusal list from one failure body.
 *
 * A malformed entry is dropped rather than reported: this list exists to say
 * *which* field to fix, and an entry that names no field cannot say that.
 * @param value - the `problems` member of a failure body.
 * @returns the problems, or undefined when the body carried none.
 */
function problemsOf(value: unknown): readonly ApiProblem[] | undefined {
  const problems = (Array.isArray(value) ? value : []).flatMap((entry): ApiProblem[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as { field?: unknown; reason?: unknown }
    if (typeof record.field !== 'string' || typeof record.reason !== 'string') return []
    return [{ field: record.field, reason: record.reason }]
  })
  return problems.length === 0 ? undefined : problems
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
export async function request<T>(
  method: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
  base = API,
  headers: Record<string, string> = {},
): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
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

/** Actual entrance identity; builder actions are never inferred from a role switch. */
export function readEntrance(signal?: AbortSignal): Promise<ApiResult<{
  companyId: string
  userId: string
  sessionId: string
  gateway: 'BUILDER' | 'USER'
  allowedGateways?: readonly ('BUILDER' | 'USER')[]
}>> {
  return request('GET', '/auth/session', undefined, signal, PLATFORM_BASE)
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
  data: Readonly<Record<string, unknown>>,
  idempotencyKey?: string,
): Promise<ApiResult<{ recordId: string; rowVersion: number; recordNo?: string; operationId?: string; auditPending?: boolean }>> {
  return recordWrite('POST', `/systems/${encodeURIComponent(assetId)}/records`, { data }, idempotencyKey)
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
  data: Readonly<Record<string, unknown>>,
  rowVersion: number,
  idempotencyKey?: string,
): Promise<ApiResult<{ recordId: string; rowVersion: number; operationId?: string; auditPending?: boolean }>> {
  return recordWrite('PATCH',
    `/systems/${encodeURIComponent(assetId)}/records/${encodeURIComponent(recordId)}`,
    { data, rowVersion }, idempotencyKey)
}

function recordWrite<T>(method: string, path: string, body: unknown, key: string | undefined, signal?: AbortSignal): Promise<ApiResult<T>> {
  // Reject unusable keys before fetch rather than letting an empty header turn
  // into a new server-generated operation identity.
  if (key !== undefined) {
    try {
      if (typeof key !== 'string' || /[\r\n]/u.test(key)) throw new Error('invalid header')
      key = key.trim() // Same canonical identity as the platform's header reader.
      if (!key || new TextEncoder().encode(key).byteLength > 256) throw new Error('invalid key')
      new Headers({ 'idempotency-key': key }) // Browser header encoding/control rules.
    } catch {
      return Promise.resolve({ ok: false, status: 400, code: 'KVVI_OPERATION_KEY_INVALID' })
    }
  }
  return request(method, path, body, signal, API, key === undefined ? {} : { 'idempotency-key': key })
}

export interface RecordWriteTarget { readonly assetId: string; readonly recordId?: string }
export interface RecordWriteInput { readonly data: Readonly<Record<string, unknown>>; readonly rowVersion?: number }
export interface RecordWriteResult { readonly recordId: string; readonly rowVersion: number; readonly recordNo?: string }
export type RecordWriteIntent = (
  | { readonly state: 'EMPTY' }
  | { readonly state: 'PREPARED'; readonly idempotencyKey: string; readonly resultRestricted?: true }
  | { readonly state: 'COMMITTED'; readonly idempotencyKey: string; readonly resultRestricted: true }
  | { readonly state: 'COMMITTED'; readonly idempotencyKey: string; readonly operationId: string;
    readonly statusCode: number; readonly result: RecordWriteResult; readonly auditPending: boolean }
  | { readonly state: 'CANCELED' | 'ACKNOWLEDGED'; readonly idempotencyKey: string }
) & { readonly intentAuditPending?: boolean }

function intentKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\r\n]/u.test(value)
    || new TextEncoder().encode(value).byteLength > 256) return false
  try { new Headers({ 'idempotency-key': value }); return true } catch { return false }
}
const intentObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validate the control protocol before a UI may clear or resume any operation. */
async function intentRequest(target: RecordWriteTarget, method: string, suffix: string, body: unknown,
  states: readonly string[], key?: string, signal?: AbortSignal): Promise<ApiResult<RecordWriteIntent>> {
  if (suffix !== '' && (typeof key !== 'string' || !intentKey(key.trim()))) {
    return { ok: false, status: 400, code: 'KVVI_OPERATION_KEY_INVALID' }
  }
  key = key?.trim()
  const path = `/systems/${encodeURIComponent(target.assetId)}`
    + (target.recordId === undefined ? '' : `/records/${encodeURIComponent(target.recordId)}`) + '/write-intent' + suffix
  const response = await recordWrite<unknown>(method, path, body, key, signal)
  if (!response.ok) return key === undefined ? response : { ...response, idempotencyKey: key }
  const value = response.value
  const bad = (): ApiResult<RecordWriteIntent> => ({ ok: false, status: 200, code: 'KVVI_BAD_RESPONSE',
    ...(key === undefined ? {} : { idempotencyKey: key, retryWithSameKey: true }) })
  if (!intentObject(value) || typeof value.state !== 'string' || !states.includes(value.state)
    || (value.intentAuditPending !== undefined && typeof value.intentAuditPending !== 'boolean')) return bad()
  const audit = value.intentAuditPending === undefined ? {} : { intentAuditPending: value.intentAuditPending as boolean }
  const hasReceipt = ['result', 'operationId', 'statusCode', 'auditPending'].some(field => value[field] !== undefined)
  if (value.state !== 'COMMITTED' && hasReceipt) return bad()
  if (['EMPTY', 'CANCELED', 'ACKNOWLEDGED'].includes(value.state) && value.resultRestricted !== undefined) return bad()
  if (value.state === 'EMPTY' && value.idempotencyKey !== undefined) return bad()
  if (value.state === 'EMPTY') return { ok: true, value: { state: 'EMPTY', ...audit } }
  if (!intentKey(value.idempotencyKey) || (key !== undefined && value.idempotencyKey !== key)) return bad()
  const common = { idempotencyKey: value.idempotencyKey, ...audit }
  if (value.state === 'CANCELED' || value.state === 'ACKNOWLEDGED') return { ok: true, value: { state: value.state, ...common } }
  if (value.resultRestricted === true) {
    if (hasReceipt) return bad()
    return { ok: true, value: { state: value.state as 'PREPARED' | 'COMMITTED', resultRestricted: true, ...common } }
  }
  if (value.resultRestricted !== undefined) return bad()
  if (value.state === 'PREPARED') return { ok: true, value: { state: 'PREPARED', ...common } }
  if (!intentObject(value.result) || typeof value.result.recordId !== 'string' || !value.result.recordId
    || !Number.isSafeInteger(value.result.rowVersion) || (value.result.rowVersion as number) < 1
    || (value.result.recordNo !== undefined && typeof value.result.recordNo !== 'string')
    || typeof value.operationId !== 'string' || !value.operationId || value.statusCode !== (target.recordId === undefined ? 201 : 200)
    || typeof value.auditPending !== 'boolean') return bad()
  if (target.recordId !== undefined && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(target.recordId)
    && value.result.recordId.toLowerCase() !== target.recordId.toLowerCase()) return bad()
  return { ok: true, value: { state: 'COMMITTED', ...common, operationId: value.operationId,
    statusCode: value.statusCode as number, auditPending: value.auditPending,
    result: { recordId: value.result.recordId, rowVersion: value.result.rowVersion as number,
      ...(value.result.recordNo === undefined ? {} : { recordNo: value.result.recordNo as string }) } } }
}

export function getRecordWriteIntent(target: RecordWriteTarget, signal?: AbortSignal): Promise<ApiResult<RecordWriteIntent>> {
  return intentRequest(target, 'GET', '', undefined, ['EMPTY', 'PREPARED', 'COMMITTED'], undefined, signal)
}
export function prepareRecordWriteIntent(target: RecordWriteTarget, input: RecordWriteInput): Promise<ApiResult<RecordWriteIntent>> {
  return intentRequest(target, 'POST', '', input, ['PREPARED', 'COMMITTED'])
}
export function cancelRecordWriteIntent(target: RecordWriteTarget, key: string): Promise<ApiResult<RecordWriteIntent>> {
  return intentRequest(target, 'POST', '/cancel', {}, ['CANCELED', 'COMMITTED'], key)
}
export function acknowledgeRecordWriteIntent(target: RecordWriteTarget, key: string): Promise<ApiResult<RecordWriteIntent>> {
  return intentRequest(target, 'POST', '/acknowledge', {}, ['ACKNOWLEDGED'], key)
}

// ── 管理 API（阶段十）─────────────────────────────────────────────────────
//
// 判定全在服务端。这里的函数不含任何「我是不是管理员」的判断 ——
// 客户端判一次会让「界面隐藏了按钮」看起来像权限，而那改一个请求就绕过去了。

/** 本公司的一个成员。 */
export interface Member {
  readonly userId: string
  readonly login: string
  readonly status: string
  readonly deptId: string | null
  readonly deptName: string | null
  readonly shopId: string | null
  readonly roleCodes: readonly string[]
  readonly builder: boolean
  readonly platformRole: string | null
}

/** 一条策略：一次授权动作在一个维度上的那个面。 */
export interface Policy {
  readonly dimension: string
  readonly resourceCode: string
  readonly actions: readonly string[]
  readonly dataScopes: readonly string[]
  readonly fieldVisibility: string | null
}

/** 本公司的一个角色。 */
export interface Role {
  readonly roleCode: string
  readonly name: string
  readonly memberCount: number
  /** 平台保留角色（`owner`/`admin`）不在这里配置。 */
  readonly reserved: boolean
  readonly policies: readonly Policy[]
}

/** 一个部门。 */
export interface Department {
  readonly deptId: string
  readonly parentId: string | null
  readonly name: string
}

/**
 * 调用者能做什么。
 *
 * ⚠️ 这是给界面决定**显示什么**用的，不是权限判定：每个接口各自再判一次。
 * 把它当权限用的实现，会在有人直接发请求时暴露。
 */
export interface AdminCapabilities {
  readonly role: string | null
  readonly canManageMembers: boolean
  readonly canManageRoles: boolean
  readonly canManagePlatformRoles: boolean
  readonly canManageBuilder: boolean
  readonly dimensions: readonly string[]
  readonly dataScopes: readonly string[]
  readonly fieldVisibilities: readonly string[]
}

/** 读调用者的管理能力。 */
export function adminCapabilities(signal?: AbortSignal): Promise<ApiResult<AdminCapabilities>> {
  return request('GET', '/admin/capabilities', undefined, signal)
}

/** 列本公司成员。 */
export function listMembers(signal?: AbortSignal): Promise<ApiResult<{ items: Member[] }>> {
  return request('GET', '/admin/members', undefined, signal)
}

/** 建账号并加入本公司。 */
export function createMember(
  input: { login: string; password: string; deptId?: string },
): Promise<ApiResult<{ userId: string; login: string }>> {
  return request('POST', '/admin/members', input)
}

/** 停用账号（其全部会话立刻结束）。 */
export function suspendMember(userId: string): Promise<ApiResult<{ endedSessions: number }>> {
  return request('POST', `/admin/members/${encodeURIComponent(userId)}/suspend`, {})
}

/** 恢复账号（需要重新登录）。 */
export function reactivateMember(userId: string): Promise<ApiResult<{ userId: string }>> {
  return request('POST', `/admin/members/${encodeURIComponent(userId)}/reactivate`, {})
}

/** 授予或收回搭建模式。**仅所有者**。 */
export function setBuilderAccess(
  userId: string,
  grant: boolean,
): Promise<ApiResult<{ builder: boolean; changed?: boolean; ended?: number }>> {
  return request(grant ? 'POST' : 'DELETE',
    `/admin/members/${encodeURIComponent(userId)}/builder`, grant ? {} : undefined)
}

/** 授予或收回平台保留角色。**仅所有者**。 */
export function setPlatformRole(
  userId: string,
  roleCode: string,
  grant: boolean,
): Promise<ApiResult<{ roleCode: string; endedSessions?: number }>> {
  return request(grant ? 'POST' : 'DELETE',
    `/admin/members/${encodeURIComponent(userId)}/platform-role/${encodeURIComponent(roleCode)}`,
    grant ? {} : undefined)
}

/** 列本公司角色。 */
export function listRoles(signal?: AbortSignal): Promise<ApiResult<{ items: Role[] }>> {
  return request('GET', '/admin/roles', undefined, signal)
}

/** 建业务角色。 */
export function createRole(
  input: { roleCode: string; name: string },
): Promise<ApiResult<{ roleCode: string }>> {
  return request('POST', '/admin/roles', input)
}

/** **整体替换**一个角色的策略。 */
export function replacePolicies(
  roleCode: string,
  policies: readonly Policy[],
): Promise<ApiResult<{ roleCode: string; count: number }>> {
  return request('PUT', `/admin/roles/${encodeURIComponent(roleCode)}/policies`, { policies })
}

/** 列本公司部门。 */
export function listDepartments(signal?: AbortSignal): Promise<ApiResult<{ items: Department[] }>> {
  return request('GET', '/admin/departments', undefined, signal)
}

// ── 公司品牌 ─────────────────────────────────────────────────────────────
//
// 读是**任何有效会话**都能做的：员工界面要显示本公司的牌子，所以读的权限
// 不能是所有者。写只有所有者能做，判定在服务端。

/** 本公司的品牌：名称、标志地址、标语。未设置时为 null。 */
export interface CompanyBranding {
  readonly name: string | null
  readonly logoUrl: string | null
  readonly tagline: string | null
}

/**
 * 一次品牌改动的请求体。
 *
 * ⚠️ **没给的键不动**：`{ name: 'X' }` 只改名称，另外两个字段保持原样。
 * 反过来，传 `{ name: 'X', logoUrl: null, tagline: null }` 会把标志和标语
 * **清掉** —— 平台会照做并报成功，因为请求本身是合法的。所以调用方必须
 * 只发真正改动过的键（见 `brandingPatch`）。
 */
export interface BrandingPatch {
  readonly name?: string | null
  readonly logoUrl?: string | null
  readonly tagline?: string | null
}

/**
 * 读本公司的品牌。
 * @param signal - aborts the request.
 * @returns 三个值（未设置为 null），或平台的拒绝码。
 */
export function readCompanyBranding(signal?: AbortSignal): Promise<ApiResult<CompanyBranding>> {
  return request('GET', '/company/branding', undefined, signal)
}

/**
 * 改本公司的品牌。**仅所有者**。
 *
 * 校验失败是 `KVVI_BRANDING_INVALID` 加 `problems[]`：哪个字段、为什么。
 * 那两个值原样显示，不翻译 —— 它们就是修的人要看的东西。
 * @param patch - 只含改动过的键。
 * @returns 改完之后的三个值。
 */
export function writeCompanyBranding(patch: BrandingPatch): Promise<ApiResult<CompanyBranding>> {
  return request('PUT', '/company/branding', patch)
}


/** One publish draft, as the platform lists it. */
export interface PublishDraft {
  /** The draft the approve and publish calls address. */
  readonly draftId: string
  /** `AWAITING_APPROVAL` / `APPROVED` / `REJECTED` / `PUBLISHED`. */
  readonly status: string
  /** Digest of the change; the approver has to state it back. */
  readonly change_digest: string
  /** Login of whoever submitted it. */
  readonly proposer: string
  readonly created_at: string
  readonly approved_by: string | null
  readonly published_at: string | null
}

/** One face of the diff report (PRD §9.6.6). */
export interface PublishDiffCounts {
  readonly added: number
  readonly removed: number
  readonly changed: number
}

/** A draft's detail: the diff an approver has to read before deciding. */
export interface PublishDraftDetail {
  readonly draft_id: string
  readonly status: string
  readonly change_digest: string
  readonly diff_report: {
    readonly counts: PublishDiffCounts
    readonly faces: readonly string[]
  }
  readonly approval_opinion: string | null
  readonly published_at: string | null
}

/**
 * List this company's recent publish drafts.
 *
 * The panel can only ever **approve and publish**: submitting needs the
 * contract files, which live in the builder's workspace and not in a browser.
 * That split is the point — §9.6.1 forbids self-approval, so the person who
 * built cannot be the person who approves, and the two do not share a surface.
 * @param signal - aborts the request.
 * @returns the drafts, newest first.
 */
export function listDrafts(signal?: AbortSignal): Promise<ApiResult<{ items: PublishDraft[] }>> {
  return request('GET', '/publish/drafts', undefined, signal)
}

/**
 * Read one draft's diff report. **An approver must see what they approve.**
 * @param draftId - the draft.
 * @param signal - aborts the request.
 * @returns the draft detail.
 */
export function getDraft(draftId: string, signal?: AbortSignal): Promise<ApiResult<PublishDraftDetail>> {
  return request('GET', `/publish/drafts/${encodeURIComponent(draftId)}`, undefined, signal)
}

/**
 * Approve or reject a draft.
 *
 * `changeDigest` is required and must match: it is how the approver says
 * *which* content they are approving, rather than "a draft that looked like
 * this". A mismatch is refused by the platform.
 * @param draftId - the draft.
 * @param changeDigest - the digest the approver read.
 * @param decision - `APPROVE` or `REJECT`.
 * @returns the platform's verdict.
 */
export function decideDraft(
  draftId: string, changeDigest: string, decision: 'APPROVE' | 'REJECT' = 'APPROVE',
): Promise<ApiResult<{ ok: boolean; status: string }>> {
  return request('POST', `/publish/drafts/${encodeURIComponent(draftId)}/approve`,
    { decision, changeDigest })
}

/**
 * Publish an approved draft.
 *
 * No content travels with this call: the platform publishes **what was stored
 * when the draft was submitted**, so what is approved and what goes live are
 * the same bytes by construction.
 * @param draftId - the draft.
 * @returns the publication result.
 */
export function publishDraft(draftId: string): Promise<ApiResult<{ status: string }>> {
  return request('POST', `/publish/drafts/${encodeURIComponent(draftId)}/publish`, {})
}

/** Read only the platform-authorized declarations for a new business form. */
export interface AuthorizedField extends ModelField {
  readonly visibility?: string
  readonly options?: { code: string; label?: string }[]
}
export async function readFormFields(assetId: string, signal?: AbortSignal): Promise<ApiResult<{ fields: AuthorizedField[] }>> {
  const result = await request<{ fields: AuthorizedField[] }>('GET', `/systems/${encodeURIComponent(assetId)}/fields`, undefined, signal)
  if (!result.ok) return result
  const fields = result.value?.fields
  if (!Array.isArray(fields) || fields.some(field => !field || typeof field.field_code !== 'string'
    || !['VISIBLE', 'READONLY', 'MASKED'].includes(field.visibility ?? '')
    || (field.options !== undefined && (!Array.isArray(field.options) || field.options.some(option => !option || typeof option.code !== 'string'))))
    || new Set(fields.map(field => field.field_code)).size !== fields.length) {
    return { ok: false, status: 502, code: 'KVVI_BAD_RESPONSE' }
  }
  return result
}

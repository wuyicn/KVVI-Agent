import type { CredentialKind, CredentialSummary, WorkflowNodeData } from './model.js'
import { renderResultJsonTemplate, renderResultTemplate } from './resultExpression.js'

export type ConnectorFieldType = 'text' | 'textarea' | 'json' | 'number' | 'select' | 'boolean'
export type ConnectorFieldOption = { value: string; label: string }
export type ConnectorDynamicOptionsDefinition = {
  dependsOn?: string[]
  build: (context: ConnectorBuildContext) => ConnectorRequest
  extract: (value: unknown) => ConnectorFieldOption[]
}
export type ConnectorFieldDefinition = {
  id: string
  label: string
  type: ConnectorFieldType
  required?: boolean
  placeholder?: string
  description?: string
  defaultValue?: string
  options?: ConnectorFieldOption[]
  dynamicOptions?: ConnectorDynamicOptionsDefinition
  min?: number
  max?: number
}
export type ConnectorRequest = {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  responseMode?: 'auto' | 'json' | 'text'
  validateResponse?: (value: unknown, status: number) => void
}
export type ConnectorBuildContext = {
  value: (fieldId: string) => string
  optional: (fieldId: string) => string | undefined
  json: (fieldId: string) => unknown
  integer: (fieldId: string) => number
  flag: (fieldId: string) => boolean
  path: (fieldId: string) => string
  query: (url: string, values: Record<string, string | number | boolean | undefined>) => string
}
export type ConnectorActionDefinition = {
  id: string
  label: string
  description: string
  fields: ConnectorFieldDefinition[]
  build: (context: ConnectorBuildContext) => ConnectorRequest
}
export type ConnectorPollingResult = {
  items: unknown[]
  cursor?: string
}
export type ConnectorTriggerDefinition = {
  id: string
  label: string
  description: string
  fields: ConnectorFieldDefinition[]
  build: (context: ConnectorBuildContext) => ConnectorRequest
  extract: (value: unknown) => ConnectorPollingResult
  key: (item: unknown) => string
}
export type ConnectorDefinition = {
  id: string
  /** Monotonic schema/runtime version. Legacy definitions default to version 1. */
  version?: number
  name: string
  description: string
  category: 'AI' | '协作' | '开发' | '数据' | '销售' | '效率' | '支付'
  color: string
  origins: string[]
  credentialKinds: CredentialKind[]
  credentialHeaderName?: string
  authHint: string
  actions: ConnectorActionDefinition[]
  triggers?: ConnectorTriggerDefinition[]
}
export type ConnectorCatalogFieldDefinition = Omit<ConnectorFieldDefinition, 'dynamicOptions'> & {
  dynamicOptions?: { dependsOn?: string[] }
}
export type ConnectorCatalogActionDefinition = Omit<ConnectorActionDefinition, 'build' | 'fields'> & { fields: ConnectorCatalogFieldDefinition[] }
export type ConnectorCatalogTriggerDefinition = Omit<ConnectorTriggerDefinition, 'build' | 'extract' | 'key' | 'fields'> & { fields: ConnectorCatalogFieldDefinition[] }
export type ConnectorCatalogItem = Omit<ConnectorDefinition, 'version' | 'actions' | 'triggers'> & {
  version: number
  actions: ConnectorCatalogActionDefinition[]
  triggers?: ConnectorCatalogTriggerDefinition[]
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/
const FIELD_ID_PATTERN = /^[a-z][A-Za-z0-9]*$/

function assertUniqueIds(values: Array<{ id: string }>, label: string, pattern = ID_PATTERN): void {
  const ids = new Set<string>()
  for (const value of values) {
    if (!pattern.test(value.id)) throw new Error(`${label} ID 无效：${value.id}`)
    if (ids.has(value.id)) throw new Error(`${label} ID 重复：${value.id}`)
    ids.add(value.id)
  }
}

function validateConnectorFields(connectorName: string, operationLabel: string, fields: ConnectorFieldDefinition[]): void {
  assertUniqueIds(fields, `${connectorName} / ${operationLabel} 字段`, FIELD_ID_PATTERN)
  const fieldIds = new Set(fields.map((field) => field.id))
  for (const field of fields) {
    if (!field.dynamicOptions) continue
    if (field.type !== 'text' && field.type !== 'select') throw new Error(`${field.label} 的动态选项只支持 text 或 select 字段`)
    for (const dependency of field.dynamicOptions.dependsOn ?? []) {
      if (!fieldIds.has(dependency) || dependency === field.id) throw new Error(`${field.label} 包含无效的动态选项依赖：${dependency}`)
    }
  }
}

export function defineConnector(definition: ConnectorDefinition): ConnectorDefinition {
  if (!ID_PATTERN.test(definition.id)) throw new Error(`连接器 ID 无效：${definition.id}`)
  const version = definition.version ?? 1
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${definition.name || definition.id} 连接器版本必须是正整数`)
  if (!definition.name.trim() || (definition.actions.length === 0 && !definition.triggers?.length)) throw new Error(`连接器 ${definition.id} 缺少名称、动作或触发器`)
  if (definition.credentialKinds.length === 0) throw new Error(`${definition.name} 连接器必须声明至少一种连接类型`)
  if (definition.credentialKinds.includes('webhook-secret')) throw new Error(`${definition.name} 连接器不能使用入站 Webhook Secret`)
  assertUniqueIds(definition.actions, `${definition.name} 动作`)
  for (const action of definition.actions) validateConnectorFields(definition.name, action.label, action.fields)
  assertUniqueIds(definition.triggers ?? [], `${definition.name} 触发器`)
  for (const trigger of definition.triggers ?? []) validateConnectorFields(definition.name, trigger.label, trigger.fields)
  const origins = definition.origins.map((origin) => {
    const url = new URL(origin)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`${definition.name} 连接器 Origin 必须使用 HTTPS`)
    if (url.username || url.password) throw new Error(`${definition.name} 连接器 Origin 不能包含用户名或密码`)
    return url.origin
  })
  return { ...definition, version, origins }
}

export const connectorFields = {
  text: (id: string, label: string, required = true, placeholder?: string): ConnectorFieldDefinition => ({ id, label, type: 'text', required, placeholder }),
  area: (id: string, label: string, required = true, placeholder?: string): ConnectorFieldDefinition => ({ id, label, type: 'textarea', required, placeholder }),
  json: (id: string, label: string, required = true, placeholder = '{}'): ConnectorFieldDefinition => ({ id, label, type: 'json', required, placeholder }),
  number: (id: string, label: string, defaultValue: string, min = 1, max = 100): ConnectorFieldDefinition => ({ id, label, type: 'number', defaultValue, min, max }),
  defaultText: (id: string, label: string, defaultValue: string): ConnectorFieldDefinition => ({ id, label, type: 'text', required: true, placeholder: defaultValue, defaultValue }),
  defaultArea: (id: string, label: string, defaultValue: string): ConnectorFieldDefinition => ({ id, label, type: 'textarea', required: true, placeholder: defaultValue, defaultValue }),
  defaultJson: (id: string, label: string, defaultValue: string): ConnectorFieldDefinition => ({ id, label, type: 'json', required: true, placeholder: defaultValue, defaultValue }),
}

export function jsonRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): ConnectorRequest {
  return {
    method,
    url,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    responseMode: 'json',
  }
}

export function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== ''))
}

export function formBody(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, value)
  return params.toString()
}

function fieldSource(field: ConnectorFieldDefinition, params: Record<string, string>): string {
  return Object.prototype.hasOwnProperty.call(params, field.id) ? String(params[field.id] ?? '') : (field.defaultValue ?? '')
}

function buildContext(action: ConnectorActionDefinition, params: Record<string, string>, input: unknown, variables: Record<string, unknown> = {}): ConnectorBuildContext {
  const fields = new Map(action.fields.map((field) => [field.id, field]))
  const rendered = (fieldId: string): { field: ConnectorFieldDefinition; source: string; value: string } => {
    const field = fields.get(fieldId)
    if (!field) throw new Error(`连接器动作不存在字段：${fieldId}`)
    const source = fieldSource(field, params)
    const value = renderResultTemplate(source, input, variables)
    if (field.required && !value.trim()) throw new Error(`${field.label}不能为空`)
    return { field, source, value }
  }
  return {
    value: (fieldId) => rendered(fieldId).value,
    optional: (fieldId) => {
      const value = rendered(fieldId).value
      return value.trim() ? value : undefined
    },
    json: (fieldId) => {
      const { field, source } = rendered(fieldId)
      if (!source.trim() && !field.required) return undefined
      try { return JSON.parse(renderResultJsonTemplate(source, input, variables)) as unknown } catch { throw new Error(`${field.label}必须是有效 JSON`) }
    },
    integer: (fieldId) => {
      const { field, value } = rendered(fieldId)
      const parsed = Number(value)
      if (!Number.isInteger(parsed)) throw new Error(`${field.label}必须是整数`)
      if (field.min !== undefined && parsed < field.min) throw new Error(`${field.label}不能小于 ${field.min}`)
      if (field.max !== undefined && parsed > field.max) throw new Error(`${field.label}不能大于 ${field.max}`)
      return parsed
    },
    flag: (fieldId) => ['true', '1', 'yes', 'on'].includes(rendered(fieldId).value.trim().toLowerCase()),
    path: (fieldId) => encodeURIComponent(rendered(fieldId).value),
    query: (url, values) => {
      const parsed = new URL(url)
      for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') parsed.searchParams.set(key, String(value))
      return parsed.toString()
    },
  }
}

export function connectorCatalog(connectors: ConnectorDefinition[]): ConnectorCatalogItem[] {
  return connectors.map((connector) => ({
    ...connector,
    version: connector.version ?? 1,
    actions: connector.actions.map(({ build: _build, fields, ...action }) => ({ ...action, fields: fields.map(publicConnectorField) })),
    triggers: connector.triggers?.map(({ build: _build, extract: _extract, key: _key, fields, ...trigger }) => ({ ...trigger, fields: fields.map(publicConnectorField) })),
  }))
}

function publicConnectorField({ dynamicOptions, ...field }: ConnectorFieldDefinition): ConnectorCatalogFieldDefinition {
  return { ...field, dynamicOptions: dynamicOptions ? { dependsOn: [...(dynamicOptions.dependsOn ?? [])] } : undefined }
}

export function connectorDefinitionVersion(connector: ConnectorDefinition): number {
  return connector.version ?? 1
}

export function resolveConnectorDefinition(connectors: ConnectorDefinition[], id: string | undefined, version?: number): ConnectorDefinition {
  const candidates = connectors.filter((candidate) => candidate.id === id)
  if (candidates.length === 0) throw new Error('尚未选择连接器')
  if (version !== undefined) {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(`${candidates[0].name} 连接器版本无效`)
    const exact = candidates.find((candidate) => connectorDefinitionVersion(candidate) === version)
    if (!exact) throw new Error(`${candidates[0].name} 连接器版本 ${version} 不可用`)
    return exact
  }
  return [...candidates].sort((left, right) => connectorDefinitionVersion(right) - connectorDefinitionVersion(left))[0]
}

export function connectorDefaultParams(action: ConnectorActionDefinition): Record<string, string> {
  return Object.fromEntries(action.fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue!]))
}

function validateConnectorCredential(connector: ConnectorDefinition, credential: CredentialSummary): void {
  if (!connector.credentialKinds.includes(credential.kind)) throw new Error(`${connector.name} 不支持 ${credential.kind} 连接`)
  if (credential.kind === 'api-key' && connector.credentialHeaderName && credential.headerName?.toLowerCase() !== connector.credentialHeaderName.toLowerCase()) {
    throw new Error(`${connector.name} 的 API Key Header 必须为 ${connector.credentialHeaderName}`)
  }
}

export function validateConnectorNodeConfiguration(connectors: ConnectorDefinition[], data: WorkflowNodeData, credential?: CredentialSummary): ConnectorDefinition {
  const connector = resolveConnectorDefinition(connectors, data.connectorId, data.connectorVersion)
  const operation = data.kind === 'connector-trigger'
    ? connector.triggers?.find((candidate) => candidate.id === data.connectorTrigger)
    : connector.actions.find((candidate) => candidate.id === data.connectorAction)
  if (!operation) throw new Error(`尚未选择 ${connector.name} ${data.kind === 'connector-trigger' ? '触发器' : '动作'}`)
  if (!data.credentialId || !credential) throw new Error(`${connector.name} 需要选择连接`)
  validateConnectorCredential(connector, credential)
  for (const field of operation.fields) {
    if (field.required && !fieldSource(field, data.connectorParams ?? {}).trim()) throw new Error(`${field.label}不能为空`)
  }
  return connector
}

function normalizeConnectorRequest(connector: ConnectorDefinition, request: ConnectorRequest, allowedMethods: string[]): ConnectorRequest {
  const url = new URL(request.url)
  if (!connector.origins.includes(url.origin)) throw new Error(`${connector.name} 请求目标不在允许列表中`)
  if (url.username || url.password) throw new Error('连接器请求 URL 不能包含用户名或密码')
  const method = request.method.toUpperCase()
  if (!allowedMethods.includes(method)) throw new Error('连接器使用了不支持的 HTTP 方法')
  if (request.body && new TextEncoder().encode(request.body).byteLength > 1024 * 1024) throw new Error('连接器请求体超过 1 MB 限制')
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (!name.trim() || /[\r\n]/.test(name) || /[\r\n]/.test(value)) throw new Error('连接器请求头包含无效字符')
  }
  return { ...request, method, url: url.toString(), headers: { ...(request.headers ?? {}) } }
}

export function buildConnectorRequest(
  connectors: ConnectorDefinition[],
  data: WorkflowNodeData,
  input: unknown,
  credential?: CredentialSummary,
  variables: Record<string, unknown> = {},
): ConnectorRequest {
  const connector = resolveConnectorDefinition(connectors, data.connectorId, data.connectorVersion)
  const action = connector.actions.find((candidate) => candidate.id === data.connectorAction)
  if (!action) throw new Error(`尚未选择 ${connector.name} 动作`)
  validateConnectorNodeConfiguration(connectors, data, credential)
  const request = action.build(buildContext(action, data.connectorParams ?? {}, input, variables))
  return normalizeConnectorRequest(connector, request, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
}

export function buildConnectorTriggerRequest(
  connectors: ConnectorDefinition[],
  data: WorkflowNodeData,
  credential?: CredentialSummary,
  variables: Record<string, unknown> = {},
): { connector: ConnectorDefinition; trigger: ConnectorTriggerDefinition; request: ConnectorRequest } {
  const connector = resolveConnectorDefinition(connectors, data.connectorId, data.connectorVersion)
  const trigger = connector.triggers?.find((candidate) => candidate.id === data.connectorTrigger)
  if (!trigger) throw new Error(`尚未选择 ${connector.name} 触发器`)
  validateConnectorNodeConfiguration(connectors, data, credential)
  const request = trigger.build(buildContext({ fields: trigger.fields } as ConnectorActionDefinition, data.connectorParams ?? {}, '', variables))
  return { connector, trigger, request: normalizeConnectorRequest(connector, request, ['GET', 'POST']) }
}

export function buildConnectorDynamicOptionsRequest(
  connectors: ConnectorDefinition[],
  data: WorkflowNodeData,
  operationId: string | undefined,
  fieldId: string | undefined,
  credential?: CredentialSummary,
  variables: Record<string, unknown> = {},
): { connector: ConnectorDefinition; field: ConnectorFieldDefinition; request: ConnectorRequest; extract: (value: unknown) => ConnectorFieldOption[] } {
  const connector = resolveConnectorDefinition(connectors, data.connectorId, data.connectorVersion)
  const operation = data.kind === 'connector-trigger'
    ? connector.triggers?.find((candidate) => candidate.id === operationId)
    : connector.actions.find((candidate) => candidate.id === operationId)
  if (!operation) throw new Error(`尚未选择 ${connector.name} ${data.kind === 'connector-trigger' ? '触发器' : '动作'}`)
  const field = operation.fields.find((candidate) => candidate.id === fieldId)
  if (!field?.dynamicOptions) throw new Error('该字段不提供动态选项')
  if (!data.credentialId || !credential) throw new Error(`${connector.name} 需要选择连接`)
  validateConnectorCredential(connector, credential)
  const context = buildContext({ fields: operation.fields } as ConnectorActionDefinition, data.connectorParams ?? {}, '', variables)
  const request = normalizeConnectorRequest(connector, field.dynamicOptions.build(context), ['GET', 'POST'])
  return { connector, field, request, extract: field.dynamicOptions.extract }
}

export function sanitizeConnectorDynamicOptions(options: ConnectorFieldOption[]): ConnectorFieldOption[] {
  if (!Array.isArray(options) || options.length > 500) throw new Error('连接器动态选项数量无效')
  const normalized = options.map((option) => ({ value: String(option?.value ?? ''), label: String(option?.label ?? '') }))
  if (normalized.some((option) => !option.value || option.value.length > 1000 || !option.label || option.label.length > 200)) throw new Error('连接器返回了无效的动态选项')
  const unique = new Map<string, ConnectorFieldOption>()
  for (const option of normalized) if (!unique.has(option.value)) unique.set(option.value, option)
  return [...unique.values()]
}

export class ConnectorRegistry {
  private readonly definitions = new Map<string, ConnectorDefinition>()

  constructor(initial: ConnectorDefinition[] = []) {
    for (const definition of initial) this.register(definition)
  }

  register(definition: ConnectorDefinition): () => void {
    const normalized = defineConnector(definition)
    const key = `${normalized.id}@${connectorDefinitionVersion(normalized)}`
    if (this.definitions.has(key)) throw new Error(`连接器已注册：${key}`)
    this.definitions.set(key, normalized)
    return () => {
      if (this.definitions.get(key) === normalized) this.definitions.delete(key)
    }
  }

  get(id: string | undefined, version?: number): ConnectorDefinition | undefined {
    if (!id) return undefined
    try { return resolveConnectorDefinition(this.list(), id, version) } catch { return undefined }
  }

  list(): ConnectorDefinition[] {
    return [...this.definitions.values()]
  }

  catalog(): ConnectorCatalogItem[] {
    return connectorCatalog(this.list())
  }

  build(data: WorkflowNodeData, input: unknown, credential?: CredentialSummary, variables: Record<string, unknown> = {}): ConnectorRequest {
    return buildConnectorRequest(this.list(), data, input, credential, variables)
  }
}

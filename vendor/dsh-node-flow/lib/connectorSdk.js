import { renderResultJsonTemplate, renderResultTemplate } from './resultExpression.js';
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const FIELD_ID_PATTERN = /^[a-z][A-Za-z0-9]*$/;
function assertUniqueIds(values, label, pattern = ID_PATTERN) {
    const ids = new Set();
    for (const value of values) {
        if (!pattern.test(value.id))
            throw new Error(`${label} ID 无效：${value.id}`);
        if (ids.has(value.id))
            throw new Error(`${label} ID 重复：${value.id}`);
        ids.add(value.id);
    }
}
function validateConnectorFields(connectorName, operationLabel, fields) {
    assertUniqueIds(fields, `${connectorName} / ${operationLabel} 字段`, FIELD_ID_PATTERN);
    const fieldIds = new Set(fields.map((field) => field.id));
    for (const field of fields) {
        if (!field.dynamicOptions)
            continue;
        if (field.type !== 'text' && field.type !== 'select')
            throw new Error(`${field.label} 的动态选项只支持 text 或 select 字段`);
        for (const dependency of field.dynamicOptions.dependsOn ?? []) {
            if (!fieldIds.has(dependency) || dependency === field.id)
                throw new Error(`${field.label} 包含无效的动态选项依赖：${dependency}`);
        }
    }
}
export function defineConnector(definition) {
    if (!ID_PATTERN.test(definition.id))
        throw new Error(`连接器 ID 无效：${definition.id}`);
    const version = definition.version ?? 1;
    if (!Number.isSafeInteger(version) || version < 1)
        throw new Error(`${definition.name || definition.id} 连接器版本必须是正整数`);
    if (!definition.name.trim() || (definition.actions.length === 0 && !definition.triggers?.length))
        throw new Error(`连接器 ${definition.id} 缺少名称、动作或触发器`);
    if (definition.credentialKinds.length === 0)
        throw new Error(`${definition.name} 连接器必须声明至少一种连接类型`);
    if (definition.credentialKinds.includes('webhook-secret'))
        throw new Error(`${definition.name} 连接器不能使用入站 Webhook Secret`);
    assertUniqueIds(definition.actions, `${definition.name} 动作`);
    for (const action of definition.actions)
        validateConnectorFields(definition.name, action.label, action.fields);
    assertUniqueIds(definition.triggers ?? [], `${definition.name} 触发器`);
    for (const trigger of definition.triggers ?? [])
        validateConnectorFields(definition.name, trigger.label, trigger.fields);
    const origins = definition.origins.map((origin) => {
        const url = new URL(origin);
        const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
            throw new Error(`${definition.name} 连接器 Origin 必须使用 HTTPS`);
        if (url.username || url.password)
            throw new Error(`${definition.name} 连接器 Origin 不能包含用户名或密码`);
        return url.origin;
    });
    return { ...definition, version, origins };
}
export const connectorFields = {
    text: (id, label, required = true, placeholder) => ({ id, label, type: 'text', required, placeholder }),
    area: (id, label, required = true, placeholder) => ({ id, label, type: 'textarea', required, placeholder }),
    json: (id, label, required = true, placeholder = '{}') => ({ id, label, type: 'json', required, placeholder }),
    number: (id, label, defaultValue, min = 1, max = 100) => ({ id, label, type: 'number', defaultValue, min, max }),
    defaultText: (id, label, defaultValue) => ({ id, label, type: 'text', required: true, placeholder: defaultValue, defaultValue }),
    defaultArea: (id, label, defaultValue) => ({ id, label, type: 'textarea', required: true, placeholder: defaultValue, defaultValue }),
    defaultJson: (id, label, defaultValue) => ({ id, label, type: 'json', required: true, placeholder: defaultValue, defaultValue }),
};
export function jsonRequest(method, url, body, headers = {}) {
    return {
        method,
        url,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        responseMode: 'json',
    };
}
export function compact(values) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== ''));
}
export function formBody(values) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
        if (value !== undefined && value !== '')
            params.set(key, value);
    return params.toString();
}
function fieldSource(field, params) {
    return Object.prototype.hasOwnProperty.call(params, field.id) ? String(params[field.id] ?? '') : (field.defaultValue ?? '');
}
function buildContext(action, params, input, variables = {}) {
    const fields = new Map(action.fields.map((field) => [field.id, field]));
    const rendered = (fieldId) => {
        const field = fields.get(fieldId);
        if (!field)
            throw new Error(`连接器动作不存在字段：${fieldId}`);
        const source = fieldSource(field, params);
        const value = renderResultTemplate(source, input, variables);
        if (field.required && !value.trim())
            throw new Error(`${field.label}不能为空`);
        return { field, source, value };
    };
    return {
        value: (fieldId) => rendered(fieldId).value,
        optional: (fieldId) => {
            const value = rendered(fieldId).value;
            return value.trim() ? value : undefined;
        },
        json: (fieldId) => {
            const { field, source } = rendered(fieldId);
            if (!source.trim() && !field.required)
                return undefined;
            try {
                return JSON.parse(renderResultJsonTemplate(source, input, variables));
            }
            catch {
                throw new Error(`${field.label}必须是有效 JSON`);
            }
        },
        integer: (fieldId) => {
            const { field, value } = rendered(fieldId);
            const parsed = Number(value);
            if (!Number.isInteger(parsed))
                throw new Error(`${field.label}必须是整数`);
            if (field.min !== undefined && parsed < field.min)
                throw new Error(`${field.label}不能小于 ${field.min}`);
            if (field.max !== undefined && parsed > field.max)
                throw new Error(`${field.label}不能大于 ${field.max}`);
            return parsed;
        },
        flag: (fieldId) => ['true', '1', 'yes', 'on'].includes(rendered(fieldId).value.trim().toLowerCase()),
        path: (fieldId) => encodeURIComponent(rendered(fieldId).value),
        query: (url, values) => {
            const parsed = new URL(url);
            for (const [key, value] of Object.entries(values))
                if (value !== undefined && value !== '')
                    parsed.searchParams.set(key, String(value));
            return parsed.toString();
        },
    };
}
export function connectorCatalog(connectors) {
    return connectors.map((connector) => ({
        ...connector,
        version: connector.version ?? 1,
        actions: connector.actions.map(({ build: _build, fields, ...action }) => ({ ...action, fields: fields.map(publicConnectorField) })),
        triggers: connector.triggers?.map(({ build: _build, extract: _extract, key: _key, fields, ...trigger }) => ({ ...trigger, fields: fields.map(publicConnectorField) })),
    }));
}
function publicConnectorField({ dynamicOptions, ...field }) {
    return { ...field, dynamicOptions: dynamicOptions ? { dependsOn: [...(dynamicOptions.dependsOn ?? [])] } : undefined };
}
export function connectorDefinitionVersion(connector) {
    return connector.version ?? 1;
}
export function resolveConnectorDefinition(connectors, id, version) {
    const candidates = connectors.filter((candidate) => candidate.id === id);
    if (candidates.length === 0)
        throw new Error('尚未选择连接器');
    if (version !== undefined) {
        if (!Number.isSafeInteger(version) || version < 1)
            throw new Error(`${candidates[0].name} 连接器版本无效`);
        const exact = candidates.find((candidate) => connectorDefinitionVersion(candidate) === version);
        if (!exact)
            throw new Error(`${candidates[0].name} 连接器版本 ${version} 不可用`);
        return exact;
    }
    return [...candidates].sort((left, right) => connectorDefinitionVersion(right) - connectorDefinitionVersion(left))[0];
}
export function connectorDefaultParams(action) {
    return Object.fromEntries(action.fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue]));
}
function validateConnectorCredential(connector, credential) {
    if (!connector.credentialKinds.includes(credential.kind))
        throw new Error(`${connector.name} 不支持 ${credential.kind} 连接`);
    if (credential.kind === 'api-key' && connector.credentialHeaderName && credential.headerName?.toLowerCase() !== connector.credentialHeaderName.toLowerCase()) {
        throw new Error(`${connector.name} 的 API Key Header 必须为 ${connector.credentialHeaderName}`);
    }
}
export function validateConnectorNodeConfiguration(connectors, data, credential) {
    const connector = resolveConnectorDefinition(connectors, data.connectorId, data.connectorVersion);
    const operation = data.kind === 'connector-trigger'
        ? connector.triggers?.find((candidate) => candidate.id === data.connectorTrigger)
        : connector.actions.find((candidate) => candidate.id === data.connectorAction);
    if (!operation)
        throw new Error(`尚未选择 ${connector.name} ${data.kind === 'connector-trigger' ? '触发器' : '动作'}`);
    if (!data.credentialId || !credential)
        throw new Error(`${connector.name} 需要选择连接`);
    validateConnectorCredential(connector, credential);
    for (const field of operation.fields) {
        if (field.required && !fieldSource(field, data.connectorParams ?? {}).trim())
            throw new Error(`${field.label}不能为空`);
    }
    return connector;
}
function normalizeConnectorRequest(connector, request, allowedMethods) {
    const url = new URL(request.url);
    if (!connector.origins.includes(url.origin))
        throw new Error(`${connector.name} 请求目标不在允许列表中`);
    if (url.username || url.password)
        throw new Error('连接器请求 URL 不能包含用户名或密码');
    const method = request.method.toUpperCase();
    if (!allowedMethods.includes(method))
        throw new Error('连接器使用了不支持的 HTTP 方法');
    if (request.body && new TextEncoder().encode(request.body).byteLength > 1024 * 1024)
        throw new Error('连接器请求体超过 1 MB 限制');
    for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (!name.trim() || /[\r\n]/.test(name) || /[\r\n]/.test(value))
            throw new Error('连接器请求头包含无效字符');
    }
    return { ...request, method, url: url.toString(), headers: { ...(request.headers ?? {}) } };
}
export function buildConnectorRequest(connectors, data, input, credential, variables = {}) {
    const connector = resolveConnectorDefinition(connectors, data.connectorId, data.connectorVersion);
    const action = connector.actions.find((candidate) => candidate.id === data.connectorAction);
    if (!action)
        throw new Error(`尚未选择 ${connector.name} 动作`);
    validateConnectorNodeConfiguration(connectors, data, credential);
    const request = action.build(buildContext(action, data.connectorParams ?? {}, input, variables));
    return normalizeConnectorRequest(connector, request, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
}
export function buildConnectorTriggerRequest(connectors, data, credential, variables = {}) {
    const connector = resolveConnectorDefinition(connectors, data.connectorId, data.connectorVersion);
    const trigger = connector.triggers?.find((candidate) => candidate.id === data.connectorTrigger);
    if (!trigger)
        throw new Error(`尚未选择 ${connector.name} 触发器`);
    validateConnectorNodeConfiguration(connectors, data, credential);
    const request = trigger.build(buildContext({ fields: trigger.fields }, data.connectorParams ?? {}, '', variables));
    return { connector, trigger, request: normalizeConnectorRequest(connector, request, ['GET', 'POST']) };
}
export function buildConnectorDynamicOptionsRequest(connectors, data, operationId, fieldId, credential, variables = {}) {
    const connector = resolveConnectorDefinition(connectors, data.connectorId, data.connectorVersion);
    const operation = data.kind === 'connector-trigger'
        ? connector.triggers?.find((candidate) => candidate.id === operationId)
        : connector.actions.find((candidate) => candidate.id === operationId);
    if (!operation)
        throw new Error(`尚未选择 ${connector.name} ${data.kind === 'connector-trigger' ? '触发器' : '动作'}`);
    const field = operation.fields.find((candidate) => candidate.id === fieldId);
    if (!field?.dynamicOptions)
        throw new Error('该字段不提供动态选项');
    if (!data.credentialId || !credential)
        throw new Error(`${connector.name} 需要选择连接`);
    validateConnectorCredential(connector, credential);
    const context = buildContext({ fields: operation.fields }, data.connectorParams ?? {}, '', variables);
    const request = normalizeConnectorRequest(connector, field.dynamicOptions.build(context), ['GET', 'POST']);
    return { connector, field, request, extract: field.dynamicOptions.extract };
}
export function sanitizeConnectorDynamicOptions(options) {
    if (!Array.isArray(options) || options.length > 500)
        throw new Error('连接器动态选项数量无效');
    const normalized = options.map((option) => ({ value: String(option?.value ?? ''), label: String(option?.label ?? '') }));
    if (normalized.some((option) => !option.value || option.value.length > 1000 || !option.label || option.label.length > 200))
        throw new Error('连接器返回了无效的动态选项');
    const unique = new Map();
    for (const option of normalized)
        if (!unique.has(option.value))
            unique.set(option.value, option);
    return [...unique.values()];
}
export class ConnectorRegistry {
    definitions = new Map();
    constructor(initial = []) {
        for (const definition of initial)
            this.register(definition);
    }
    register(definition) {
        const normalized = defineConnector(definition);
        const key = `${normalized.id}@${connectorDefinitionVersion(normalized)}`;
        if (this.definitions.has(key))
            throw new Error(`连接器已注册：${key}`);
        this.definitions.set(key, normalized);
        return () => {
            if (this.definitions.get(key) === normalized)
                this.definitions.delete(key);
        };
    }
    get(id, version) {
        if (!id)
            return undefined;
        try {
            return resolveConnectorDefinition(this.list(), id, version);
        }
        catch {
            return undefined;
        }
    }
    list() {
        return [...this.definitions.values()];
    }
    catalog() {
        return connectorCatalog(this.list());
    }
    build(data, input, credential, variables = {}) {
        return buildConnectorRequest(this.list(), data, input, credential, variables);
    }
}

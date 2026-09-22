import test from 'node:test'
import assert from 'node:assert/strict'
import type { CredentialSummary, WorkflowNodeData } from '../src/model.js'
import { BUILTIN_CONNECTORS } from '../src/builtinConnectors.js'
import { buildConnectorDynamicOptionsRequest, buildConnectorRequest, buildConnectorTriggerRequest, connectorCatalog, ConnectorRegistry, defineConnector, sanitizeConnectorDynamicOptions } from '../src/connectorSdk.js'

const bearer: CredentialSummary = {
  id: 'credential-1', name: 'Bearer', kind: 'bearer', status: 'connected', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

function node(patch: Partial<WorkflowNodeData>): WorkflowNodeData {
  return { kind: 'connector', label: '连接器', credentialId: bearer.id, ...patch }
}

test('publishes a serializable catalog without request builders', () => {
  const catalog = connectorCatalog(BUILTIN_CONNECTORS)
  assert.equal(catalog.length, 16)
  assert.equal(catalog.some((connector) => connector.id === 'github'), true)
  assert.equal('build' in catalog[0].actions[0], false)
  assert.equal(catalog.filter((connector) => connector.triggers?.length).length, 5)
  assert.equal(catalog.some((connector) => connector.triggers?.some((trigger) => 'extract' in trigger || 'key' in trigger)), false)
  const slackChannel = catalog.find((connector) => connector.id === 'slack')?.actions[0].fields[0]
  assert.deepEqual(slackChannel?.dynamicOptions, { dependsOn: [] })
  assert.equal('build' in (slackChannel?.dynamicOptions ?? {}), false)
  assert.doesNotThrow(() => JSON.stringify(catalog))
})

test('resolves exact connector versions and keeps multiple versions registered', () => {
  const definition = (version: number) => defineConnector({ id: 'versioned', version, name: 'Versioned', description: '', category: '开发', color: '#000', origins: ['https://safe.example'], credentialKinds: ['bearer'], authHint: '', actions: [{ id: 'read', label: 'Read', description: '', fields: [], build: () => ({ method: 'GET', url: `https://safe.example/v${version}` }) }] })
  const registry = new ConnectorRegistry([definition(1), definition(2)])
  assert.equal(registry.list().length, 2)
  assert.equal(registry.get('versioned')?.version, 2)
  assert.equal(registry.build(node({ connectorId: 'versioned', connectorVersion: 1, connectorAction: 'read' }), '', bearer).url, 'https://safe.example/v1')
  assert.equal(registry.build(node({ connectorId: 'versioned', connectorAction: 'read' }), '', bearer).url, 'https://safe.example/v2')
  assert.throws(() => registry.build(node({ connectorId: 'versioned', connectorVersion: 3, connectorAction: 'read' }), '', bearer), /版本 3 不可用/)
})

test('builds and sanitizes credential-backed dynamic field options', () => {
  const built = buildConnectorDynamicOptionsRequest(BUILTIN_CONNECTORS, node({ connectorId: 'slack', connectorVersion: 1, connectorAction: 'post-message', connectorParams: { text: 'hello' } }), 'post-message', 'channel', bearer)
  assert.equal(built.request.url, 'https://slack.com/api/conversations.list?exclude_archived=true&limit=200&types=public_channel%2Cprivate_channel')
  const options = sanitizeConnectorDynamicOptions(built.extract({ ok: true, channels: [{ id: 'C1', name: 'general' }, { id: 'C1', name: 'duplicate' }, { id: 'C2' }] }))
  assert.deepEqual(options, [{ value: 'C1', label: '#general' }, { value: 'C2', label: 'C2' }])
  assert.throws(() => sanitizeConnectorDynamicOptions(Array.from({ length: 501 }, (_, index) => ({ value: String(index), label: String(index) }))), /数量/)
})

test('builds polling requests with fixed origins and compatible credentials', () => {
  const built = buildConnectorTriggerRequest(BUILTIN_CONNECTORS, {
    kind: 'connector-trigger', label: 'New issue', connectorId: 'github', connectorTrigger: 'new-issue', credentialId: bearer.id,
    connectorParams: { owner: 'openai', repo: 'codex' }, pollInterval: '60',
  }, bearer)
  assert.equal(built.request.method, 'GET')
  assert.match(built.request.url, /^https:\/\/api\.github\.com\/repos\/openai\/codex\/issues\?/)
  assert.equal(built.trigger.key({ id: 42 }), '42')
  assert.throws(() => buildConnectorTriggerRequest(BUILTIN_CONNECTORS, { kind: 'connector-trigger', label: 'New issue', connectorId: 'github', connectorTrigger: 'new-issue', credentialId: bearer.id, connectorParams: { owner: '', repo: 'codex' } }, bearer), /仓库所有者不能为空/)
})

test('builds a GitHub request with nested mapped fields and encoded paths', () => {
  const request = buildConnectorRequest(BUILTIN_CONNECTORS, node({
    connectorId: 'github', connectorAction: 'create-issue', connectorParams: {
      owner: '{{result.owner}}', repo: 'workflow tools', title: 'Bug: {{result.title}}', body: '{{result.body}}', labels: '["{{result.label}}"]',
    },
  }), { owner: 'luxi233', title: 'broken', body: 'line one', label: 'bug' }, bearer)
  assert.equal(request.url, 'https://api.github.com/repos/luxi233/workflow%20tools/issues')
  assert.deepEqual(JSON.parse(request.body ?? ''), { title: 'Bug: broken', body: 'line one', labels: ['bug'] })
  assert.equal(request.headers?.['x-github-api-version'], '2022-11-28')
})

test('preserves typed JSON mapping and validates numeric bounds', () => {
  const request = buildConnectorRequest(BUILTIN_CONNECTORS, node({
    connectorId: 'google-sheets', connectorAction: 'append-values', connectorParams: {
      spreadsheetId: 'sheet-1', range: 'Main!A:B', values: '[[{{result.id}},"{{result.name}}"]]',
    },
  }), { id: 42, name: 'Ada' }, { ...bearer, kind: 'oauth2' })
  assert.deepEqual(JSON.parse(request.body ?? ''), { values: [[42, 'Ada']] })
  assert.match(request.url, /Main!A%3AB:append/)
  assert.throws(() => buildConnectorRequest(BUILTIN_CONNECTORS, node({ connectorId: 'slack', connectorAction: 'list-history', connectorParams: { channel: 'C1', limit: '101' } }), '', bearer), /不能大于 100/)
})

test('rejects incompatible credentials, missing fields and unsafe origins', () => {
  assert.throws(() => buildConnectorRequest(BUILTIN_CONNECTORS, node({ connectorId: 'anthropic', connectorAction: 'list-models', connectorParams: { limit: '20' } }), '', bearer), /不支持 bearer/)
  assert.throws(() => buildConnectorRequest(BUILTIN_CONNECTORS, node({ connectorId: 'anthropic', connectorAction: 'list-models', connectorParams: { limit: '20' } }), '', { ...bearer, kind: 'api-key', headerName: 'Authorization' }), /x-api-key/)
  assert.throws(() => buildConnectorRequest(BUILTIN_CONNECTORS, node({ connectorId: 'github', connectorAction: 'create-issue', connectorParams: { owner: '', repo: 'repo', title: 'title' } }), '', bearer), /仓库所有者不能为空/)
  const unsafe = defineConnector({ id: 'unsafe', name: 'Unsafe', description: '', category: '开发', color: '#000', origins: ['https://safe.example'], credentialKinds: ['bearer'], authHint: '', actions: [{ id: 'run', label: 'Run', description: '', fields: [], build: () => ({ method: 'GET', url: 'https://evil.example/data' }) }] })
  assert.throws(() => buildConnectorRequest([unsafe], node({ connectorId: 'unsafe', connectorAction: 'run' }), '', bearer), /允许列表/)
})

test('rejects oversized connector request bodies', () => {
  const huge = defineConnector({ id: 'huge', name: 'Huge', description: '', category: '开发', color: '#000', origins: ['https://safe.example'], credentialKinds: ['bearer'], authHint: '', actions: [{ id: 'run', label: 'Run', description: '', fields: [], build: () => ({ method: 'POST', url: 'https://safe.example/data', body: 'x'.repeat(1024 * 1024 + 1) }) }] })
  assert.throws(() => buildConnectorRequest([huge], node({ connectorId: 'huge', connectorAction: 'run' }), '', bearer), /超过 1 MB/)
})

test('exposes connector-specific response validation', () => {
  const request = buildConnectorRequest(BUILTIN_CONNECTORS, node({ connectorId: 'slack', connectorAction: 'post-message', connectorParams: { channel: 'C1', text: 'hello' } }), '', bearer)
  assert.throws(() => request.validateResponse?.({ ok: false, error: 'channel_not_found' }, 200), /channel_not_found/)
  assert.doesNotThrow(() => request.validateResponse?.({ ok: true }, 200))
})

test('registers and disposes external connector definitions', () => {
  const registry = new ConnectorRegistry()
  const disposable = defineConnector({ id: 'sample', name: 'Sample', description: '', category: '开发', color: '#000', origins: ['https://safe.example'], credentialKinds: ['bearer'], authHint: '', actions: [{ id: 'read', label: 'Read', description: '', fields: [], build: () => ({ method: 'GET', url: 'https://safe.example/data' }) }] })
  const dispose = registry.register(disposable)
  assert.equal(registry.catalog()[0].id, 'sample')
  assert.throws(() => registry.register(disposable), /已注册/)
  dispose()
  assert.equal(registry.list().length, 0)
})

test('requires secure connector origins except for loopback development', () => {
  assert.throws(() => defineConnector({ id: 'plain', name: 'Plain', description: '', category: '开发', color: '#000', origins: ['http://remote.example'], credentialKinds: ['bearer'], authHint: '', actions: [{ id: 'read', label: 'Read', description: '', fields: [], build: () => ({ method: 'GET', url: 'http://remote.example/data' }) }] }), /HTTPS/)
  assert.doesNotThrow(() => defineConnector({ id: 'local', name: 'Local', description: '', category: '开发', color: '#000', origins: ['http://127.0.0.1:4312'], credentialKinds: ['bearer'], authHint: '', actions: [{ id: 'read', label: 'Read', description: '', fields: [], build: () => ({ method: 'GET', url: 'http://127.0.0.1:4312/data' }) }] }))
})

test('requires outbound credential types for connector declarations', () => {
  const declaration = { id: 'invalid-auth', name: 'Invalid Auth', description: '', category: '开发' as const, color: '#000', origins: ['https://safe.example'], authHint: '', actions: [{ id: 'read', label: 'Read', description: '', fields: [], build: () => ({ method: 'GET', url: 'https://safe.example/data' }) }] }
  assert.throws(() => defineConnector({ ...declaration, credentialKinds: [] }), /至少一种连接类型/)
  assert.throws(() => defineConnector({ ...declaration, credentialKinds: ['webhook-secret'] }), /不能使用入站 Webhook Secret/)
  assert.doesNotThrow(() => defineConnector({ ...declaration, actions: [], credentialKinds: ['bearer'], triggers: [{ id: 'changed', label: 'Changed', description: '', fields: [], build: () => ({ method: 'GET', url: 'https://safe.example/events' }), extract: (value) => ({ items: Array.isArray(value) ? value : [] }), key: (item) => String(item) }] }))
})

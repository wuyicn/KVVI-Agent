const baseUrl = process.env.DSH_WEB_URL
if (!baseUrl) throw new Error('DSH_WEB_URL is required')

const credentialName = `__connector_runtime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const workflowId = `__connector_version_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const nativeFetch = globalThis.fetch
const requests = []
const slackRequests = []
let attempts = 0

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.startsWith('https://slack.com/api/conversations.list')) {
    slackRequests.push({ url, headers: { ...(init?.headers ?? {}) } })
    return new Response(JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'general' }, { id: 'C2', name: 'alerts' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (!url.startsWith('https://api.github.com/')) return nativeFetch(input, init)
  attempts += 1
  requests.push({ url, method: init?.method, headers: { ...(init?.headers ?? {}) }, body: init?.body })
  if (attempts === 1) return new Response(JSON.stringify({ message: 'retry' }), { status: 503, headers: { 'content-type': 'application/json' } })
  return new Response(JSON.stringify({ id: 42, html_url: 'https://github.example/issues/42' }), { status: 201, headers: { 'content-type': 'application/json' } })
}

async function requestJson(path, init = {}) {
  const response = await nativeFetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

async function postRaw(path, body) {
  const response = await nativeFetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify(body) })
  return { response, data: await response.json().catch(() => ({})) }
}

async function cleanup() {
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ workflows: [] }))
  const workflow = workflows.workflows?.find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
  const listed = await requestJson('/dsh-node-flow/credentials').catch(() => ({ credentials: [] }))
  for (const credential of listed.credentials || []) {
    if (credential.name === credentialName) await post('/dsh-node-flow/credentials', { action: 'delete', id: credential.id }).catch(() => undefined)
  }
}

try {
  await cleanup()
  const workflows = await requestJson('/dsh-node-flow/workflows')
  if (workflows.capabilities?.connectors !== true || workflows.capabilities?.connectorVersions !== true || workflows.capabilities?.connectorDynamicOptions !== true) throw new Error('Runtime does not expose Connector SDK v2 capabilities')
  const catalog = await requestJson('/dsh-node-flow/connectors')
  if (catalog.connectors?.length !== 16 || catalog.connectors.some((connector) => connector.version !== 1 || connector.actions.some((action) => 'build' in action))) throw new Error('Connector catalog is incomplete, unversioned, or leaked executable builders')
  const saved = await post('/dsh-node-flow/credentials', { action: 'save', credential: { name: credentialName, kind: 'bearer', secret: { value: 'runtime-secret-token' } } })
  const credentialId = saved.credential?.id
  if (!credentialId || JSON.stringify(saved).includes('runtime-secret-token')) throw new Error('Connector credential save leaked a secret')
  const dynamic = await post('/dsh-node-flow/connectors', { node: { id: 'connector-slack', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'connector', label: 'Slack', connectorId: 'slack', connectorVersion: 1, connectorAction: 'post-message', credentialId, connectorParams: { text: 'hello' } } }, fieldId: 'channel' })
  if (dynamic.options?.length !== 2 || dynamic.options[0]?.value !== 'C1' || JSON.stringify(dynamic).includes('runtime-secret-token')) throw new Error(`Dynamic connector options failed or leaked a secret: ${JSON.stringify(dynamic)}`)
  if (slackRequests.length !== 1 || slackRequests[0].headers.Authorization !== 'Bearer runtime-secret-token') throw new Error('Dynamic options request did not inject the encrypted credential')
  const now = new Date().toISOString()
  const pinned = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: 0, workflow: { id: workflowId, name: workflowId, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc: { version: 1, name: workflowId, nodes: [{ id: 'connector', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'connector', label: 'Pinned', connectorId: 'github', connectorAction: 'create-issue', credentialId, connectorParams: { owner: 'openai', repo: 'codex', title: 'Pinned' } } }], edges: [] } } })
  if (pinned.workflow?.doc?.nodes?.[0]?.data?.connectorVersion !== 1) throw new Error('Workflow save did not pin the connector version')
  const unavailableDraft = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: pinned.workflow.revision, workflow: { ...pinned.workflow, doc: { ...pinned.workflow.doc, nodes: pinned.workflow.doc.nodes.map((node) => ({ ...node, data: { ...node.data, connectorVersion: 999 } })) } } })
  if (unavailableDraft.workflow?.doc?.nodes?.[0]?.data?.connectorVersion !== 999) throw new Error('Unavailable pinned version could not be preserved in a draft')
  const rejectedPublish = await postRaw('/dsh-node-flow/workflows', { action: 'status', id: workflowId, status: 'enabled', expectedRevision: unavailableDraft.workflow.revision })
  if (rejectedPublish.response.status !== 400 || !String(rejectedPublish.data.error ?? '').includes('版本 999 不可用')) throw new Error(`Unavailable connector version was not rejected at publish: ${JSON.stringify(rejectedPublish.data)}`)
  const result = await post('/dsh-node-flow/node-test', {
    node: {
      id: 'connector-github', type: 'workflow', position: { x: 0, y: 0 },
      data: {
        kind: 'connector', label: 'Create GitHub issue', connectorId: 'github', connectorAction: 'create-issue', credentialId,
        connectorParams: { owner: '{{result.owner}}', repo: 'workflow tools', title: 'Alert: {{result.title}}', body: '{{result.body}}', labels: '["automation"]' },
        retryCount: '1', retryDelay: '0', responseMode: 'json', failOnHttpError: true,
      },
    },
    input: { owner: 'luxi233', title: 'runtime', body: 'connector works' },
  })
  if (result.node?.status !== 'ok' || result.node?.output?.id !== 42 || result.node?.attempts !== 2) throw new Error(`Connector runtime execution failed: ${JSON.stringify(result)}`)
  if (requests.length !== 2 || requests[1].url !== 'https://api.github.com/repos/luxi233/workflow%20tools/issues') throw new Error(`Connector URL mapping failed: ${JSON.stringify(requests)}`)
  if (requests[1].headers.Authorization !== 'Bearer runtime-secret-token') throw new Error('Encrypted credential was not injected into the connector request')
  if (JSON.parse(String(requests[1].body)).title !== 'Alert: runtime') throw new Error('Connector body mapping failed')
  console.log(JSON.stringify({ ok: true, connectors: catalog.connectors.length, attempts, versionPinned: true, unavailableVersionRejected: true, dynamicOptions: true, credentialInjected: true, secretHidden: true }, null, 2))
} finally {
  globalThis.fetch = nativeFetch
  await cleanup().catch(() => undefined)
}

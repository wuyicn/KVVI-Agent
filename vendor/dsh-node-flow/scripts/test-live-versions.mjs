const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const id = `live-version-${suffix}`
const name = `Live Version ${suffix}`

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

const documentOf = (label) => ({
  version: 1,
  name,
  nodes: [
    { id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: '开始' }, style: { width: 224, height: 76 } },
    ...(label ? [{ id: 'output', type: 'workflow', position: { x: 380, y: 180 }, data: { kind: 'output', label, template: '{{result}}' }, style: { width: 224, height: 82 } }] : []),
  ],
  edges: label ? [{ id: 'edge', source: 'trigger', target: 'output', type: 'workflow' }] : [],
})

let current
try {
  const createdAt = new Date().toISOString()
  let result = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: 0, workflow: { id, name, status: 'disabled', revision: 0, draftRevision: 0, createdAt, updatedAt: createdAt, doc: documentOf('') } })
  if (!result.response.ok) throw new Error(result.data.error || `Create failed: ${result.response.status}`)
  current = result.data.workflow

  result = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: current.revision, workflow: { ...current, doc: documentOf('历史结果') } })
  if (!result.response.ok) throw new Error(result.data.error || `Save failed: ${result.response.status}`)
  current = result.data.workflow

  result = await post('/dsh-node-flow/workflows', { action: 'status', id, status: 'enabled', expectedRevision: current.revision })
  if (!result.response.ok) throw new Error(result.data.error || `Publish failed: ${result.response.status}`)
  current = result.data.workflow
  const publishedDoc = structuredClone(current.publishedDoc)

  result = await requestJson(`/dsh-node-flow/workflow-versions?workflowId=${encodeURIComponent(id)}`)
  if (!result.response.ok || result.data.versions.length !== 3) throw new Error(`Expected 3 versions: ${JSON.stringify(result.data)}`)
  const createdVersion = result.data.versions.find((version) => version.kind === 'created')
  const draftVersion = result.data.versions.find((version) => version.kind === 'draft')
  if (!createdVersion || !draftVersion) throw new Error('Created or draft version was not persisted')

  result = await post('/dsh-node-flow/workflow-versions', { action: 'restore', id, versionId: createdVersion.id, publish: false, expectedRevision: current.revision })
  if (!result.response.ok) throw new Error(result.data.error || `Draft restore failed: ${result.response.status}`)
  current = result.data.workflow
  if (current.doc.nodes.length !== 1 || JSON.stringify(current.publishedDoc) !== JSON.stringify(publishedDoc)) throw new Error('Draft restore changed the live snapshot')

  const stale = await post('/dsh-node-flow/workflow-versions', { action: 'restore', id, versionId: draftVersion.id, publish: true, expectedRevision: current.revision - 1 })
  if (stale.response.status !== 409) throw new Error(`Stale restore was not rejected: ${stale.response.status}`)

  result = await post('/dsh-node-flow/workflow-versions', { action: 'restore', id, versionId: draftVersion.id, publish: true, expectedRevision: current.revision })
  if (!result.response.ok) throw new Error(result.data.error || `Published restore failed: ${result.response.status}`)
  current = result.data.workflow
  if (current.publishedRevision !== current.draftRevision || current.publishedDoc.nodes[1]?.data.label !== '历史结果') throw new Error('Historical publish snapshot was not restored')

  result = await requestJson(`/dsh-node-flow/workflow-versions?workflowId=${encodeURIComponent(id)}`)
  if (!result.response.ok || result.data.versions.length !== 5) throw new Error(`Expected 5 versions after restores: ${JSON.stringify(result.data)}`)
  console.log(JSON.stringify({ ok: true, versions: result.data.versions.length, draftIsolation: true, conflictProtection: true, historicalPublish: true }, null, 2))
} finally {
  if (current) await post('/dsh-node-flow/workflows', { action: 'delete', id, expectedRevision: current.revision }).catch(() => undefined)
}

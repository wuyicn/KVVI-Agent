const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
if (!baseUrl) throw new Error('DSH_WEB_URL is required')

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowIds = new Set()
const folderIds = new Set()

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

function documentOf(name, label = 'Output') {
  return {
    version: 1,
    name,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'output', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'output', label, template: '{{result}}' } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'output' }],
  }
}

async function createFolder(name) {
  const result = await post('/dsh-node-flow/workflow-folders', { action: 'create', name })
  if (!result.response.ok || !result.data.folder) throw new Error(result.data.error || `Could not create ${name}`)
  folderIds.add(result.data.folder.id)
  return result.data.folder
}

async function deleteFolder(folder, targetFolderId) {
  const result = await post('/dsh-node-flow/workflow-folders', {
    action: 'delete', id: folder.id, expectedRevision: folder.revision, ...(targetFolderId ? { targetFolderId } : {}),
  })
  if (result.response.ok) folderIds.delete(folder.id)
  return result
}

async function createWorkflow(name, folderId) {
  const now = new Date().toISOString()
  const id = `runtime-folder-${suffix}-${workflowIds.size}`
  workflowIds.add(id)
  const result = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: {
      id,
      name,
      folderId,
      status: 'disabled',
      revision: 0,
      draftRevision: 0,
      createdAt: now,
      updatedAt: now,
      doc: documentOf(name),
    },
  })
  if (!result.response.ok || !result.data.workflow) throw new Error(result.data.error || `Could not create ${name}`)
  return result.data.workflow
}

async function cleanup() {
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  for (const workflow of workflows.data.workflows ?? []) {
    if (workflowIds.has(workflow.id)) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflow.id, expectedRevision: workflow.revision }).catch(() => undefined)
  }
  const folders = await requestJson('/dsh-node-flow/workflow-folders').catch(() => ({ data: { folders: [] } }))
  for (const folder of folders.data.folders ?? []) {
    if (folderIds.has(folder.id)) await deleteFolder(folder).catch(() => undefined)
  }
}

function findAudit(events, action, id) {
  return events.find((event) => event.action === action && event.target?.id === id)
}

try {
  await cleanup()
  const health = await requestJson('/dsh-node-flow/workflows')
  if (!health.response.ok || health.data.capabilities?.workflowFolders !== true) throw new Error('Workflow-folder capability is unavailable')

  const source = await createFolder(`Folder source ${suffix}`)
  const destination = await createFolder(`Folder destination ${suffix}`)
  const duplicate = await post('/dsh-node-flow/workflow-folders', { action: 'create', name: `  Folder source ${suffix}  ` })
  if (duplicate.response.status !== 400) throw new Error(`Duplicate folder returned ${duplicate.response.status}`)

  const renamed = await post('/dsh-node-flow/workflow-folders', { action: 'rename', id: source.id, expectedRevision: source.revision, name: `Folder renamed ${suffix}` })
  if (!renamed.response.ok || renamed.data.folder?.revision !== source.revision + 1) throw new Error(`Rename failed: ${JSON.stringify(renamed.data)}`)
  const staleRename = await post('/dsh-node-flow/workflow-folders', { action: 'rename', id: source.id, expectedRevision: source.revision, name: 'Stale rename' })
  if (staleRename.response.status !== 409) throw new Error(`Stale rename returned ${staleRename.response.status}`)
  const activeSource = renamed.data.folder

  let workflow = await createWorkflow(`Folder workflow ${suffix}`, activeSource.id)
  const published = await post('/dsh-node-flow/workflows', { action: 'status', id: workflow.id, status: 'enabled', expectedRevision: workflow.revision })
  if (!published.response.ok || !published.data.workflow?.publishedDoc) throw new Error(published.data.error || 'Could not publish folder workflow')
  workflow = published.data.workflow
  const snapshot = JSON.stringify(workflow.publishedDoc)
  const draftRevision = workflow.draftRevision

  const moved = await post('/dsh-node-flow/workflows', { action: 'move-folder', id: workflow.id, expectedRevision: workflow.revision, folderId: destination.id })
  if (!moved.response.ok || moved.data.workflow?.folderId !== destination.id) throw new Error(`Move failed: ${JSON.stringify(moved.data)}`)
  workflow = moved.data.workflow
  if (workflow.draftRevision !== draftRevision || JSON.stringify(workflow.publishedDoc) !== snapshot) throw new Error('Moving changed the editable or published execution snapshot')
  const staleMove = await post('/dsh-node-flow/workflows', { action: 'move-folder', id: workflow.id, expectedRevision: workflow.revision - 1 })
  if (staleMove.response.status !== 409) throw new Error(`Stale move returned ${staleMove.response.status}`)

  const deleteDestination = await deleteFolder(destination)
  if (!deleteDestination.response.ok || deleteDestination.data.moved !== 1) throw new Error(`Folder deletion did not move the workflow: ${JSON.stringify(deleteDestination.data)}`)
  folderIds.delete(destination.id)
  const listed = await requestJson('/dsh-node-flow/workflows')
  const listedWorkflow = listed.data.workflows?.find((candidate) => candidate.id === workflow.id)
  if (!listedWorkflow || listedWorkflow.folderId !== undefined || JSON.stringify(listedWorkflow.publishedDoc) !== snapshot) throw new Error('Folder deletion changed execution data or did not uncategorize the workflow')

  const audits = await requestJson('/dsh-node-flow/audit-log?limit=200')
  if (!audits.response.ok || !Array.isArray(audits.data.events)) throw new Error('Could not inspect folder audit events')
  for (const [action, id] of [
    ['folder.created', source.id],
    ['folder.renamed', source.id],
    ['workflow.moved', workflow.id],
    ['folder.deleted', destination.id],
  ]) if (!findAudit(audits.data.events, action, id)) throw new Error(`Missing audit ${action} for ${id}`)
  const auditText = JSON.stringify(audits.data.events)
  if (auditText.includes('template') || auditText.includes('publishedDoc')) throw new Error('Folder audit leaked workflow execution data')

  console.log(JSON.stringify({ ok: true, folders: true, staleConflicts: true, moveIsolation: true, deleteMoves: true, audit: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
}

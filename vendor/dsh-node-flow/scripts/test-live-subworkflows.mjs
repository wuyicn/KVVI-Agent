import { createServer } from 'node:http'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const childId = `live-subflow-child-${suffix}`
const parentId = `live-subflow-parent-${suffix}`
const waitChildId = `live-subflow-wait-child-${suffix}`
const waitParentId = `live-subflow-wait-parent-${suffix}`
const childName = `Live Subflow Child ${suffix}`
const parentName = `Live Subflow Parent ${suffix}`
const runIds = new Set()
let releaseRequest = () => {}
let notifyRequestStarted = () => {}
let requestStarted = Promise.resolve()

function waitForNextRequest() {
  requestStarted = new Promise((resolve) => { notifyRequestStarted = resolve })
}

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

function childDocument(url, version) {
  return {
    version: 1,
    name: childName,
    inputs: [{ name: 'customer', label: '客户', type: 'object', required: true }],
    outputs: [{ name: 'message', type: 'string', required: true }, { name: 'version', type: 'number', required: true }],
    nodes: [
      { id: 'child-trigger', type: 'workflow', position: { x: 60, y: 160 }, data: { kind: 'trigger', label: '子流程入口' } },
      { id: 'child-http', type: 'workflow', position: { x: 340, y: 160 }, data: { kind: 'http', label: `子流程 v${version}`, httpMethod: 'GET', url, responseMode: 'json', failOnHttpError: true } },
    ],
    edges: [{ id: 'child-edge', source: 'child-trigger', target: 'child-http', type: 'workflow' }],
  }
}

function parentDocument() {
  return {
    version: 1,
    name: parentName,
    nodes: [
      { id: 'parent-trigger', type: 'workflow', position: { x: 60, y: 160 }, data: { kind: 'trigger', label: '父流程入口' } },
      { id: 'parent-call', type: 'workflow', position: { x: 340, y: 160 }, data: { kind: 'call-workflow', label: '调用子流程', workflowId: childId, inputTemplate: '{"customer":{{result.source}}}' } },
      { id: 'parent-output', type: 'workflow', position: { x: 620, y: 160 }, data: { kind: 'output', label: '父流程输出', template: '{{result.message}} · v{{result.version}}' } },
    ],
    edges: [
      { id: 'parent-edge-1', source: 'parent-trigger', target: 'parent-call', type: 'workflow' },
      { id: 'parent-edge-2', source: 'parent-call', target: 'parent-output', type: 'workflow' },
    ],
  }
}

function waitChildDocument(mode = 'callback') {
  return {
    version: 1,
    name: `${childName} Wait`,
    nodes: [
      { id: 'wait-trigger', type: 'workflow', position: { x: 60, y: 160 }, data: { kind: 'trigger', label: '等待子流程入口' } },
      { id: 'wait-node', type: 'workflow', position: { x: 340, y: 160 }, data: { kind: 'wait', label: '子流程等待', waitMode: mode } },
      { id: 'wait-output', type: 'workflow', position: { x: 620, y: 160 }, data: { kind: 'output', label: '子流程完成', template: '{{result.event}}' } },
    ],
    edges: [
      { id: 'wait-edge-1', source: 'wait-trigger', target: 'wait-node', type: 'workflow' },
      { id: 'wait-edge-2', source: 'wait-node', target: 'wait-output', type: 'workflow' },
    ],
  }
}

function waitParentDocument() {
  return {
    version: 1,
    name: `${parentName} Wait`,
    nodes: [
      { id: 'wait-parent-trigger', type: 'workflow', position: { x: 60, y: 160 }, data: { kind: 'trigger', label: '父流程入口' } },
      { id: 'wait-parent-call', type: 'workflow', position: { x: 340, y: 160 }, data: { kind: 'call-workflow', label: '等待子流程', workflowId: waitChildId } },
      { id: 'wait-parent-output', type: 'workflow', position: { x: 620, y: 160 }, data: { kind: 'output', label: '父流程完成', template: '{{result}}' } },
    ],
    edges: [
      { id: 'wait-parent-edge-1', source: 'wait-parent-trigger', target: 'wait-parent-call', type: 'workflow' },
      { id: 'wait-parent-edge-2', source: 'wait-parent-call', target: 'wait-parent-output', type: 'workflow' },
    ],
  }
}

async function createWorkflow(id, name, doc) {
  const now = new Date().toISOString()
  const result = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: 0, workflow: { id, name, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc } })
  if (!result.response.ok) throw new Error(result.data.error || `Create ${name} failed`)
  return result.data.workflow
}

async function saveAndPublish(workflow, doc) {
  let result = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: workflow.revision, workflow: { ...workflow, doc } })
  if (!result.response.ok) throw new Error(result.data.error || `Save ${workflow.name} failed`)
  result = await post('/dsh-node-flow/workflows', { action: 'status', id: workflow.id, status: 'enabled', expectedRevision: result.data.workflow.revision })
  if (!result.response.ok) throw new Error(result.data.error || `Publish ${workflow.name} failed`)
  return result.data.workflow
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs || []) {
    if (runIds.has(run.id) || [childId, parentId, waitChildId, waitParentId].includes(run.workflowId)) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  for (const id of [parentId, childId, waitParentId, waitChildId]) {
    const workflow = (workflows.data.workflows || []).find((candidate) => candidate.id === id)
    if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id, expectedRevision: workflow.revision }).catch(() => undefined)
  }
}

async function waitForRun(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await requestJson('/dsh-node-flow/runs')
    const match = (result.data.runs || []).find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for persisted subworkflow run')
}

const server = createServer((request, response) => {
  const path = new URL(request.url || '/', 'http://127.0.0.1').pathname
  const version = path.includes('v2') || path.includes('cancel') ? 2 : 1
  notifyRequestStarted()
  const delay = path.includes('cancel') ? 10_000 : 250
  const timer = setTimeout(() => {
    if (response.destroyed) return
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ message: version === 1 ? 'snapshot-v1' : 'published-v2', version }))
  }, delay)
  releaseRequest = () => {
    clearTimeout(timer)
    if (!response.destroyed) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: version === 1 ? 'snapshot-v1' : 'published-v2', version }))
    }
  }
  response.on('close', () => clearTimeout(timer))
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let child
let parent
try {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Subworkflow test server did not expose a TCP port')
  const origin = `http://127.0.0.1:${address.port}`
  const health = await requestJson('/dsh-node-flow/workflows')
  if (health.data.capabilities?.subworkflows !== true) throw new Error('Running backend does not expose subworkflow capability')
  await cleanup()

  child = await createWorkflow(childId, childName, childDocument(`${origin}/v1`, 1))
  child = await saveAndPublish(child, child.doc)
  parent = await createWorkflow(parentId, parentName, parentDocument())
  parent = await saveAndPublish(parent, parent.doc)

  const firstRunId = `live-subflow-first-${suffix}`
  runIds.add(firstRunId)
  waitForNextRequest()
  const firstRunPromise = post('/dsh-node-flow/workflows', { action: 'run', id: parentId, runId: firstRunId, input: { source: { name: 'Ada' } } })
  await requestStarted
  child = await saveAndPublish(child, childDocument(`${origin}/v2`, 2))
  releaseRequest()
  const firstRun = await firstRunPromise
  if (!firstRun.response.ok || firstRun.data.run?.value !== 'snapshot-v1 · v1') throw new Error(`Frozen snapshot execution failed: ${JSON.stringify(firstRun.data)}`)

  const firstCall = firstRun.data.run.nodes.find((node) => node.id === 'parent-call')
  if (!firstCall?.childRunId || firstCall.output?.version !== 1) throw new Error('Parent call node did not persist structured child output')
  runIds.add(firstCall.childRunId)
  const persisted = await requestJson('/dsh-node-flow/runs')
  const childRun = persisted.data.runs.find((run) => run.id === firstCall.childRunId)
  if (childRun?.parentRunId !== firstRunId || childRun?.rootRunId !== firstRunId || childRun?.parentNodeId !== 'parent-call' || childRun?.depth !== 1) throw new Error(`Nested run linkage failed: ${JSON.stringify(childRun)}`)

  const secondRunId = `live-subflow-second-${suffix}`
  runIds.add(secondRunId)
  const secondRun = await post('/dsh-node-flow/workflows', { action: 'run', id: parentId, runId: secondRunId, input: { source: { name: 'Ada' } } })
  if (!secondRun.response.ok || secondRun.data.run?.value !== 'published-v2 · v2') throw new Error('Next parent run did not use the newly published child snapshot')
  const secondCall = secondRun.data.run.nodes.find((node) => node.id === 'parent-call')
  if (secondCall?.childRunId) runIds.add(secondCall.childRunId)

  const protectedDisable = await post('/dsh-node-flow/workflows', { action: 'status', id: childId, status: 'disabled', expectedRevision: child.revision })
  if (protectedDisable.response.status !== 409) throw new Error(`Referenced child workflow could be disabled: ${protectedDisable.response.status}`)

  let recursive = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: parent.revision, workflow: { ...parent, doc: { ...parent.doc, nodes: parent.doc.nodes.map((node) => node.id === 'parent-call' ? { ...node, data: { ...node.data, workflowId: parentId } } : node) } } })
  if (!recursive.response.ok) throw new Error(recursive.data.error || 'Recursive draft save failed')
  parent = recursive.data.workflow
  recursive = await post('/dsh-node-flow/workflows', { action: 'status', id: parentId, status: 'enabled', expectedRevision: parent.revision })
  if (recursive.response.status !== 400 || !String(recursive.data.error).includes('递归')) throw new Error(`Recursive publish was not rejected: ${JSON.stringify(recursive.data)}`)

  let restored = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: parent.revision, workflow: { ...parent, doc: parentDocument() } })
  if (!restored.response.ok) throw new Error(restored.data.error || 'Parent restore save failed')
  restored = await post('/dsh-node-flow/workflows', { action: 'status', id: parentId, status: 'enabled', expectedRevision: restored.data.workflow.revision })
  if (!restored.response.ok) throw new Error(restored.data.error || 'Parent restore publish failed')
  parent = restored.data.workflow
  child = await saveAndPublish(child, childDocument(`${origin}/cancel`, 2))

  const cancelRunId = `live-subflow-cancel-${suffix}`
  runIds.add(cancelRunId)
  waitForNextRequest()
  const cancelPromise = post('/dsh-node-flow/workflows', { action: 'run', id: parentId, runId: cancelRunId, input: { source: { name: 'Ada' } } })
  await requestStarted
  const cancelled = await post('/dsh-node-flow/workflows', { action: 'cancel', runId: cancelRunId })
  if (!cancelled.response.ok) throw new Error(cancelled.data.error || 'Parent cancellation failed')
  const cancelResult = await cancelPromise
  if (cancelResult.data.run?.status !== 'cancelled') throw new Error(`Parent run was not cancelled: ${JSON.stringify(cancelResult.data.run)}`)
  const runsAfterCancel = await requestJson('/dsh-node-flow/runs')
  const cancelledChild = runsAfterCancel.data.runs.find((run) => run.parentRunId === cancelRunId)
  if (!cancelledChild || cancelledChild.status !== 'cancelled' || cancelledChild.resumable) throw new Error(`Child cancellation did not propagate: ${JSON.stringify(cancelledChild)}`)
  runIds.add(cancelledChild.id)

  let waitChild = await createWorkflow(waitChildId, `${childName} Wait`, waitChildDocument('callback'))
  waitChild = await saveAndPublish(waitChild, waitChild.doc)
  let waitParent = await createWorkflow(waitParentId, `${parentName} Wait`, waitParentDocument())
  waitParent = await saveAndPublish(waitParent, waitParent.doc)
  const waitParentRunId = `live-subflow-wait-parent-run-${suffix}`
  runIds.add(waitParentRunId)
  const waitingParent = await post('/dsh-node-flow/workflows', { action: 'run', id: waitParentId, runId: waitParentRunId, input: { event: 'ready' } })
  if (waitingParent.response.status !== 202 || waitingParent.data.run?.status !== 'waiting' || waitingParent.data.run?.waitpoint?.mode !== 'child') {
    throw new Error(`Parent did not persist child waitpoint: ${JSON.stringify(waitingParent.data)}`)
  }
  const waitChildRunId = waitingParent.data.run.waitpoint.childRunId
  if (!waitChildRunId) throw new Error('Parent child waitpoint did not include child run ID')
  runIds.add(waitChildRunId)
  const waitRuns = await requestJson('/dsh-node-flow/runs')
  const waitingChild = waitRuns.data.runs.find((run) => run.id === waitChildRunId)
  if (!waitingChild || waitingChild.status !== 'waiting' || waitingChild.waitpoint?.mode !== 'callback' || waitingChild.parentRunId !== waitParentRunId || waitingChild.parentNodeId !== 'wait-parent-call') {
    throw new Error(`Child waitpoint linkage failed: ${JSON.stringify(waitingChild)}`)
  }
  const waitToken = await post('/dsh-node-flow/runs', { action: 'create-wait-token', id: waitChildRunId })
  if (!waitToken.response.ok || !waitToken.data.token) throw new Error(`Child callback token creation failed: ${JSON.stringify(waitToken.data)}`)
  const resumedChild = await fetch(`${baseUrl}/dsh-node-flow/waitpoint-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, 'x-dsh-wait-token': waitToken.data.token },
    body: JSON.stringify({ event: 'child-ready' }),
  })
  if (resumedChild.status !== 200 && resumedChild.status !== 202) throw new Error(`Child callback failed: ${resumedChild.status}`)
  const completedParent = await waitForRun((run) => run.id !== waitParentRunId && run.resumedFromRunId === waitParentRunId && run.status === 'ok')
  if (completedParent.value !== 'child-ready' || completedParent.workflowId !== waitParentId) throw new Error(`Parent did not continue after child wait: ${JSON.stringify(completedParent)}`)

  const waitParentCancelRunId = `live-subflow-wait-cancel-${suffix}`
  runIds.add(waitParentCancelRunId)
  const waitingForCancel = await post('/dsh-node-flow/workflows', { action: 'run', id: waitParentId, runId: waitParentCancelRunId, input: { event: 'cancel' } })
  if (waitingForCancel.response.status !== 202) throw new Error(`Child wait cancellation setup failed: ${JSON.stringify(waitingForCancel.data)}`)
  const cancelChildId = waitingForCancel.data.run?.waitpoint?.childRunId
  if (!cancelChildId) throw new Error('Missing child run for parent cancellation')
  runIds.add(cancelChildId)
  const waitCancel = await post('/dsh-node-flow/workflows', { action: 'cancel', runId: waitParentCancelRunId })
  if (!waitCancel.response.ok) throw new Error(`Waiting parent cancellation failed: ${JSON.stringify(waitCancel.data)}`)
  const cancelledWaitChild = await waitForRun((run) => run.id === cancelChildId && run.status === 'cancelled')
  if (cancelledWaitChild.resumable) throw new Error('Cancelled waiting child remained resumable')

  console.log(JSON.stringify({ ok: true, snapshotIsolation: true, nestedRunLinkage: true, referenceProtection: true, recursionProtection: true, cancellationPropagation: true, childWaitpointResume: true, childWaitpointCancellation: true }, null, 2))
} finally {
  releaseRequest()
  await cleanup().catch(() => undefined)
  await new Promise((resolve) => server.close(() => resolve()))
}

import { createServer } from 'node:http'

if (process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME !== '1') {
  throw new Error('Workflow concurrency regression must run against the isolated runtime harness')
}

const baseUrl = process.env.DSH_WEB_URL
if (!baseUrl) throw new Error('DSH_WEB_URL is required')

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const runningWorkflowId = `runtime-concurrency-running-${suffix}`
const concurrentWorkflowId = `runtime-concurrency-created-${suffix}`
let releaseGate
let markGateReached
const gateReleased = new Promise((resolve) => { releaseGate = resolve })
const gateReached = new Promise((resolve) => { markGateReached = resolve })

const gateServer = createServer((_request, response) => {
  markGateReached()
  void gateReleased.then(() => {
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true }))
  })
})

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
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

function workflow(id, name, nodes, edges = []) {
  const now = new Date().toISOString()
  return {
    id,
    name,
    status: 'disabled',
    revision: 0,
    draftRevision: 0,
    createdAt: now,
    updatedAt: now,
    doc: { version: 1, name, nodes, edges },
  }
}

async function waitForGate() {
  let timeout
  try {
    await Promise.race([
      gateReached,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Timed out waiting for blocked workflow node')), 5_000) }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

await new Promise((resolve) => gateServer.listen(0, '127.0.0.1', resolve))
try {
  const address = gateServer.address()
  if (!address || typeof address === 'string') throw new Error('Gate server did not expose a TCP port')

  const trigger = { id: 'trigger', type: 'workflow', position: { x: 80, y: 160 }, data: { kind: 'trigger', label: 'Start' } }
  const http = {
    id: 'http',
    type: 'workflow',
    position: { x: 360, y: 160 },
    data: {
      kind: 'http',
      label: 'Blocked request',
      httpMethod: 'GET',
      url: `http://127.0.0.1:${address.port}/gate`,
      responseMode: 'json',
      failOnHttpError: true,
      onError: 'stop',
    },
  }
  const created = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: workflow(runningWorkflowId, 'Concurrent running workflow', [trigger, http], [{ id: 'edge', source: 'trigger', target: 'http' }]),
  })
  if (created.workflow?.id !== runningWorkflowId) throw new Error('Running workflow was not created')

  const runRequest = post('/dsh-node-flow/workflows', {
    action: 'run',
    id: runningWorkflowId,
    runId: `runtime-concurrency-run-${suffix}`,
    input: 'concurrency-test',
  })
  await waitForGate()

  const concurrent = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: workflow(concurrentWorkflowId, 'Workflow created during run', [trigger]),
  })
  if (concurrent.workflow?.id !== concurrentWorkflowId) throw new Error('Concurrent workflow was not created')

  releaseGate()
  const completed = await runRequest
  if (completed.run?.status !== 'ok') throw new Error(`Blocked workflow did not finish: ${JSON.stringify(completed.run)}`)

  const listed = await requestJson('/dsh-node-flow/workflows')
  const running = listed.workflows?.find((candidate) => candidate.id === runningWorkflowId)
  const preserved = listed.workflows?.find((candidate) => candidate.id === concurrentWorkflowId)
  if (!running?.lastRunAt) throw new Error('Run metadata was not merged into the running workflow')
  if (!preserved) throw new Error('Concurrent workflow was lost when run metadata was persisted')

  console.log(JSON.stringify({ ok: true, workflowsPreserved: true, lastRunMerged: true }, null, 2))
} finally {
  releaseGate?.()
  await new Promise((resolve) => gateServer.close(() => resolve()))
}

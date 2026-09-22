import { createServer } from 'node:http'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-resilience-${suffix}`
const workflowName = `Live Resilience ${suffix}`
const firstRunId = `live-retry-${suffix}`
const failedRunId = `live-failure-${suffix}`
const resumedRunId = `live-resume-${suffix}`
const runIds = new Set([firstRunId, failedRunId, resumedRunId])
let mode = 'retry'
let requestCount = 0

const server = createServer((_request, response) => {
  requestCount += 1
  const succeeds = mode === 'success' || (mode === 'retry' && requestCount >= 3)
  response.statusCode = succeeds ? 200 : 503
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ ok: succeeds, requestCount, mode }))
})

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

async function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ runs: [] }))
  for (const run of runs.runs || []) {
    if (runIds.has(run.id) || run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => {})
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ workflows: [] }))
  const workflow = (workflows.workflows || []).find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => {})
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Echo server did not expose a TCP port')
  const health = await requestJson('/dsh-node-flow/workflows')
  if (health.capabilities?.runRetries !== true || health.capabilities?.runRecovery !== true) throw new Error('Running backend does not expose resilience capabilities')
  await cleanup()
  const doc = {
    version: 1,
    name: workflowName,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 160 }, data: { kind: 'trigger', label: '开始' } },
      {
        id: 'http',
        type: 'workflow',
        position: { x: 360, y: 160 },
        data: {
          kind: 'http',
          label: '可靠请求',
          httpMethod: 'GET',
          url: `http://127.0.0.1:${address.port}/health`,
          failOnHttpError: true,
          responseMode: 'json',
          retryCount: '2',
          retryDelay: '0',
          retryBackoff: 'exponential',
          onError: 'stop',
        },
      },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'http' }],
  }
  const created = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: { id: workflowId, name: workflowName, status: 'disabled', revision: 0, draftRevision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), doc },
  })
  if (created.workflow?.id !== workflowId) throw new Error('Temporary workflow was not created')

  requestCount = 0
  mode = 'retry'
  const retried = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId: firstRunId, input: 'retry-test' })
  const retriedNode = retried.run?.nodes?.find((node) => node.id === 'http')
  if (retried.run?.status !== 'ok' || retriedNode?.attempts !== 3 || requestCount !== 3) throw new Error(`Retry execution failed: ${JSON.stringify({ run: retried.run, requestCount })}`)

  requestCount = 0
  mode = 'fail'
  const failed = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId: failedRunId, input: 'resume-test' })
  if (failed.run?.status !== 'error' || failed.run?.resumable !== true || failed.run?.checkpoint?.nodeId !== 'http') throw new Error(`Failure checkpoint was not persisted: ${JSON.stringify(failed.run)}`)

  mode = 'success'
  requestCount = 0
  const resumed = await post('/dsh-node-flow/runs', { action: 'resume', id: failedRunId, runId: resumedRunId })
  if (resumed.run?.status !== 'ok' || resumed.run?.resumedFromRunId !== failedRunId || requestCount !== 1) throw new Error(`Resume execution failed: ${JSON.stringify({ run: resumed.run, requestCount })}`)
  const persisted = await requestJson('/dsh-node-flow/runs')
  const source = persisted.runs?.find((run) => run.id === failedRunId)
  if (source?.resumedByRunId !== resumedRunId || source?.resumable !== false) throw new Error('Source run was not claimed exactly once')

  console.log(JSON.stringify({ ok: true, retryAttempts: retriedNode.attempts, checkpointNode: failed.run.checkpoint.nodeId, resumedFrom: resumed.run.resumedFromRunId }, null, 2))
} finally {
  await cleanup().catch(() => {})
  await new Promise((resolve) => server.close(() => resolve()))
}

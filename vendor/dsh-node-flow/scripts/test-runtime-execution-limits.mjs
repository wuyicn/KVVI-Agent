import { createServer } from 'node:http'

if (process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME !== '1') {
  throw new Error('Execution-limit regression must run against the isolated runtime harness')
}

const baseUrl = process.env.DSH_WEB_URL
if (!baseUrl) throw new Error('DSH_WEB_URL is required')

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const stepsWorkflowId = `runtime-limits-steps-${suffix}`
const durationWorkflowId = `runtime-limits-duration-${suffix}`
const stepsRunId = `runtime-limits-steps-run-${suffix}`
const stepsResumeId = `runtime-limits-steps-resume-${suffix}`
const durationRunId = `runtime-limits-duration-run-${suffix}`
const runIds = new Set([stepsRunId, stepsResumeId, durationRunId])
const workflowIds = new Set([stepsWorkflowId, durationWorkflowId])

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

function workflow(id, name, doc) {
  const now = new Date().toISOString()
  return {
    id,
    name,
    status: 'disabled',
    revision: 0,
    draftRevision: 0,
    createdAt: now,
    updatedAt: now,
    doc,
  }
}

async function saveWorkflow(id, name, doc) {
  const result = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: workflow(id, name, doc),
  })
  if (!result.response.ok || !result.data.workflow) throw new Error(result.data.error || `Could not save ${name}`)
  return result.data.workflow
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs || []) {
    if (runIds.has(run.id) || workflowIds.has(run.workflowId)) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  for (const workflowRecord of workflows.data.workflows || []) {
    if (workflowIds.has(workflowRecord.id)) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowRecord.id, expectedRevision: workflowRecord.revision }).catch(() => undefined)
  }
}

const delayed = createServer((_request, response) => {
  setTimeout(() => {
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ delayed: true }))
  }, 1_500)
})

await new Promise((resolve) => delayed.listen(0, '127.0.0.1', resolve))
try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.data.capabilities?.executionLimits !== true) throw new Error('Running backend does not expose execution limits')

  const stepsName = `Runtime Step Limits ${suffix}`
  const stepsDoc = {
    version: 1,
    name: stepsName,
    executionLimits: { maxSteps: 1 },
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 160 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'output', type: 'workflow', position: { x: 360, y: 160 }, data: { kind: 'output', label: 'Output', template: '{{result}}' } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'output' }],
  }
  await saveWorkflow(stepsWorkflowId, stepsName, stepsDoc)
  const limited = await post('/dsh-node-flow/workflows', { action: 'run', id: stepsWorkflowId, runId: stepsRunId, input: 'step-budget' })
  const limitedRun = limited.data.run
  if (!limited.response.ok || limitedRun?.status !== 'error' || limitedRun.timedOut !== true || limitedRun.limitReason !== 'steps' || limitedRun.checkpoint?.nodeId !== 'output' || limitedRun.resumable !== true) {
    throw new Error(`Step limit did not persist a resumable checkpoint: ${JSON.stringify(limited.data)}`)
  }
  const limitedNode = limitedRun.nodes?.find((node) => node.id === 'output')
  if (limitedNode?.status !== 'error' || !String(limitedNode.error || '').includes('步数')) throw new Error(`Limited node was not recorded: ${JSON.stringify(limitedRun)}`)

  const resumed = await post('/dsh-node-flow/runs', { action: 'resume', id: stepsRunId, runId: stepsResumeId })
  if (!resumed.response.ok || resumed.data.run?.status !== 'ok' || resumed.data.run?.resumedFromRunId !== stepsRunId || resumed.data.run?.value !== 'step-budget') {
    throw new Error(`Step-limited workflow did not resume from its checkpoint: ${JSON.stringify(resumed.data)}`)
  }

  const address = delayed.address()
  if (!address || typeof address === 'string') throw new Error('Delayed server did not expose a TCP port')
  const durationName = `Runtime Duration Limits ${suffix}`
  const durationDoc = {
    version: 1,
    name: durationName,
    executionLimits: { maxDurationSec: 1 },
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 160 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'http', type: 'workflow', position: { x: 360, y: 160 }, data: { kind: 'http', label: 'Delayed request', httpMethod: 'GET', url: `http://127.0.0.1:${address.port}/delay`, failOnHttpError: true, responseMode: 'json', onError: 'stop' } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'http' }],
  }
  await saveWorkflow(durationWorkflowId, durationName, durationDoc)
  const timed = await post('/dsh-node-flow/workflows', { action: 'run', id: durationWorkflowId, runId: durationRunId, input: 'duration-budget' })
  const timedRun = timed.data.run
  if (!timed.response.ok || timedRun?.status !== 'error' || timedRun.timedOut !== true || timedRun.limitReason !== 'duration' || timedRun.checkpoint?.nodeId !== 'http' || timedRun.resumable !== true) {
    throw new Error(`Duration limit did not produce the expected run: ${JSON.stringify(timed.data)}`)
  }

  const summary = await requestJson('/dsh-node-flow/runs?view=summary')
  const summaryRun = summary.data.runs?.find((run) => run.id === durationRunId)
  if (!summary.response.ok || summaryRun?.timedOut !== true || summaryRun?.limitReason !== 'duration' || Object.prototype.hasOwnProperty.call(summaryRun || {}, 'nodes')) {
    throw new Error(`Execution-limit summary was incorrect: ${JSON.stringify(summaryRun)}`)
  }

  console.log(JSON.stringify({ ok: true, stepLimit: true, checkpointRecovery: true, durationLimit: true, summary: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
  await new Promise((resolve) => delayed.close(() => resolve()))
}

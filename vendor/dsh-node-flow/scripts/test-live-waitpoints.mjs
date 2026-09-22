import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowIds = new Set()

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

async function createWorkflow(label, nodes, edges) {
  const id = `live-wait-${label}-${suffix}`
  workflowIds.add(id)
  const now = new Date().toISOString()
  const doc = { version: 1, name: id, nodes, edges }
  const saved = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: { id, name: id, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc },
  })
  if (!saved.response.ok) throw new Error(saved.data.error || `Could not create ${id}`)
  return saved.data.workflow
}

async function runWorkflow(workflow, input) {
  const runId = `wait-run-${workflow.id}-${Math.random().toString(36).slice(2, 7)}`
  const result = await post('/dsh-node-flow/workflows', { action: 'run', id: workflow.id, runId, input })
  if (!result.response.ok) throw new Error(result.data.error || `Could not run ${workflow.id}`)
  return result.data.run
}

async function waitForRun(predicate, timeout = 6000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const listed = await requestJson('/dsh-node-flow/runs')
    const run = listed.data.runs?.find(predicate)
    if (run) return run
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('Timed out waiting for persisted continuation')
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) {
    if (workflowIds.has(run.workflowId)) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  for (const workflow of workflows.data.workflows ?? []) {
    if (workflowIds.has(workflow.id)) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflow.id, expectedRevision: workflow.revision }).catch(() => undefined)
  }
}

try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.data.capabilities?.waitpoints !== true || capabilities.data.capabilities?.waitpointCallbacks !== true || capabilities.data.capabilities?.approvals !== true) {
    throw new Error('Running backend does not expose waitpoint capabilities')
  }

  const chained = await createWorkflow('chain', [
    { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
    { id: 'callback', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'wait', label: 'Callback', waitMode: 'callback', waitTimeout: '1' } },
    { id: 'delay', type: 'workflow', position: { x: 480, y: 0 }, data: { kind: 'wait', label: 'Delay', waitMode: 'delay', waitAmount: '0.05', waitUnit: 'seconds' } },
    { id: 'output', type: 'workflow', position: { x: 720, y: 0 }, data: { kind: 'output', label: 'Done', template: 'callback:{{result.event}}' } },
  ], [
    { id: 'e1', source: 'trigger', target: 'callback' },
    { id: 'e2', source: 'callback', target: 'delay' },
    { id: 'e3', source: 'delay', target: 'output' },
  ])
  const waiting = await runWorkflow(chained, { initial: true })
  if (waiting.status !== 'waiting' || waiting.waitpoint?.mode !== 'callback' || waiting.waitpoint?.tokenHash) throw new Error(`Callback wait was not persisted safely: ${JSON.stringify(waiting)}`)

  const issued = await post('/dsh-node-flow/runs', { action: 'create-wait-token', id: waiting.id })
  if (!issued.response.ok || !issued.data.token) throw new Error(`Callback token was not issued: ${JSON.stringify(issued.data)}`)
  const token = issued.data.token
  const visibleRuns = await requestJson('/dsh-node-flow/runs')
  if (JSON.stringify(visibleRuns.data).includes(token) || JSON.stringify(visibleRuns.data).includes('tokenHash')) throw new Error('Callback token material leaked through the runs API')
  if (process.env.DSH_HOME && readFileSync(join(process.env.DSH_HOME, 'workflow-canvas', 'runs.json'), 'utf8').includes(token)) throw new Error('Plaintext callback token was persisted')

  const wrong = await fetch(`${baseUrl}/dsh-node-flow/waitpoint-callback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-wait-token': 'x'.repeat(43) }, body: '{"event":"wrong"}' })
  if (wrong.status !== 404) throw new Error(`Wrong callback token returned ${wrong.status}`)
  const callback = await fetch(`${baseUrl}/dsh-node-flow/waitpoint-callback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-wait-token': token }, body: '{"event":"ready"}' })
  const callbackData = await callback.json()
  if (callback.status !== 202 || callbackData.status !== 'waiting' || !callbackData.runId || callbackData.run || callbackData.waitpoint) throw new Error(`Callback did not return a minimal waiting receipt: ${JSON.stringify(callbackData)}`)
  const replay = await fetch(`${baseUrl}/dsh-node-flow/waitpoint-callback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-wait-token': token }, body: '{"event":"replay"}' })
  if (replay.status !== 404) throw new Error(`Callback token replay returned ${replay.status}`)
  const chainedDone = await waitForRun((run) => run.resumedFromRunId === callbackData.runId && run.status === 'ok')
  if (chainedDone.value !== 'callback:ready' || chainedDone.nodes.filter((node) => ['trigger', 'callback', 'delay', 'output'].includes(node.id)).length !== 4) throw new Error(`Chained wait lost graph state: ${JSON.stringify(chainedDone)}`)

  const approval = await createWorkflow('approval', [
    { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
    { id: 'approval', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'wait', label: 'Approve', waitMode: 'approval' } },
    { id: 'output', type: 'workflow', position: { x: 480, y: 0 }, data: { kind: 'output', label: 'Done', template: '{{result.decision}}:{{result.note}}' } },
  ], [{ id: 'e1', source: 'trigger', target: 'approval' }, { id: 'e2', source: 'approval', target: 'output' }])
  const approvalWait = await runWorkflow(approval, 'review')
  const resolved = await post('/dsh-node-flow/runs', { action: 'resolve-waitpoint', id: approvalWait.id, decision: 'approved', note: 'ship it' })
  if (!resolved.response.ok || resolved.data.run?.value !== 'approved:ship it') throw new Error(`Approval did not resume: ${JSON.stringify(resolved.data)}`)
  const doubleApproval = await post('/dsh-node-flow/runs', { action: 'resolve-waitpoint', id: approvalWait.id, decision: 'rejected', note: '' })
  if (doubleApproval.response.status !== 409) throw new Error('Approval was consumed more than once')

  const timeout = await createWorkflow('timeout', [
    { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
    { id: 'callback', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'wait', label: 'Timeout', waitMode: 'callback', waitTimeout: '0.0001', waitTimeoutValue: '{"kind":"timeout"}' } },
    { id: 'output', type: 'workflow', position: { x: 480, y: 0 }, data: { kind: 'output', label: 'Done', template: '{{result.kind}}' } },
  ], [{ id: 'e1', source: 'trigger', target: 'callback' }, { id: 'e2', source: 'callback', target: 'output' }])
  const timeoutWait = await runWorkflow(timeout, 'timeout-input')
  const timeoutDone = await waitForRun((run) => run.resumedFromRunId === timeoutWait.id && run.status === 'ok')
  if (timeoutDone.value !== 'timeout') throw new Error(`Wait timeout did not resume: ${JSON.stringify(timeoutDone)}`)

  const cancelled = await createWorkflow('cancel', [
    { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
    { id: 'callback', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'wait', label: 'Callback', waitMode: 'callback' } },
  ], [{ id: 'e1', source: 'trigger', target: 'callback' }])
  const cancelWait = await runWorkflow(cancelled, 'cancel-input')
  const cancelResult = await post('/dsh-node-flow/workflows', { action: 'cancel', runId: cancelWait.id })
  if (!cancelResult.response.ok) throw new Error(cancelResult.data.error || 'Could not cancel waiting run')
  const cancelledRun = await waitForRun((run) => run.id === cancelWait.id && run.status === 'cancelled')
  if (cancelledRun.waitpoint) throw new Error('Cancelled run retained an active waitpoint')

  console.log(JSON.stringify({ ok: true, chainedWaits: true, callbackTokenSingleUse: true, approval: true, timeout: true, cancellation: true, tokenHidden: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
}

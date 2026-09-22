import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `runtime-debug-${suffix}`
const firstRunId = `debug-source-${suffix}`
const continueRunId = `debug-continue-${suffix}`
const stepRunId = `debug-step-${suffix}`
const finishRunId = `debug-finish-${suffix}`
const cancelRunId = `debug-cancel-${suffix}`
const skippedRunId = `debug-skipped-${suffix}`
const normalRunId = `debug-normal-${suffix}`
const marker = `debug-marker-${suffix}`
const secret = `debug-secret-${suffix}`

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

function documentOf({ changed = false, concurrency } = {}) {
  return {
    version: 1,
    name: `Debugger ${suffix}`,
    ...(concurrency ? { concurrency } : {}),
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'first', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'output', label: 'First', breakpoint: true, template: changed ? `changed:${'{{result.value}}'}` : `first:${'{{result.value}}'}` } },
      { id: 'second', type: 'workflow', position: { x: 480, y: 0 }, data: { kind: 'output', label: 'Second', breakpoint: true, template: `second:${'{{result}}'}` } },
      { id: 'third', type: 'workflow', position: { x: 720, y: 0 }, data: { kind: 'output', label: 'Third', template: `third:${'{{result}}'}` } },
    ],
    edges: [
      { id: 'trigger-first', source: 'trigger', target: 'first' },
      { id: 'first-second', source: 'first', target: 'second' },
      { id: 'second-third', source: 'second', target: 'third' },
    ],
  }
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) {
    if (run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  const workflow = (workflows.data.workflows ?? []).find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
}

try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (!capabilities.response.ok || capabilities.data.capabilities?.debugger !== true) throw new Error('Debugger capability is unavailable')

  const now = new Date().toISOString()
  const created = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: {
      id: workflowId,
      name: `Debugger ${suffix}`,
      status: 'disabled',
      revision: 0,
      draftRevision: 0,
      createdAt: now,
      updatedAt: now,
      doc: documentOf({ concurrency: { mode: 'skip', maxConcurrent: 1 } }),
    },
  })
  if (!created.response.ok || !created.data.workflow) throw new Error(created.data.error || 'Could not create debugger workflow')
  let revision = created.data.workflow.revision

  const started = await post('/dsh-node-flow/workflows', { action: 'debug', id: workflowId, runId: firstRunId, input: { value: marker } })
  if (!started.response.ok || started.data.run?.status !== 'waiting' || started.data.run?.trigger !== 'debug' || started.data.run?.waitpoint?.mode !== 'debug' || started.data.run?.waitpoint?.nodeId !== 'first' || started.data.run?.waitpoint?.debugReason !== 'breakpoint' || started.data.run?.waitpoint?.input !== '[redacted]') {
    throw new Error(`Debugger did not pause before its first breakpoint: ${JSON.stringify(started.data)}`)
  }
  if (started.data.run?.replayInputAvailable !== undefined || started.data.run?.replayInput !== undefined) throw new Error('Debug run incorrectly became replayable')

  const skipped = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId: skippedRunId, input: { value: marker } })
  if (skipped.response.status !== 429 || skipped.data.run?.status !== 'skipped') throw new Error(`Debug pause did not retain its concurrency slot: ${JSON.stringify(skipped.data)}`)

  const changed = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: revision,
    workflow: { ...created.data.workflow, revision, doc: documentOf({ changed: true, concurrency: { mode: 'skip', maxConcurrent: 1 } }) },
  })
  if (!changed.response.ok || !changed.data.workflow) throw new Error(changed.data.error || 'Could not mutate draft during debugger pause')
  revision = changed.data.workflow.revision

  const continued = await post('/dsh-node-flow/runs', { action: 'debug-continue', id: firstRunId, runId: continueRunId })
  const first = continued.data.run?.nodes?.find((node) => node.id === 'first')
  if (!continued.response.ok || continued.data.run?.status !== 'waiting' || continued.data.run?.waitpoint?.nodeId !== 'second' || continued.data.run?.waitpoint?.debugReason !== 'breakpoint' || first?.output !== `first:${marker}` || first?.debugPaused) {
    throw new Error(`Debugger continue did not execute frozen breakpoint node: ${JSON.stringify(continued.data)}`)
  }

  const duplicate = await post('/dsh-node-flow/runs', { action: 'debug-continue', id: firstRunId, runId: `debug-duplicate-${suffix}` })
  if (duplicate.response.status !== 409) throw new Error(`Debugger source accepted a second continuation: ${JSON.stringify(duplicate.data)}`)

  const stepped = await post('/dsh-node-flow/runs', { action: 'debug-step', id: continueRunId, runId: stepRunId })
  const second = stepped.data.run?.nodes?.find((node) => node.id === 'second')
  if (!stepped.response.ok || stepped.data.run?.status !== 'waiting' || stepped.data.run?.waitpoint?.nodeId !== 'third' || stepped.data.run?.waitpoint?.debugReason !== 'step' || stepped.data.run?.waitpoint?.previousNodeId !== 'second' || second?.output !== `second:first:${marker}` || stepped.data.run?.nodes?.some((node) => node.id === 'third' && node.status === 'ok')) {
    throw new Error(`Debugger step did not stop before exactly one successor: ${JSON.stringify(stepped.data)}`)
  }

  const finished = await post('/dsh-node-flow/runs', { action: 'debug-continue', id: stepRunId, runId: finishRunId })
  if (!finished.response.ok || finished.data.run?.status !== 'ok' || finished.data.run?.value !== `third:second:first:${marker}`) {
    throw new Error(`Debugger final continuation was incorrect: ${JSON.stringify(finished.data)}`)
  }

  const detail = await requestJson(`/dsh-node-flow/runs?id=${encodeURIComponent(firstRunId)}`)
  if (!detail.response.ok || detail.data.run?.snapshot !== undefined || detail.data.run?.waitpoint?.input !== '[redacted]') {
    throw new Error(`Debugger detail exposed a private snapshot or wait input: ${JSON.stringify(detail.data)}`)
  }

  const cancelledStart = await post('/dsh-node-flow/workflows', { action: 'debug', id: workflowId, runId: cancelRunId, input: { value: marker } })
  if (!cancelledStart.response.ok || cancelledStart.data.run?.status !== 'waiting') throw new Error('Could not start debugger cancellation case')
  const cancelled = await post('/dsh-node-flow/workflows', { action: 'cancel', runId: cancelRunId })
  if (!cancelled.response.ok) throw new Error(cancelled.data.error || 'Could not cancel debugger wait')
  const normal = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId: normalRunId, input: { value: marker } })
  if (!normal.response.ok || normal.data.run?.status !== 'ok') throw new Error(`Cancellation did not release debug concurrency slot: ${JSON.stringify(normal.data)}`)

  const denied = await post('/dsh-node-flow/workflows', { action: 'debug', id: workflowId, runId: `debug-sensitive-${suffix}`, input: { value: marker, token: secret } })
  if (denied.response.status !== 400 || JSON.stringify(denied.data).includes(secret)) throw new Error(`Sensitive debug input was accepted or leaked: ${JSON.stringify(denied.data)}`)
  if (process.env.DSH_HOME) {
    const persisted = readFileSync(join(process.env.DSH_HOME, 'workflow-canvas', 'runs.json'), 'utf8')
    if (persisted.includes(secret)) throw new Error('Sensitive debug input leaked to persisted run history')
  }

  const audit = await requestJson('/dsh-node-flow/audit-log?limit=200')
  const actions = new Set((audit.data.events ?? []).filter((event) => event.target?.id === workflowId || event.details?.workflowId === workflowId).map((event) => event.action))
  for (const action of ['run.debug-started', 'run.debug-continued', 'run.debug-stepped', 'run.debug-cancelled']) {
    if (!actions.has(action)) throw new Error(`Debugger audit event is missing: ${action}`)
  }

  console.log(JSON.stringify({ ok: true, breakpoints: true, continueAndStep: true, snapshotIsolation: true, singleClaim: true, persistenceSafety: true, concurrency: true, cancellation: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
}

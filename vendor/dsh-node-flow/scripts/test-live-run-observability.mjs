import { readFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME !== '1') {
  throw new Error('Run observability regression must run against the isolated runtime harness')
}

const baseUrl = process.env.DSH_WEB_URL
if (!baseUrl) throw new Error('DSH_WEB_URL is required')

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `runtime-replay-${suffix}`
const sourceRunId = `runtime-replay-source-${suffix}`
const replayRunId = `runtime-replay-copy-${suffix}`
const sensitiveRunId = `runtime-replay-sensitive-${suffix}`
const inputMarker = `input-only-${suffix}`
const secret = `replay-secret-${suffix}`

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function post(path, body) {
  return await requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

function documentOf(template) {
  return {
    version: 1,
    name: `Replay ${suffix}`,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 160 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'output', type: 'workflow', position: { x: 360, y: 160 }, data: { kind: 'output', label: 'Result', template } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'output' }],
  }
}

let revision
try {
  const health = await requestJson('/dsh-node-flow/workflows')
  if (!health.response.ok || health.data.capabilities?.runDetails !== true || health.data.capabilities?.runReplay !== true) {
    throw new Error(`Run observability capabilities are unavailable: ${JSON.stringify(health.data.capabilities)}`)
  }

  const now = new Date().toISOString()
  const created = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: {
      id: workflowId,
      name: `Replay ${suffix}`,
      status: 'disabled',
      revision: 0,
      draftRevision: 0,
      createdAt: now,
      updatedAt: now,
      doc: documentOf('{{result.label}}'),
    },
  })
  if (!created.response.ok || !created.data.workflow) throw new Error(created.data.error || 'Could not create replay workflow')
  revision = created.data.workflow.revision

  const source = await post('/dsh-node-flow/workflows', {
    action: 'run',
    id: workflowId,
    runId: sourceRunId,
    input: { label: inputMarker },
  })
  if (!source.response.ok || source.data.run?.status !== 'ok' || source.data.run?.value !== inputMarker) {
    throw new Error(`Safe source run failed: ${JSON.stringify(source.data)}`)
  }
  if (source.data.run.replayInput !== undefined || source.data.run.replayInputAvailable !== true) {
    throw new Error('Run response exposed replay input or did not mark it available')
  }

  const changed = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: revision,
    workflow: { ...created.data.workflow, revision, doc: documentOf(`changed:${'{{result.label}}'}`) },
  })
  if (!changed.response.ok || !changed.data.workflow) throw new Error(changed.data.error || 'Could not update replay workflow')
  revision = changed.data.workflow.revision

  const replayed = await post('/dsh-node-flow/runs', { action: 'replay', id: sourceRunId, runId: replayRunId })
  if (!replayed.response.ok || replayed.data.run?.status !== 'ok' || replayed.data.run?.value !== inputMarker || replayed.data.run?.replayedFromRunId !== sourceRunId) {
    throw new Error(`Replay did not use the immutable source snapshot: ${JSON.stringify(replayed.data)}`)
  }

  const summary = await requestJson('/dsh-node-flow/runs?view=summary')
  const summarySource = summary.data.runs?.find((run) => run.id === sourceRunId)
  if (!summary.response.ok || !summarySource?.replayable || summarySource.nodes !== undefined || summarySource.snapshot !== undefined || JSON.stringify(summarySource).includes(inputMarker)) {
    throw new Error(`Run summary leaked details or lost replay eligibility: ${JSON.stringify(summarySource)}`)
  }

  const detail = await requestJson(`/dsh-node-flow/runs?id=${encodeURIComponent(sourceRunId)}`)
  if (!detail.response.ok || detail.data.run?.snapshot !== undefined || detail.data.run?.replayInput !== undefined || detail.data.run?.nodes?.find((node) => node.id === 'output')?.output !== inputMarker) {
    throw new Error(`Run detail did not expose the expected redacted shape: ${JSON.stringify(detail.data)}`)
  }

  const sensitive = await post('/dsh-node-flow/workflows', {
    action: 'run',
    id: workflowId,
    runId: sensitiveRunId,
    input: { label: 'sensitive', token: secret },
  })
  if (!sensitive.response.ok || sensitive.data.run?.replayInputAvailable !== false || JSON.stringify(sensitive.data).includes(secret)) {
    throw new Error(`Sensitive input was not excluded from replay history: ${JSON.stringify(sensitive.data)}`)
  }
  const denied = await post('/dsh-node-flow/runs', { action: 'replay', id: sensitiveRunId })
  if (denied.response.status !== 409) throw new Error(`Sensitive run replay returned ${denied.response.status}`)

  const allRuns = await requestJson('/dsh-node-flow/runs')
  if (JSON.stringify(allRuns.data).includes(secret)) throw new Error('Sensitive input leaked through the full runs API')
  const persisted = readFileSync(join(process.env.DSH_HOME, 'workflow-canvas', 'runs.json'), 'utf8')
  if (persisted.includes(secret)) throw new Error('Sensitive input leaked to the persisted run history')

  console.log(JSON.stringify({ ok: true, immutableReplay: true, lazyDetails: true, sensitiveInputBlocked: true }, null, 2))
} finally {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) {
    if (run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  if (revision !== undefined) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: revision }).catch(() => undefined)
}

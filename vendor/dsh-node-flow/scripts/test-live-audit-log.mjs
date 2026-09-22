import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME !== '1') {
  throw new Error('Audit-log regression must run against the isolated runtime harness')
}

const baseUrl = process.env.DSH_WEB_URL
if (!baseUrl) throw new Error('DSH_WEB_URL is required')

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const ids = new Set()
const runIds = new Set()
const secret = `audit-secret-${suffix}`
const safeInput = `audit-input-${suffix}`
const approvalNote = `audit-approval-note-${suffix}`
let upstreamMode = 'fail'
let upstream

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

function basicDocument(name, template = '{{result.label}}') {
  return {
    version: 1,
    name,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 160 }, data: { kind: 'trigger', label: '开始' } },
      { id: 'output', type: 'workflow', position: { x: 390, y: 160 }, data: { kind: 'output', label: '输出', template } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'output', type: 'workflow' }],
  }
}

async function createWorkflow(id, name, doc) {
  ids.add(id)
  const now = new Date().toISOString()
  const result = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: { id, name, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc },
  })
  if (!result.response.ok || !result.data.workflow) throw new Error(result.data.error || `Could not create ${name}`)
  return result.data.workflow
}

async function deleteWorkflow(id) {
  const workflows = await requestJson('/dsh-node-flow/workflows')
  const workflow = workflows.data.workflows?.find((candidate) => candidate.id === id)
  if (!workflow) return
  const result = await post('/dsh-node-flow/workflows', { action: 'delete', id, expectedRevision: workflow.revision })
  if (!result.response.ok) throw new Error(result.data.error || `Could not delete ${id}`)
}

function requireAudit(events, action, targetId) {
  const event = events.find((candidate) => candidate.action === action && candidate.target?.id === targetId)
  if (!event) throw new Error(`Missing audit event ${action} for ${targetId}: ${JSON.stringify(events)}`)
  return event
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) {
    if (runIds.has(run.id) || ids.has(run.workflowId)) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  for (const id of ids) await deleteWorkflow(id).catch(() => undefined)
  const credentials = await requestJson('/dsh-node-flow/credentials').catch(() => ({ data: { credentials: [] } }))
  for (const credential of credentials.data.credentials ?? []) {
    if (credential.name === `Audit credential ${suffix}`) await post('/dsh-node-flow/credentials', { action: 'delete', id: credential.id }).catch(() => undefined)
  }
  const variables = await requestJson('/dsh-node-flow/project-variables').catch(() => ({ data: { variables: [] } }))
  for (const variable of variables.data.variables ?? []) {
    if (variable.name === `AUDIT_SECRET_${suffix.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`) {
      await post('/dsh-node-flow/project-variables', { action: 'delete', id: variable.id, expectedUpdatedAt: variable.updatedAt }).catch(() => undefined)
    }
  }
}

try {
  upstream = createServer((_request, response) => {
    response.statusCode = upstreamMode === 'fail' ? 503 : 200
    response.end(upstreamMode === 'fail' ? 'retry later' : 'resumed')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Audit upstream did not expose a TCP port')

  const health = await requestJson('/dsh-node-flow/workflows')
  if (!health.response.ok || health.data.capabilities?.auditLog !== true) throw new Error('Audit-log capability is unavailable')

  const variableName = `AUDIT_SECRET_${suffix.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`
  const variable = await post('/dsh-node-flow/project-variables', {
    action: 'save', variable: { name: variableName, kind: 'secret', value: secret },
  })
  if (!variable.response.ok || !variable.data.variable) throw new Error(variable.data.error || 'Could not create audit test variable')
  const removedVariable = await post('/dsh-node-flow/project-variables', {
    action: 'delete', id: variable.data.variable.id, expectedUpdatedAt: variable.data.variable.updatedAt,
  })
  if (!removedVariable.response.ok) throw new Error(removedVariable.data.error || 'Could not delete audit test variable')

  const credential = await post('/dsh-node-flow/credentials', {
    action: 'save', credential: { name: `Audit credential ${suffix}`, kind: 'api-key', headerName: 'X-Audit-Key', secret: { value: secret } },
  })
  if (!credential.response.ok || !credential.data.credential) throw new Error(credential.data.error || 'Could not create audit test credential')
  const removedCredential = await post('/dsh-node-flow/credentials', { action: 'delete', id: credential.data.credential.id })
  if (!removedCredential.response.ok) throw new Error(removedCredential.data.error || 'Could not delete audit test credential')

  const versionWorkflowId = `runtime-audit-version-${suffix}`
  const versionWorkflowName = `Audit versions ${suffix}`
  let versionWorkflow = await createWorkflow(versionWorkflowId, versionWorkflowName, basicDocument(versionWorkflowName))
  const savedDraft = await post('/dsh-node-flow/workflows', {
    action: 'save', expectedRevision: versionWorkflow.revision,
    workflow: { ...versionWorkflow, doc: basicDocument(versionWorkflowName, 'draft:{{result.label}}') },
  })
  if (!savedDraft.response.ok || !savedDraft.data.workflow) throw new Error(savedDraft.data.error || 'Could not create audit draft version')
  versionWorkflow = savedDraft.data.workflow
  const published = await post('/dsh-node-flow/workflows', {
    action: 'status', id: versionWorkflowId, status: 'enabled', expectedRevision: versionWorkflow.revision,
  })
  if (!published.response.ok || !published.data.workflow) throw new Error(published.data.error || 'Could not publish audit workflow')
  versionWorkflow = published.data.workflow
  const versions = await requestJson(`/dsh-node-flow/workflow-versions?workflowId=${encodeURIComponent(versionWorkflowId)}`)
  const createdVersion = versions.data.versions?.find((version) => version.kind === 'created')
  if (!versions.response.ok || !createdVersion) throw new Error('Could not read audit workflow version history')
  const restored = await post('/dsh-node-flow/workflow-versions', {
    action: 'restore', id: versionWorkflowId, versionId: createdVersion.id, publish: false, expectedRevision: versionWorkflow.revision,
  })
  if (!restored.response.ok || !restored.data.workflow) throw new Error(restored.data.error || 'Could not restore audit workflow version')
  versionWorkflow = restored.data.workflow
  const disabled = await post('/dsh-node-flow/workflows', {
    action: 'status', id: versionWorkflowId, status: 'disabled', expectedRevision: versionWorkflow.revision,
  })
  if (!disabled.response.ok || !disabled.data.workflow) throw new Error(disabled.data.error || 'Could not disable audit workflow')

  const replayWorkflowId = `runtime-audit-replay-${suffix}`
  const replayWorkflow = await createWorkflow(replayWorkflowId, `Audit replay ${suffix}`, basicDocument(`Audit replay ${suffix}`))
  const manualRunId = `runtime-audit-manual-${suffix}`
  runIds.add(manualRunId)
  const manual = await post('/dsh-node-flow/workflows', {
    action: 'run', id: replayWorkflowId, runId: manualRunId, input: { label: safeInput },
  })
  if (!manual.response.ok || manual.data.run?.status !== 'ok' || manual.data.run?.value !== safeInput) throw new Error(`Manual audit run failed: ${JSON.stringify(manual.data)}`)
  const replayRunId = `runtime-audit-replay-run-${suffix}`
  runIds.add(replayRunId)
  const replay = await post('/dsh-node-flow/runs', { action: 'replay', id: manualRunId, runId: replayRunId })
  if (!replay.response.ok || replay.data.run?.status !== 'ok' || replay.data.run?.replayedFromRunId !== manualRunId) throw new Error(`Replay audit run failed: ${JSON.stringify(replay.data)}`)

  const resumeWorkflowId = `runtime-audit-resume-${suffix}`
  const resumeWorkflowName = `Audit resume ${suffix}`
  const resumeDocument = {
    version: 1,
    name: resumeWorkflowName,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: '开始' } },
      { id: 'request', type: 'workflow', position: { x: 260, y: 0 }, data: { kind: 'http', label: '请求', httpMethod: 'GET', url: `http://127.0.0.1:${address.port}/audit`, failOnHttpError: true, responseMode: 'text', retryCount: '0' } },
      { id: 'output', type: 'workflow', position: { x: 520, y: 0 }, data: { kind: 'output', label: '输出', template: '{{result}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'request' }, { id: 'e2', source: 'request', target: 'output' }],
  }
  await createWorkflow(resumeWorkflowId, resumeWorkflowName, resumeDocument)
  const failedRunId = `runtime-audit-failed-${suffix}`
  runIds.add(failedRunId)
  const failed = await post('/dsh-node-flow/workflows', { action: 'run', id: resumeWorkflowId, runId: failedRunId })
  if (!failed.response.ok || failed.data.run?.status !== 'error' || !failed.data.run?.resumable) throw new Error(`Could not create resumable audit run: ${JSON.stringify(failed.data)}`)
  upstreamMode = 'success'
  const resumedRunId = `runtime-audit-resumed-${suffix}`
  runIds.add(resumedRunId)
  const resumed = await post('/dsh-node-flow/runs', { action: 'resume', id: failedRunId, runId: resumedRunId })
  if (!resumed.response.ok || resumed.data.run?.status !== 'ok' || resumed.data.run?.resumedFromRunId !== failedRunId) throw new Error(`Could not resume audit run: ${JSON.stringify(resumed.data)}`)

  const approvalWorkflowId = `runtime-audit-approval-${suffix}`
  const approvalWorkflowName = `Audit approval ${suffix}`
  await createWorkflow(approvalWorkflowId, approvalWorkflowName, {
    version: 1,
    name: approvalWorkflowName,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: '开始' } },
      { id: 'wait', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'wait', label: '审批', waitMode: 'approval' } },
      { id: 'output', type: 'workflow', position: { x: 480, y: 0 }, data: { kind: 'output', label: '输出', template: '{{result.decision}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'wait' }, { id: 'e2', source: 'wait', target: 'output' }],
  })
  const approvalRunId = `runtime-audit-approval-run-${suffix}`
  runIds.add(approvalRunId)
  const approvalWaiting = await post('/dsh-node-flow/workflows', { action: 'run', id: approvalWorkflowId, runId: approvalRunId })
  if (!approvalWaiting.response.ok || approvalWaiting.data.run?.status !== 'waiting') throw new Error(`Could not create approval waitpoint: ${JSON.stringify(approvalWaiting.data)}`)
  const approved = await post('/dsh-node-flow/runs', { action: 'resolve-waitpoint', id: approvalRunId, decision: 'approved', note: approvalNote })
  if (!approved.response.ok || approved.data.run?.status !== 'ok') throw new Error(`Could not resolve audit approval: ${JSON.stringify(approved.data)}`)

  const cancelWorkflowId = `runtime-audit-cancel-${suffix}`
  const cancelWorkflowName = `Audit cancel ${suffix}`
  await createWorkflow(cancelWorkflowId, cancelWorkflowName, {
    version: 1,
    name: cancelWorkflowName,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: '开始' } },
      { id: 'wait', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'wait', label: '回调', waitMode: 'callback' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'wait' }],
  })
  const cancelledRunId = `runtime-audit-cancelled-${suffix}`
  runIds.add(cancelledRunId)
  const cancellationWaiting = await post('/dsh-node-flow/workflows', { action: 'run', id: cancelWorkflowId, runId: cancelledRunId })
  if (!cancellationWaiting.response.ok || cancellationWaiting.data.run?.status !== 'waiting') throw new Error(`Could not create cancellable waitpoint: ${JSON.stringify(cancellationWaiting.data)}`)
  const cancelled = await post('/dsh-node-flow/workflows', { action: 'cancel', runId: cancelledRunId })
  if (!cancelled.response.ok) throw new Error(cancelled.data.error || 'Could not cancel audit waitpoint')

  const deleteWorkflowId = `runtime-audit-delete-${suffix}`
  await createWorkflow(deleteWorkflowId, `Audit delete ${suffix}`, basicDocument(`Audit delete ${suffix}`))
  await deleteWorkflow(deleteWorkflowId)

  const audit = await requestJson('/dsh-node-flow/audit-log?limit=200')
  if (!audit.response.ok || !Array.isArray(audit.data.events)) throw new Error(`Could not read audit log: ${JSON.stringify(audit.data)}`)
  const events = audit.data.events
  requireAudit(events, 'variable.created', variable.data.variable.id)
  requireAudit(events, 'variable.deleted', variable.data.variable.id)
  requireAudit(events, 'credential.created', credential.data.credential.id)
  requireAudit(events, 'credential.deleted', credential.data.credential.id)
  requireAudit(events, 'workflow.created', versionWorkflowId)
  requireAudit(events, 'workflow.published', versionWorkflowId)
  requireAudit(events, 'workflow.restored', versionWorkflowId)
  requireAudit(events, 'workflow.disabled', versionWorkflowId)
  requireAudit(events, 'run.manual-started', manualRunId)
  requireAudit(events, 'run.replayed', replayRunId)
  requireAudit(events, 'run.resumed', resumedRunId)
  requireAudit(events, 'waitpoint.approved', approvalRunId)
  requireAudit(events, 'run.cancelled', cancelledRunId)
  requireAudit(events, 'workflow.deleted', deleteWorkflowId)

  const variableFilter = await requestJson('/dsh-node-flow/audit-log?limit=200&targetType=variable')
  if (!variableFilter.response.ok || !variableFilter.data.events?.every((event) => event.target?.type === 'variable')) throw new Error('Audit target-type filter returned non-variable events')
  const serialized = JSON.stringify(events)
  const persisted = readFileSync(join(process.env.DSH_HOME, 'workflow-canvas', 'audit-log.json'), 'utf8')
  for (const value of [secret, safeInput, approvalNote]) {
    if (serialized.includes(value) || persisted.includes(value)) throw new Error(`Audit log leaked protected value: ${value}`)
  }
  console.log(JSON.stringify({ ok: true, lifecycleEvents: true, runEvents: true, approvalEvents: true, filtered: true, sensitiveValuesHidden: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
  await new Promise((resolve) => upstream?.close(() => resolve()))
}

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-workflow-inputs-${suffix}`
const publishedWorkflowId = `live-workflow-inputs-published-${suffix}`
const workflowIds = new Set([workflowId, publishedWorkflowId])
const runIds = new Set()
const marker = `contract-${suffix}`

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

function inputContract() {
  return [
    { name: 'customer', label: '客户', type: 'object', required: true },
    { name: 'count', label: '数量', type: 'number', required: true },
    { name: 'enabled', label: '启用', type: 'boolean', required: true },
  ]
}

function documentOf(name, inputs = inputContract(), template = '{{result.customer.id}}|{{result.count}}|{{result.enabled}}') {
  return {
    version: 1,
    name,
    inputs,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 160 }, data: { kind: 'trigger', label: '开始' } },
      { id: 'output', type: 'workflow', position: { x: 390, y: 160 }, data: { kind: 'output', label: '输出', template } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'output', type: 'workflow' }],
  }
}

async function saveWorkflow(id, name, doc, expectedRevision = 0, existing = {}) {
  const now = new Date().toISOString()
  const result = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision,
    workflow: {
      id,
      name,
      status: existing.status || 'disabled',
      revision: existing.revision || 0,
      draftRevision: existing.draftRevision || 0,
      publishedRevision: existing.publishedRevision,
      publishedAt: existing.publishedAt,
      publishedDoc: existing.publishedDoc,
      createdAt: existing.createdAt || now,
      updatedAt: now,
      doc,
    },
  })
  if (!result.response.ok || !result.data.workflow) throw new Error(result.data.error || `Could not save ${name}`)
  return result.data.workflow
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) {
    if (runIds.has(run.id) || workflowIds.has(run.workflowId)) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  for (const workflow of workflows.data.workflows ?? []) {
    if (workflowIds.has(workflow.id)) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflow.id, expectedRevision: workflow.revision }).catch(() => undefined)
  }
}

try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.data.capabilities?.directRun !== true || capabilities.data.capabilities?.workflowInputContracts !== true) throw new Error('Running backend does not expose workflow input contracts')

  const draft = await saveWorkflow(workflowId, `Live Workflow Inputs ${suffix}`, documentOf(`Live Workflow Inputs ${suffix}`))
  const before = await requestJson('/dsh-node-flow/runs')
  const beforeCount = (before.data.runs ?? []).filter((run) => run.workflowId === workflowId).length

  const missingRunId = `live-workflow-input-missing-${suffix}`
  runIds.add(missingRunId)
  const missing = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId: missingRunId, input: { count: 2, enabled: true } })
  if (missing.response.status !== 400 || !String(missing.data.error || '').includes('缺少必填字段')) {
    throw new Error(`Missing required input was accepted: ${JSON.stringify(missing.data)}`)
  }

  const wrongTypeRunId = `live-workflow-input-type-${suffix}`
  runIds.add(wrongTypeRunId)
  const wrongType = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId: wrongTypeRunId, input: { customer: { id: marker }, count: '2', enabled: true } })
  if (wrongType.response.status !== 400 || !String(wrongType.data.error || '').includes('应为 number')) {
    throw new Error(`Wrong input type was accepted: ${JSON.stringify(wrongType.data)}`)
  }

  const afterRejected = await requestJson('/dsh-node-flow/runs')
  const rejectedRuns = (afterRejected.data.runs ?? []).filter((run) => run.workflowId === workflowId)
  if (rejectedRuns.length !== beforeCount || rejectedRuns.some((run) => run.id === missingRunId || run.id === wrongTypeRunId)) {
    throw new Error(`Rejected inputs created run records: ${JSON.stringify(rejectedRuns)}`)
  }

  const validRunId = `live-workflow-input-valid-${suffix}`
  runIds.add(validRunId)
  const valid = await post('/dsh-node-flow/workflows', {
    action: 'run', id: workflowId, runId: validRunId,
    input: { customer: { id: marker }, count: 7, enabled: false },
  })
  if (!valid.response.ok || valid.data.run?.status !== 'ok' || valid.data.run?.value !== `${marker}|7|false`) {
    throw new Error(`Typed input did not reach trigger/output: ${JSON.stringify(valid.data)}`)
  }

  const publishedName = `Live Published Input ${suffix}`
  let published = await saveWorkflow(publishedWorkflowId, publishedName, documentOf(publishedName))
  const publish = await post('/dsh-node-flow/workflows', { action: 'status', id: published.id, status: 'enabled', expectedRevision: published.revision })
  if (!publish.response.ok || !publish.data.workflow?.publishedDoc) throw new Error(`Could not publish contract workflow: ${JSON.stringify(publish.data)}`)
  published = publish.data.workflow
  const changedDraft = documentOf(publishedName, [{ name: 'draftOnly', label: '仅草稿', type: 'string', required: true }], 'draft={{result.draftOnly}}')
  published = await saveWorkflow(published.id, published.name, changedDraft, published.revision, published)
  const publishedRunId = `live-workflow-input-published-${suffix}`
  runIds.add(publishedRunId)
  const publishedRun = await post('/dsh-node-flow/workflows', {
    action: 'run', id: published.id, runId: publishedRunId, document: changedDraft,
    input: { customer: { id: marker }, count: 3, enabled: true },
  })
  if (!publishedRun.response.ok || publishedRun.data.run?.value !== `${marker}|3|true`) {
    throw new Error(`Published input contract was bypassed by draft document: ${JSON.stringify(publishedRun.data)}`)
  }

  console.log(JSON.stringify({ ok: true, rejectedBeforeRunCreation: true, typedInput: true, publishedContractIsolation: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
}

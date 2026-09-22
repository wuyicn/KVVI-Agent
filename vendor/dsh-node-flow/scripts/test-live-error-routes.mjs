import { createServer } from 'node:http'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-error-route-${suffix}`
const workflowName = `Live Error Route ${suffix}`
const handledRunId = `live-error-handled-${suffix}`
const rejectedRunId = `live-error-rejected-${suffix}`
const runIds = new Set([handledRunId, rejectedRunId])
const sensitiveInput = 'upstream-credential-input-must-not-leak'
const sensitiveResponse = 'provider-response-must-not-leak'

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

async function cleanup() {
  const { data: runs } = await requestJson('/dsh-node-flow/runs')
  for (const run of runs.runs || []) {
    if (runIds.has(run.id) || run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id })
  }
  const { data: workflows } = await requestJson('/dsh-node-flow/workflows')
  const workflow = (workflows.workflows || []).find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision })
}

const upstream = createServer((_request, response) => {
  response.writeHead(503, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ token: sensitiveResponse, reason: 'outage' }))
})

await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
try {
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Error route fixture did not expose a TCP port')
  const health = await requestJson('/dsh-node-flow/workflows')
  if (!health.response.ok) throw new Error('Workflow backend is unavailable')
  await cleanup()

  const doc = {
    version: 1,
    name: workflowName,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: '开始' } },
      {
        id: 'request',
        type: 'workflow',
        position: { x: 350, y: 180 },
        data: {
          kind: 'http',
          label: '不稳定请求',
          httpMethod: 'GET',
          url: `http://127.0.0.1:${address.port}/unavailable`,
          responseMode: 'json',
          failOnHttpError: true,
          retryCount: '1',
          retryDelay: '0',
          onError: 'route',
        },
      },
      { id: 'handled-output', type: 'workflow', position: { x: 640, y: 300 }, data: { kind: 'output', label: '记录故障', template: '{{result.error.nodeKind}}:{{result.error.attempts}}' } },
    ],
    edges: [
      { id: 'success', source: 'trigger', sourceHandle: 'success', target: 'request' },
      { id: 'error', source: 'request', sourceHandle: 'error', target: 'handled-output' },
    ],
  }
  const created = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: { id: workflowId, name: workflowName, status: 'disabled', revision: 0, draftRevision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), doc },
  })
  if (!created.response.ok) throw new Error(`Could not create error route workflow: ${created.data.error || created.response.status}`)

  const handled = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId: handledRunId, input: sensitiveInput })
  const run = handled.data.run
  const requestNode = run?.nodes?.find((node) => node.id === 'request')
  const outputNode = run?.nodes?.find((node) => node.id === 'handled-output')
  if (!handled.response.ok || run?.status !== 'handled' || run?.failed !== 0 || run?.handledErrors !== 1 || run?.resumable !== false) {
    throw new Error(`Error route completion was incorrect: ${JSON.stringify(run)}`)
  }
  if (!requestNode?.errorHandled || requestNode.attempts !== 2 || outputNode?.output !== 'http:2') {
    throw new Error(`Error route node records were incorrect: ${JSON.stringify({ requestNode, outputNode })}`)
  }
  const errorEvent = typeof outputNode?.input === 'string'
    ? JSON.parse(outputNode.input)
    : outputNode?.input
  if (JSON.stringify(errorEvent).includes(sensitiveInput) || JSON.stringify(errorEvent).includes(sensitiveResponse)) {
    throw new Error('Error route event leaked upstream input or response payload')
  }
  if (errorEvent?.error?.message !== 'HTTP 503 请求失败') {
    throw new Error(`Error route event did not retain a safe HTTP summary: ${JSON.stringify(errorEvent)}`)
  }
  if (!JSON.stringify(requestNode?.output).includes('[redacted]')) {
    throw new Error('Failed HTTP response token was not redacted from the run record')
  }

  const summary = await requestJson('/dsh-node-flow/runs?view=summary')
  const summaryRun = summary.data.runs?.find((candidate) => candidate.id === handledRunId)
  if (!summary.response.ok || summaryRun?.status !== 'handled' || summaryRun?.handledErrors !== 1 || Object.prototype.hasOwnProperty.call(summaryRun || {}, 'nodes')) {
    throw new Error(`Error route summary was incorrect: ${JSON.stringify(summaryRun)}`)
  }
  const detail = await requestJson(`/dsh-node-flow/runs?id=${encodeURIComponent(handledRunId)}`)
  const detailOutput = detail.data.run?.nodes?.find((node) => node.id === 'handled-output')
  if (!detail.response.ok || detail.data.run?.snapshot || JSON.stringify(detailOutput?.input).includes(sensitiveInput) || JSON.stringify(detailOutput?.input).includes(sensitiveResponse)) {
    throw new Error('Error route detail leaked protected error-event data')
  }

  const invalidDoc = structuredClone(doc)
  invalidDoc.nodes[1].data.onError = 'route'
  invalidDoc.edges = invalidDoc.edges.filter((edge) => edge.id !== 'error')
  const invalid = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId: rejectedRunId, document: invalidDoc })
  if (invalid.response.status !== 400 || !String(invalid.data.error || '').includes('error 端口')) {
    throw new Error(`Missing error edge was not rejected: ${JSON.stringify(invalid.data)}`)
  }

  console.log(JSON.stringify({ ok: true, status: run.status, attempts: requestNode.attempts, handledErrors: run.handledErrors }, null, 2))
} finally {
  await cleanup().catch(() => {})
  await new Promise((resolve) => upstream.close(() => resolve()))
}

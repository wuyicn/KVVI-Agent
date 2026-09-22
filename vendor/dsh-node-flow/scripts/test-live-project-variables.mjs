import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const plainName = `ECHO_URL_${Date.now().toString(36).toUpperCase()}`
const secretName = `RUNTIME_SECRET_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
const initialSecret = `variable-secret-${suffix}`
const rotatedSecret = `variable-rotated-${suffix}`
const workflowIds = new Set()
const variableIds = new Set()
const receivedRequests = []

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

async function saveVariable(variable, expectedUpdatedAt) {
  const result = await post('/dsh-node-flow/project-variables', { action: 'save', variable, expectedUpdatedAt })
  if (!result.response.ok || !result.data.variable) throw new Error(result.data.error || `Could not save ${variable.name}`)
  variableIds.add(result.data.variable.id)
  return result.data.variable
}

async function saveWorkflow(id, nodes, edges) {
  workflowIds.add(id)
  const now = new Date().toISOString()
  const doc = { version: 1, name: id, nodes, edges }
  const result = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: { id, name: id, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc },
  })
  if (!result.response.ok || !result.data.workflow) throw new Error(result.data.error || `Could not create ${id}`)
  return result.data.workflow
}

async function publish(workflow) {
  return post('/dsh-node-flow/workflows', { action: 'status', id: workflow.id, status: 'enabled', expectedRevision: workflow.revision })
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) if (workflowIds.has(run.workflowId)) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  for (const workflow of workflows.data.workflows ?? []) if (workflowIds.has(workflow.id)) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflow.id, expectedRevision: workflow.revision }).catch(() => undefined)
  const variables = await requestJson('/dsh-node-flow/project-variables').catch(() => ({ data: { variables: [] } }))
  for (const variable of variables.data.variables ?? []) if (variableIds.has(variable.id) || variable.name === plainName || variable.name === secretName) {
    await post('/dsh-node-flow/project-variables', { action: 'delete', id: variable.id, expectedUpdatedAt: variable.updatedAt }).catch(() => undefined)
  }
}

const echoServer = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  const body = text ? JSON.parse(text) : undefined
  const received = { header: request.headers['x-project-secret'], body }
  receivedRequests.push(received)
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(received))
})

await new Promise((resolve) => echoServer.listen(0, '127.0.0.1', resolve))
try {
  await cleanup()
  const address = echoServer.address()
  if (!address || typeof address === 'string') throw new Error('Echo server did not expose a port')
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.data.capabilities?.projectVariables !== true || capabilities.data.capabilities?.projectSecrets !== true) throw new Error('Running backend does not expose project variable capabilities')

  const plain = await saveVariable({ name: plainName, kind: 'plain', value: `http://127.0.0.1:${address.port}` })
  const secret = await saveVariable({ name: secretName, kind: 'secret', value: initialSecret })
  const rotated = await saveVariable({ id: secret.id, name: secret.name, kind: 'secret', value: rotatedSecret }, secret.updatedAt)
  if (rotated.updatedAt <= secret.updatedAt) throw new Error('Project variable version did not advance monotonically')
  const stale = await post('/dsh-node-flow/project-variables', { action: 'save', variable: { id: secret.id, name: secret.name, kind: 'secret', value: `${rotatedSecret}-stale` }, expectedUpdatedAt: secret.updatedAt })
  if (stale.response.status !== 409) throw new Error(`Stale project variable update returned ${stale.response.status}`)

  const listed = await requestJson('/dsh-node-flow/project-variables')
  const serializedVariables = JSON.stringify(listed.data)
  if (serializedVariables.includes(initialSecret) || serializedVariables.includes(rotatedSecret)) throw new Error('Project Secret leaked through the variables API')
  if (listed.data.variables?.find((variable) => variable.id === plain.id)?.value !== `http://127.0.0.1:${address.port}`) throw new Error('Plain project variable was not returned')

  const id = `live-variable-${suffix}`
  const nodes = [
    { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
    { id: 'http', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'http', label: 'Echo', httpMethod: 'POST', url: `{{vars.${plainName}}}`, headers: `{"content-type":"application/json","x-project-secret":"{{vars.${secretName}}}"}`, body: `{"message":"{{result.message}}","secret":"{{vars.${secretName}}}"}`, responseMode: 'json' } },
  ]
  if (process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME === '1') nodes.push({ id: 'agent', type: 'workflow', position: { x: 480, y: 0 }, data: { kind: 'agent', label: 'Safe Agent', prompt: 'Summarize the input' } })
  const edges = [{ id: 'e1', source: 'trigger', target: 'http' }]
  if (nodes.some((node) => node.id === 'agent')) edges.push({ id: 'e2', source: 'http', target: 'agent' })
  const workflow = await saveWorkflow(id, nodes, edges)
  const published = await publish(workflow)
  if (!published.response.ok) throw new Error(published.data.error || 'Could not publish variable workflow')
  const run = await post('/dsh-node-flow/workflows', { action: 'run', id, runId: `variable-run-${suffix}`, input: { message: 'hello' } })
  if (!run.response.ok || run.data.run?.status !== 'ok') throw new Error(run.data.error || `Variable workflow failed: ${JSON.stringify(run.data)}`)
  if (receivedRequests.length !== 1 || receivedRequests[0].header !== rotatedSecret || receivedRequests[0].body?.secret !== rotatedSecret) throw new Error(`Server-side Secret was not injected: ${JSON.stringify(receivedRequests)}`)
  const serializedRun = JSON.stringify(run.data)
  if (serializedRun.includes(initialSecret) || serializedRun.includes(rotatedSecret)) throw new Error('Project Secret leaked through a synchronous workflow response')
  if (!serializedRun.includes('[secret]')) throw new Error('Project Secret was not visibly redacted from the run')
  const runs = await requestJson('/dsh-node-flow/runs')
  if (JSON.stringify(runs.data).includes(rotatedSecret)) throw new Error('Project Secret leaked through run history')

  if (process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME === '1') {
    const prompts = globalThis.__DSH_NODE_FLOW_TEST_AGENT_PROMPTS__ ?? []
    const promptText = JSON.stringify(prompts)
    if (promptText.includes(rotatedSecret) || !promptText.includes('[secret]')) throw new Error(`Agent boundary did not redact project secrets: ${promptText}`)
  }

  const referenced = await requestJson('/dsh-node-flow/project-variables')
  const secretReferences = referenced.data.variables?.find((variable) => variable.id === secret.id)?.references ?? []
  if (!secretReferences.some((reference) => reference.workflowId === id && reference.scope === 'published')) throw new Error('Published variable reference was not reported')
  const blockedDelete = await post('/dsh-node-flow/project-variables', { action: 'delete', id: secret.id, expectedUpdatedAt: rotated.updatedAt })
  if (blockedDelete.response.status !== 409 || !Array.isArray(blockedDelete.data.references)) throw new Error(`Referenced variable deletion returned ${blockedDelete.response.status}`)

  const unsafeId = `live-variable-unsafe-${suffix}`
  const unsafe = await saveWorkflow(unsafeId, [
    { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
    { id: 'output', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'output', label: 'Unsafe', template: `{{vars.${secretName}}}` } },
  ], [{ id: 'e1', source: 'trigger', target: 'output' }])
  const unsafePublish = await publish(unsafe)
  if (unsafePublish.response.status !== 400 || !String(unsafePublish.data.error).includes('Secret')) throw new Error(`Unsafe Secret publish returned ${unsafePublish.response.status}`)

  const missingId = `live-variable-missing-${suffix}`
  const missing = await saveWorkflow(missingId, [
    { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
    { id: 'http', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'http', label: 'Missing', url: '{{vars.DOES_NOT_EXIST}}' } },
  ], [{ id: 'e1', source: 'trigger', target: 'http' }])
  const missingPublish = await publish(missing)
  if (missingPublish.response.status !== 400 || !String(missingPublish.data.error).includes('不存在')) throw new Error(`Missing variable publish returned ${missingPublish.response.status}`)

  if (process.env.DSH_HOME) {
    const dataDirectory = join(process.env.DSH_HOME, 'workflow-canvas')
    const variablesFile = readFileSync(join(dataDirectory, 'variables.json'), 'utf8')
    const runsFile = readFileSync(join(dataDirectory, 'runs.json'), 'utf8')
    if (variablesFile.includes(rotatedSecret) || runsFile.includes(rotatedSecret)) throw new Error('Project Secret leaked to persisted JSON')
  }

  console.log(JSON.stringify({ ok: true, encrypted: true, injectedOnHost: true, redacted: true, references: true, staleWriteBlocked: true, unsafePublishBlocked: true, missingPublishBlocked: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
  await new Promise((resolve) => echoServer.close(() => resolve()))
}

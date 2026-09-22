import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataHome = mkdtempSync(join(tmpdir(), 'dsh-data-store-runtime-'))
process.env.DSH_HOME = dataHome
process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME = '1'

const routes = new Map()
const effects = []
const services = {
  agents: { get: () => undefined, list: () => [], roots: () => [] },
  subagents: { list: () => [], getProvider: () => undefined },
}
const webServer = {
  register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}
const context = {
  webServer,
  get(name) { return services[name] },
  effect(callback) {
    const disposer = callback()
    if (typeof disposer === 'function') effects.push(disposer)
    return disposer
  },
}

const runtime = await import(`../lib/runtime-resilience.js?data-store=${Date.now()}`)
runtime.apply(context)

const server = createServer((request, response) => {
  const path = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`).pathname
  const handler = routes.get(path)
  if (!handler) {
    response.statusCode = 404
    response.end('not found')
    return
  }
  void Promise.resolve(handler(request, response)).catch((error) => {
    if (!response.headersSent) response.statusCode = 500
    response.end(error instanceof Error ? error.message : String(error))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Data Store test server did not expose a TCP port')
const baseUrl = `http://127.0.0.1:${address.port}`
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

function documentOf(label, namespace = 'runtime') {
  return {
    version: 1,
    name: label,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'set', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'data-store', label: 'Set', storeNamespace: namespace, storeOperation: 'set', storeKey: 'customer:42', storeValue: '{"status":"{{result.status}}","marker":"{{result.marker}}"}' } },
      { id: 'get', type: 'workflow', position: { x: 480, y: 0 }, data: { kind: 'data-store', label: 'Get', storeNamespace: namespace, storeOperation: 'get', storeKey: 'customer:42' } },
      { id: 'output', type: 'workflow', position: { x: 720, y: 0 }, data: { kind: 'output', label: 'Output', template: '{{result.value.status}}' } },
    ],
    edges: [
      { id: 'trigger-set', source: 'trigger', target: 'set' },
      { id: 'set-get', source: 'set', target: 'get' },
      { id: 'get-output', source: 'get', target: 'output' },
    ],
  }
}

function storeDocument(label, namespace, operation, key = '', prefix = '') {
  return {
    version: 1,
    name: label,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'store', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'data-store', label: 'Store', storeNamespace: namespace, storeOperation: operation, storeKey: key, storePrefix: prefix } },
    ],
    edges: [{ id: 'trigger-store', source: 'trigger', target: 'store' }],
  }
}

async function saveWorkflow(id, doc) {
  workflowIds.add(id)
  const now = new Date().toISOString()
  const result = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: { id, name: doc.name, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc },
  })
  if (!result.response.ok || !result.data.workflow) throw new Error(result.data.error || `Could not create ${id}`)
  return result.data.workflow
}

async function runWorkflow(workflow, input, document) {
  const runId = `data-store-run-${workflow.id}-${Math.random().toString(36).slice(2, 8)}`
  const result = await post('/dsh-node-flow/workflows', { action: 'run', id: workflow.id, runId, document, input })
  if (!result.response.ok || !result.data.run) throw new Error(result.data.error || `Could not run ${workflow.id}`)
  return result.data.run
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
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (!capabilities.response.ok || capabilities.data.capabilities?.dataStore !== true) throw new Error('Data Store capability is unavailable')

  const workflowId = `runtime-data-store-${suffix}`
  const mainDocument = documentOf('Data Store runtime')
  const main = await saveWorkflow(workflowId, mainDocument)

  const first = await runWorkflow(main, { id: '42', status: 'ready', marker: `encrypted-marker-${suffix}` }, mainDocument)
  if (first.status !== 'ok' || first.value !== 'ready') throw new Error(`set/get run failed: ${JSON.stringify(first)}`)
  const rawPath = join(dataHome, 'workflow-canvas', 'data-store.json')
  const encryptedRaw = readFileSync(rawPath, 'utf8')
  if (encryptedRaw.includes(`encrypted-marker-${suffix}`)) throw new Error('Data Store value was not encrypted at rest')

  const second = await runWorkflow(main, { id: '42', status: 'updated', marker: `encrypted-marker-2-${suffix}` }, mainDocument)
  if (second.status !== 'ok' || second.value !== 'updated') throw new Error(`update run failed: ${JSON.stringify(second)}`)

  const listDocumentValue = storeDocument('Data Store list', 'runtime', 'list', '', 'customer:')
  const listed = await runWorkflow(main, {}, listDocumentValue)
  if (listed.status !== 'ok' || listed.nodes.at(-1)?.output?.count !== 1) throw new Error(`list failed: ${JSON.stringify(listed)}`)

  const namespaceDocument = storeDocument('Data Store namespace', 'other', 'get', 'customer:42')
  const namespaceResult = await runWorkflow(main, {}, namespaceDocument)
  if (namespaceResult.status !== 'ok' || namespaceResult.nodes.at(-1)?.output?.found !== false) throw new Error(`namespace isolation failed: ${JSON.stringify(namespaceResult)}`)

  const otherWorkflowId = `runtime-data-store-isolated-${suffix}`
  const otherDocument = storeDocument('Data Store workflow isolation', 'runtime', 'get', 'customer:42')
  const other = await saveWorkflow(otherWorkflowId, otherDocument)
  const isolated = await runWorkflow(other, {}, otherDocument)
  if (isolated.status !== 'ok' || isolated.nodes.at(-1)?.output?.found !== false) throw new Error(`workflow isolation failed: ${JSON.stringify(isolated)}`)

  const deleteDocument = storeDocument('Data Store delete', 'runtime', 'delete', 'customer:42')
  const deleted = await runWorkflow(main, {}, deleteDocument)
  if (deleted.status !== 'ok' || deleted.nodes.at(-1)?.output?.deleted !== true) throw new Error(`delete failed: ${JSON.stringify(deleted)}`)
  const missing = await runWorkflow(main, {}, storeDocument('Data Store missing', 'runtime', 'get', 'customer:42'))
  if (missing.status !== 'ok' || missing.nodes.at(-1)?.output?.found !== false) throw new Error(`get after delete failed: ${JSON.stringify(missing)}`)

  console.log(JSON.stringify({ ok: true, setGet: true, list: true, namespaceIsolation: true, workflowIsolation: true, delete: true, encryptedAtRest: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
  await new Promise((resolve) => server.close(() => resolve()))
  for (const dispose of effects.reverse()) await dispose()
  rmSync(dataHome, { recursive: true, force: true })
}

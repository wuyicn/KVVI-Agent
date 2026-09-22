import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataHome = mkdtempSync(join(tmpdir(), 'dsh-node-flow-runtime-'))
process.env.DSH_HOME = dataHome
process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME = '1'

const routes = new Map()
const effects = []
globalThis.__DSH_NODE_FLOW_TEST_AGENT_PROMPTS__ = []
const testAgent = { id: 'runtime-test-agent' }
const services = {
  agents: { get: () => testAgent, list: () => [testAgent], roots: () => [testAgent] },
  subagents: {
    list: () => ['spawn'],
    getProvider: (name) => name === 'spawn' ? {} : undefined,
    async start(_name, request) {
      globalThis.__DSH_NODE_FLOW_TEST_AGENT_PROMPTS__.push(request.prompt)
      return { result: Promise.resolve({ output: [{ type: 'text', text: 'agent-safe' }], stopReason: 'completed' }), async dispose() {} }
    },
  },
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

const runtime = await import(`../lib/runtime-resilience.js?test=${Date.now()}`)
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
try {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Runtime test server did not expose a TCP port')
  process.env.DSH_WEB_URL = `http://127.0.0.1:${address.port}`
  await import(`./test-live-resilience.mjs?runtime=${Date.now()}`)
  await import(`./test-live-error-routes.mjs?runtime=${Date.now()}`)
  await import(`./test-live-workflow-inputs.mjs?runtime=${Date.now()}`)
  await import(`./test-live-versions.mjs?runtime=${Date.now()}`)
  await import(`./test-live-oauth2.mjs?runtime=${Date.now()}`)
  await import(`./test-live-subworkflows.mjs?runtime=${Date.now()}`)
  await import(`./test-runtime-connectors.mjs?runtime=${Date.now()}`)
  await import(`./test-runtime-polling-triggers.mjs?runtime=${Date.now()}`)
  await import(`./test-live-project-variables.mjs?runtime=${Date.now()}`)
  await import(`./test-runtime-workflow-concurrency.mjs?runtime=${Date.now()}`)
  await import(`./test-runtime-execution-limits.mjs?runtime=${Date.now()}`)
  await import(`./test-live-webhooks.mjs?runtime=${Date.now()}`)
  await import(`./test-live-waitpoints.mjs?runtime=${Date.now()}`)
  await import(`./test-live-debugger.mjs?runtime=${Date.now()}`)
  await import(`./test-live-run-observability.mjs?runtime=${Date.now()}`)
  await import(`./test-live-audit-log.mjs?runtime=${Date.now()}`)
  await import(`./test-live-workflow-folders.mjs?runtime=${Date.now()}`)
} finally {
  await new Promise((resolve) => server.close(() => resolve()))
  for (const dispose of effects.reverse()) await dispose()
  rmSync(dataHome, { recursive: true, force: true })
}

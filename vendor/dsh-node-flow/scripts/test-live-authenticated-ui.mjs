import { spawn } from 'node:child_process'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const inspectorUrl = process.env.DSH_INSPECTOR_URL || 'http://127.0.0.1:9229/json/list'
const scripts = process.argv.slice(2)
const testScripts = scripts.length > 0
  ? scripts
  : [
      'scripts/test-live-resilience-ui.mjs',
      'scripts/test-live-versions-ui.mjs',
      'scripts/test-live-integrations.mjs',
      'scripts/test-live-error-routes-ui.mjs',
    ]

const targets = await fetch(inspectorUrl).then((response) => response.json())
const target = targets.find((candidate) => candidate.type === 'node')
if (!target?.webSocketDebuggerUrl) throw new Error('Node inspector target unavailable')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let sequence = 0
const pending = new Map()
const events = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
    return
  }
  events.push(message)
})

function call(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out calling ${method}`))
    }, 10_000)
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value) },
      reject(error) { clearTimeout(timer); reject(error) },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

function waitForEvent(method, predicate = () => true) {
  const current = events.find((event) => event.method === method && predicate(event))
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 10_000)
    const interval = setInterval(() => {
      const event = events.find((candidate) => candidate.method === method && predicate(candidate))
      if (!event) return
      clearInterval(interval)
      clearTimeout(timer)
      resolve(event)
    }, 20)
  })
}

async function authenticatedUrl() {
  await call('Debugger.enable')
  const parsed = events.find((event) => event.method === 'Debugger.scriptParsed' && event.params.url.includes('/dsh-host-webserver/lib/index.js'))
  if (!parsed) throw new Error('WebServer script was not reported by Node inspector')
  const breakpoint = await call('Debugger.setBreakpointByUrl', {
    url: parsed.params.url,
    lineNumber: 229,
    columnNumber: 0,
  })
  void fetch(`${baseUrl}/__dsh_node_flow_auth_probe__`).catch(() => undefined)
  const paused = await waitForEvent('Debugger.paused')
  const frame = paused.params.callFrames.find((candidate) => candidate.location.scriptId === parsed.params.scriptId) ?? paused.params.callFrames[0]
  try {
    const result = await call('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: `(() => {
        const connection = this.ctx.reflect.get('connection', false)
        if (!connection?.authenticatedUrl) throw new Error('DSH browser connection is unavailable')
        return connection.authenticatedUrl(${JSON.stringify(baseUrl)})
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails || typeof result.result.value !== 'string') {
      const detail = result.exceptionDetails?.exception?.description
        ?? result.exceptionDetails?.text
        ?? 'connection returned no URL'
      throw new Error(`Could not create a DSH browser session: ${detail}`)
    }
    return result.result.value
  } finally {
    await call('Debugger.resume').catch(() => undefined)
    await call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId }).catch(() => undefined)
  }
}

function run(script, authUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_WEB_URL: baseUrl, DSH_AUTH_URL: authUrl },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${script} exited with ${signal ?? code ?? 1}`))
    })
  })
}

try {
  const authUrl = await authenticatedUrl()
  for (const script of testScripts) await run(script, authUrl)
} finally {
  socket.close()
}

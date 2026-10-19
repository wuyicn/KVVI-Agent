// Usage from services/platform: node tests/run-isolated.mjs npm test
// Never inherits a pilot DSN. Stops only its own disposable cluster, retains evidence.
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'

const pgRoot = process.env.KVVI_TEST_PG_BIN?.replace(/\/$/, '')
const pg = pgRoot ? pgRoot + '/' : ''
const dir = mkdtempSync(join(tmpdir(), 'kvvi-group-test-'))
// Keep the socket path short on macOS; initdb also requires an empty data directory.
const evidenceDir = dir + '-logs'
mkdirSync(evidenceDir, { mode: 0o700 })
let toolSequence = 0, diagnosticFailed = false
let cancelled, active, result = 0
const signalCodes = { SIGINT: 130, SIGTERM: 143 }
function signalGroup(child, signal) {
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal) }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}
function cancel(signal) {
  cancelled ??= signal
  active?.terminate()
}
for (const signal of Object.keys(signalCodes)) process.on(signal, cancel)

function command(file, args, { timeout = 30000, inherit = false, cleanup = false, cleanupGroupOnExit = false, allowStatus = [] } = {}) {
  if (cancelled && !cleanup) return Promise.reject(new Error(`Cancelled by ${cancelled}`))
  if (typeof file !== 'string') return Promise.reject(new Error('No test command specified'))
  return new Promise((resolve, reject) => {
    let log = inherit ? undefined : join(evidenceDir, `${++toolSequence}-${basename(file)}.log`)
    let logError
    function logFailure(error) {
      if (logError) return
      logError = error.code
      diagnosticFailed = true
      console.error(`Test tool diagnostics unavailable: ${error.code}; directory: ${evidenceDir}`)
      log = undefined
    }
    if (log) { try { writeFileSync(log, '') } catch (error) { logFailure(error) } }
    const diagnostic = log ? `; diagnostics: ${log}` : ''
    const child = spawn(file, args, { env: commandEnv, stdio: inherit ? 'inherit' : 'pipe', detached: process.platform !== 'win32' })
    let timedOut = false, terminating = false, forceTimer
    function terminate() {
      if (terminating || !child.pid) return
      terminating = true
      signalGroup(child, 'SIGTERM')
      forceTimer = setTimeout(() => { signalGroup(child, 'SIGKILL') }, 2000)
    }
    const current = { terminate }
    if (!cleanup) active = current
    // initdb can fail before server.log exists; preserve diagnostics outside its
    // initially empty data directory, without printing environment or raw logs.
    if (log) {
      const capture = bytes => { if (log) { try { appendFileSync(log, bytes) } catch (error) { logFailure(error) } } }
      child.stdout?.on('data', capture)
      child.stderr?.on('data', capture)
    } else if (!inherit) {
      child.stdout?.resume(); child.stderr?.resume()
    }
    const timer = timeout > 0 ? setTimeout(() => { timedOut = true; terminate() }, timeout) : undefined
    function finish() {
      clearTimeout(timer); clearTimeout(forceTimer)
      if (active === current) active = undefined
      // Reap any surviving descendants of a cancelled test command as well.
      if ((terminating || cleanupGroupOnExit) && child.pid) signalGroup(child, 'SIGKILL')
    }
    child.once('error', error => { finish(); reject(new Error(`${basename(file)} could not start: ${error.code}${diagnostic}`)) })
    child.once('close', (code, signal) => {
      finish()
      if (timedOut) return reject(new Error(`${basename(file)} timed out${diagnostic}`))
      if (cancelled && !cleanup) return reject(new Error(`Cancelled by ${cancelled}`))
      if (logError && !cleanup) return reject(new Error(`${basename(file)} diagnostics failed: ${logError}`))
      if (code !== 0 && !allowStatus.includes(code)) {
        const error = new Error(`${basename(file)} failed: ${code ?? signal}${diagnostic}`)
        error.exitStatus = code
        return reject(error)
      }
      resolve(code)
    })
  })
}

// Tool subprocesses need PATH but never pilot database/signing configuration.
const commandEnv = { ...process.env }
for (const key of Object.keys(commandEnv)) if (key.startsWith('KVVI_')) delete commandEnv[key]
// This path is a read-only test tool selection, not a connection to an instance.
if (pgRoot) commandEnv.KVVI_TEST_PG_BIN = pgRoot

async function unusedPort() {
  const server = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    return server.address().port
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
async function running() {
  const code = await command(pg + 'pg_ctl', ['-D', dir, 'status'], { cleanup: true, timeout: 10000, allowStatus: [3, 4] })
  return code === 0
}

try {
  const port = await unusedPort()
  console.log(`Isolated test cluster: ${dir}; port ${port}`)
  await command(pg + 'initdb', ['-D', dir, '-U', 'kvvi', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
  await command(pg + 'pg_ctl', ['-D', dir, '-l', join(dir, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${dir}`, '-t', '20', '-w', 'start'])
  for (const [name, user, db] of [['ADMIN', 'kvvi', 'postgres'], ['PLATFORM', 'kvvi_platform', 'kvvi_platform'], ['BUSINESS', 'kvvi_business', 'kvvi_business'], ['AUDIT', 'kvvi_audit_writer', 'kvvi_audit'], ['AUDITREAD', 'kvvi_audit_reader', 'kvvi_audit']]) {
    commandEnv[`KVVI_${name}_DSN`] = `postgres://${user}:kvvi-test@127.0.0.1:${port}/${db}`
  }
  commandEnv.KVVI_TEST_CLUSTER_MARKER = JSON.stringify({ kind: 'kvvi-disposable-test-cluster', dataDirectory: dir, port })
  commandEnv.KVVI_SIGNING_KEY_PATH = join(dir, 'test-signing.key')
  await command(process.argv[2], process.argv.slice(3), { inherit: true, timeout: 0, cleanupGroupOnExit: true })
} catch (error) {
  result = signalCodes[cancelled] ?? error.exitStatus ?? 1
  console.error(`Isolated test run failed: ${error.message}`)
} finally {
  let cleanupFailed = false
  // start may have succeeded even when its command returned an error/lost acknowledgement.
  try {
    if (existsSync(join(dir, 'PG_VERSION')) && await running()) {
      try {
        await command(pg + 'pg_ctl', ['-D', dir, '-m', 'fast', '-t', '15', '-w', 'stop'], { cleanup: true, timeout: 20000 })
      } catch (error) {
        cleanupFailed = true
        console.error(`Test cluster stop failed: ${error.message}`)
        if (await running()) await command(pg + 'pg_ctl', ['-D', dir, '-m', 'immediate', '-t', '10', '-w', 'stop'], { cleanup: true, timeout: 15000 })
      }
      if (await running()) throw new Error('cluster still running after stop')
    }
    console.log('Test cluster is not running; retained for evidence:', dir)
  } catch (error) {
    cleanupFailed = true
    console.error(`Test cluster cleanup unconfirmed: ${error.message}; retained for evidence: ${dir}`)
  }
  if ((cleanupFailed || diagnosticFailed) && result === 0) result = 1
  if (cancelled) result = signalCodes[cancelled]
  for (const signal of Object.keys(signalCodes)) process.off(signal, cancel)
}
process.exitCode = result

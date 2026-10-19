// Exercises only clusters and executable wrappers owned by this test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const runner = fileURLToPath(new URL('./run-isolated.mjs', import.meta.url))
const pgDir = process.env.KVVI_TEST_PG_BIN || (existsSync('/opt/homebrew/opt/postgresql@17/bin/initdb') ? '/opt/homebrew/opt/postgresql@17/bin' : '')
const enabled = pgDir && existsSync(join(pgDir, 'initdb')) && existsSync(join(pgDir, 'pg_ctl'))

function fixture(mode) {
  const root = mkdtempSync(join(tmpdir(), 'kvvi-runner-probe-'))
  const tools = join(root, 'tools'); mkdirSync(tools)
  const state = join(root, 'data-dir'), calls = join(root, 'calls'), started = join(root, 'started')
  for (const tool of ['initdb', 'pg_ctl']) {
    const source = `#!${process.execPath}
import {writeFileSync,appendFileSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), tool=${JSON.stringify(tool)}, mode=${JSON.stringify(mode)};
const dir=args[args.indexOf('-D')+1];
writeFileSync(${JSON.stringify(state)},dir);
appendFileSync(${JSON.stringify(calls)},tool+' '+args.join(' ')+'\\n');
if(tool==='initdb' && mode==='init-fail') {writeFileSync(dir+'/partial','owned');console.error('owned-initdb-error-sentinel');process.exit(41)}
if(tool==='initdb' && mode==='cancel-init') {writeFileSync(dir+'/partial','owned');writeFileSync(${JSON.stringify(started)},'yes');setTimeout(()=>process.exit(47),5000);await new Promise(()=>{});}
if(tool==='pg_ctl' && args.includes('stop') && args.includes('fast') && mode==='stop-before-fail') process.exit(44);
if(tool==='pg_ctl' && args.includes('start') && mode==='start-before-fail') process.exit(42);
const r=spawnSync(${JSON.stringify(join(pgDir, tool))},args,{stdio:'inherit'});
if(tool==='pg_ctl' && args.includes('start') && r.status===0) {
 writeFileSync(${JSON.stringify(started)},'yes');
 if(mode==='diagnostic-fail') chmodSync(dir+'-logs',0o500);
 if(mode==='start-after-fail') process.exit(42);
 if(mode==='cancel-start') {setTimeout(()=>process.exit(47),5000);await new Promise(()=>{});}
}
if(tool==='pg_ctl' && args.includes('stop') && mode==='stop-confirmation-fail') process.exit(44);
process.exit(r.status??1);
`
    writeFileSync(join(tools, tool), source, { mode: 0o700 })
  }
  const env = { ...process.env, KVVI_TEST_PG_BIN: tools, KVVI_BUSINESS_DSN: 'must-not-be-used', KVVI_SIGNING_KEY_PATH: 'must-not-be-used' }
  return { root, tools, state, calls, started, env }
}
function running(dir) {
  return spawnSync(join(pgDir, 'pg_ctl'), ['-D', dir, 'status'], { stdio: 'pipe' }).status === 0
}
function dispose(f) {
  if (existsSync(f.state)) {
    const dir = readFileSync(f.state, 'utf8')
    if (existsSync(dir+'-logs')) chmodSync(dir+'-logs', 0o700)
    // Directory was observed only from our generated wrapper's explicit -D.
    if (!dir.startsWith(join(tmpdir(), 'kvvi-group-test-'))) throw new Error('unexpected test directory')
    spawnSync(join(pgDir, 'pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe', timeout: 20000 })
    if (!running(dir)) { rmSync(dir, { recursive: true, force: true }); rmSync(dir+'-logs', { recursive: true, force: true }) }
  }
  rmSync(f.root, { recursive: true, force: true })
}
function launch(f, command = [process.execPath, '-e', 'process.exit(0)']) {
  const child = spawn(process.execPath, [runner, ...command], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
  return { child, done: new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output }))
  }) }
}
async function waitFor(path) {
  for (let i = 0; i < 400; i++) { if (existsSync(path)) return; await delay(25) }
  throw new Error('owned test process did not reach checkpoint')
}

for (const mode of ['init-fail', 'start-before-fail', 'start-after-fail', 'stop-confirmation-fail', 'stop-before-fail', 'diagnostic-fail']) {
  test(`isolated runner retains a failure and stops its cluster: ${mode}`, { skip: !enabled, timeout: 45000 }, async () => {
    const f = fixture(mode)
    try {
      const result = await launch(f).done
      assert.notEqual(result.code, 0)
      assert.ok(existsSync(f.state))
      const dir = readFileSync(f.state, 'utf8')
      assert.equal(running(dir), false, `runner left an owned cluster running: ${dir}`)
      assert.ok(result.output.includes(dir), 'evidence directory must be reported even on startup failure')
      if (mode === 'stop-before-fail') assert.match(readFileSync(f.calls, 'utf8'), /-m immediate/)
      if (mode.startsWith('stop-')) assert.match(result.output, /Test cluster stop failed/)
      assert.equal(existsSync(join(dir, mode === 'init-fail' ? 'partial' : 'PG_VERSION')), true)
      if (mode === 'init-fail') {
        const log = readdirSync(dir+'-logs').find(name => name.endsWith('-initdb.log'))
        assert.ok(log, 'initialization diagnostics must survive before server.log exists')
        assert.match(readFileSync(join(dir+'-logs', log), 'utf8'), /owned-initdb-error-sentinel/)
      }
    } finally { dispose(f) }
  })
}

test('isolated runner preserves child exit and sanitizes pilot configuration', { skip: !enabled, timeout: 45000 }, async () => {
  const f = fixture('normal')
  try {
    const result = await launch(f, [process.execPath, '-e', `
      const marker=JSON.parse(process.env.KVVI_TEST_CLUSTER_MARKER);
      if(!process.env.KVVI_BUSINESS_DSN.includes('127.0.0.1:'+marker.port+'/')) process.exit(51);
      if(process.env.KVVI_SIGNING_KEY_PATH==='must-not-be-used') process.exit(52);
      process.exit(43);
    `]).done
    assert.equal(result.code, 43)
    assert.equal(running(readFileSync(f.state, 'utf8')), false)
  } finally { dispose(f) }
})

test('isolated runner cleans up when test executable is missing', { skip: !enabled, timeout: 45000 }, async () => {
  const f = fixture('normal')
  try {
    const result = await launch(f, [join(f.root, 'not-an-executable')]).done
    assert.notEqual(result.code, 0)
    assert.equal(running(readFileSync(f.state, 'utf8')), false)
  } finally { dispose(f) }
})

for (const mode of ['cancel-init', 'cancel-start', 'cancel-test']) {
  const signal = mode === 'cancel-init' ? 'SIGINT' : 'SIGTERM'
  test(`isolated runner stops after ${signal} during ${mode}`, { skip: !enabled, timeout: 45000 }, async () => {
    const f = fixture(mode)
    let run
    try {
      const testReady = join(f.root, 'test-ready')
      run = launch(f, [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(testReady)},'yes');setTimeout(()=>process.exit(0),3000)`])
      await waitFor(mode === 'cancel-test' ? testReady : f.started)
      run.child.kill(signal)
      const result = await run.done
      assert.equal(result.code, signal === 'SIGINT' ? 130 : 143)
      assert.equal(running(readFileSync(f.state, 'utf8')), false)
    } finally {
      if (run?.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
      dispose(f)
    }
  })
}

test('cancelled test also reaps a same-group descendant which ignores SIGTERM', { skip: !enabled || process.platform === 'win32', timeout: 45000 }, async () => {
  const f = fixture('normal')
  const ready = join(f.root, 'descendant-ready')
  let run, descendant
  try {
    const descendantCode = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(0),10000)`
    const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),10000)`
    run = launch(f, [process.execPath, '-e', code])
    await waitFor(ready)
    descendant = Number(readFileSync(ready, 'utf8'))
    run.child.kill('SIGTERM')
    assert.equal((await run.done).code, 143)
    let alive = true
    for (let i = 0; i < 40; i++) {
      const state = spawnSync('ps', ['-p', String(descendant), '-o', 'stat='], { encoding: 'utf8' })
      alive = state.status === 0 && !state.stdout.trim().startsWith('Z')
      if (!alive) break
      await delay(25)
    }
    assert.equal(alive, false, 'cancelled command left a stubborn descendant running')
    assert.equal(running(readFileSync(f.state, 'utf8')), false)
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    if (run?.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
    dispose(f)
  }
})

test('a normally exited failing test leaves no same-group descendant and retains its exit code', { skip: !enabled || process.platform === 'win32', timeout: 45000 }, async () => {
  const f = fixture('normal'), ready = join(f.root, 'descendant-ready')
  let descendant
  try {
    const childCode = `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(0),10000)`
    const code = `const fs=require('fs');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(poll);process.exit(43)}},25)`
    const result = await launch(f, [process.execPath, '-e', code]).done
    assert.equal(result.code, 43)
    descendant = Number(readFileSync(ready, 'utf8'))
    let alive = true
    for (let i = 0; i < 40; i++) {
      const state = spawnSync('ps', ['-p', String(descendant), '-o', 'stat='], { encoding: 'utf8' })
      alive = state.status === 0 && !state.stdout.trim().startsWith('Z')
      if (!alive) break
      await delay(25)
    }
    assert.equal(alive, false, 'normal test failure left a descendant running')
    assert.equal(running(readFileSync(f.state, 'utf8')), false)
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    dispose(f)
  }
})

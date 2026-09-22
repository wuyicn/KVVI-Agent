import { readFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.DSH_NODE_FLOW_ISOLATED_RUNTIME !== '1') {
  throw new Error('Polling trigger regression must run against the isolated runtime harness')
}

const baseUrl = process.env.DSH_WEB_URL
if (!baseUrl) throw new Error('DSH_WEB_URL is required')

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `runtime-polling-${suffix}`
const workflowName = `Runtime polling ${suffix}`
const credentialName = `Runtime polling credential ${suffix}`
const secret = `runtime-polling-secret-${suffix}`
const nativeFetch = globalThis.fetch
const requests = []
let responseStatus = 200
let responseBody = [{ id: 1, title: 'existing' }]
let releaseGate
let markGateReached
let gateReleased
let gateReached

function resetGate() {
  gateReleased = new Promise((resolve) => { releaseGate = resolve })
  gateReached = new Promise((resolve) => { markGateReached = resolve })
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (!url.startsWith('https://api.github.com/')) return nativeFetch(input, init)
  requests.push({ url, method: init?.method, headers: { ...(init?.headers ?? {}) } })
  if (gateReleased) {
    markGateReached?.()
    await gateReleased
    gateReleased = undefined
    gateReached = undefined
    releaseGate = undefined
    markGateReached = undefined
  }
  return new Response(JSON.stringify(responseBody), { status: responseStatus, headers: { 'content-type': 'application/json' } })
}

async function request(path, init = {}) {
  const response = await nativeFetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

async function requestJson(path, init = {}) {
  const result = await request(path, init)
  if (!result.response.ok) throw new Error(result.data.error || `HTTP ${result.response.status}`)
  return result.data
}

function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

function postRaw(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

function workflowDocument(repo = 'widget') {
  return {
    version: 1,
    name: workflowName,
    nodes: [
      {
        id: 'poll-trigger',
        type: 'workflow',
        position: { x: 80, y: 160 },
        data: {
          kind: 'connector-trigger',
          label: 'New GitHub issue',
          connectorId: 'github',
          connectorTrigger: 'new-issue',
          connectorParams: { owner: 'acme', repo },
          credentialId,
          pollInterval: '15',
        },
      },
      { id: 'output', type: 'workflow', position: { x: 360, y: 160 }, data: { kind: 'output', label: 'Issue ID', template: '{{result.id}}' } },
    ],
    edges: [{ id: 'poll-output', source: 'poll-trigger', target: 'output' }],
  }
}

async function waitForTrigger(predicate, timeout = 6_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const listed = await requestJson('/dsh-node-flow/polling-triggers')
    const trigger = listed.triggers?.find((candidate) => candidate.id === `workflow:${workflowId}:poll-trigger`)
    if (trigger && predicate(trigger)) return trigger
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('Timed out waiting for polling trigger state')
}

async function workflowRuns() {
  const listed = await requestJson('/dsh-node-flow/runs')
  return (listed.runs ?? []).filter((run) => run.workflowId === workflowId)
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ runs: [] }))
  for (const run of runs.runs ?? []) {
    if (run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ workflows: [] }))
  const workflow = workflows.workflows?.find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
  const credentials = await requestJson('/dsh-node-flow/credentials').catch(() => ({ credentials: [] }))
  for (const credential of credentials.credentials ?? []) {
    if (credential.name === credentialName) await post('/dsh-node-flow/credentials', { action: 'delete', id: credential.id }).catch(() => undefined)
  }
}

let credentialId
try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.capabilities?.pollingTriggers !== true) throw new Error('Runtime does not expose polling trigger capability')
  const catalog = await requestJson('/dsh-node-flow/connectors')
  const github = catalog.connectors?.find((connector) => connector.id === 'github')
  if (!github?.triggers?.some((trigger) => trigger.id === 'new-issue')) throw new Error('GitHub polling trigger is missing from the catalog')
  if (github.triggers.some((trigger) => 'build' in trigger || 'extract' in trigger || 'key' in trigger)) throw new Error('Polling trigger catalog leaked executable functions')

  const credential = await post('/dsh-node-flow/credentials', { action: 'save', credential: { name: credentialName, kind: 'bearer', secret: { value: secret } } })
  credentialId = credential.credential?.id
  if (!credentialId || JSON.stringify(credential).includes(secret)) throw new Error('Polling credential save leaked a secret')

  const now = new Date().toISOString()
  let saved = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: { id: workflowId, name: workflowName, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc: workflowDocument() },
  })
  saved = await post('/dsh-node-flow/workflows', { action: 'status', id: workflowId, status: 'enabled', expectedRevision: saved.workflow.revision })
  const baseline = await waitForTrigger((trigger) => trigger.initialized && !trigger.active)
  if (baseline.lastError || (await workflowRuns()).length !== 0) throw new Error('First polling pass replayed historical events')
  if (requests[0]?.headers?.Authorization !== `Bearer ${secret}`) throw new Error('Encrypted credential was not injected into polling request')

  responseBody = [{ id: 2, title: 'new' }, { id: 2, title: 'duplicate' }, { id: 1, title: 'existing' }]
  resetGate()
  const firstPoll = postRaw('/dsh-node-flow/polling-triggers', { action: 'poll', id: `workflow:${workflowId}:poll-trigger` })
  await Promise.race([gateReached, new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for claimed poll')), 5_000))])
  const visibleActive = await waitForTrigger((trigger) => trigger.active)
  if (!visibleActive.active) throw new Error('Claimed poll was not reported as active')
  const duplicatePoll = await postRaw('/dsh-node-flow/polling-triggers', { action: 'poll', id: `workflow:${workflowId}:poll-trigger` })
  if (duplicatePoll.response.status !== 409) throw new Error(`Concurrent poll returned ${duplicatePoll.response.status}`)
  releaseGate()
  const completedPoll = await firstPoll
  if (!completedPoll.response.ok || completedPoll.data.trigger?.active) throw new Error(`Claimed poll did not complete: ${JSON.stringify(completedPoll.data)}`)

  const firstRuns = await workflowRuns()
  if (firstRuns.length !== 1 || firstRuns[0].status !== 'ok' || firstRuns[0].value !== '2') throw new Error(`Polling event did not produce exactly one run: ${JSON.stringify(firstRuns)}`)
  await post('/dsh-node-flow/polling-triggers', { action: 'poll', id: `workflow:${workflowId}:poll-trigger` })
  if ((await workflowRuns()).length !== 1) throw new Error('Polling trigger delivered a duplicate event twice')

  responseStatus = 503
  responseBody = { message: `provider body ${secret}` }
  const failureStarted = Date.now()
  const failedPoll = await post('/dsh-node-flow/polling-triggers', { action: 'poll', id: `workflow:${workflowId}:poll-trigger` })
  if (failedPoll.trigger?.lastError !== '连接器请求失败：HTTP 503') throw new Error(`Polling failure exposed an unsafe error: ${JSON.stringify(failedPoll)}`)
  if (Date.parse(failedPoll.trigger.nextPollAt) < failureStarted + 55_000) throw new Error('Polling failure did not apply the minimum backoff')
  const publicState = JSON.stringify(await requestJson('/dsh-node-flow/polling-triggers'))
  for (const forbidden of ['cursor', 'recentKeys', 'configurationHash', 'claimedAt', secret, 'provider body']) {
    if (publicState.includes(forbidden)) throw new Error(`Polling API leaked ${forbidden}`)
  }

  responseStatus = 200
  responseBody = [{ id: 9, title: 'new baseline' }]
  let current = (await requestJson('/dsh-node-flow/workflows')).workflows.find((workflow) => workflow.id === workflowId)
  saved = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: current.revision, workflow: { ...current, doc: workflowDocument('widget-next') } })
  saved = await post('/dsh-node-flow/workflows', { action: 'status', id: workflowId, status: 'enabled', expectedRevision: saved.workflow.revision })
  await waitForTrigger((trigger) => trigger.initialized && !trigger.active && !trigger.lastError)
  if ((await workflowRuns()).length !== 1) throw new Error('Changed polling configuration did not establish a new baseline')
  if (!requests.some((entry) => entry.url.includes('/repos/acme/widget-next/issues'))) throw new Error('Published polling configuration was not applied')

  const disabled = await post('/dsh-node-flow/workflows', { action: 'status', id: workflowId, status: 'disabled', expectedRevision: saved.workflow.revision })
  const afterDisable = await requestJson('/dsh-node-flow/polling-triggers')
  if (afterDisable.triggers?.some((trigger) => trigger.id === `workflow:${workflowId}:poll-trigger`)) throw new Error('Disabled workflow retained polling state')

  if (process.env.DSH_HOME) {
    const disk = readFileSync(join(process.env.DSH_HOME, 'workflow-canvas', 'polling-triggers.json'), 'utf8')
    if (disk.includes(secret)) throw new Error('Polling state persisted credential material')
  }

  await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: disabled.workflow.revision })
  await post('/dsh-node-flow/credentials', { action: 'delete', id: credentialId })
  console.log(JSON.stringify({ ok: true, baseline: true, deduplicated: true, concurrentClaim: true, credentialInjected: true, failureBackoff: true, stateHidden: true, disabledCleanup: true }, null, 2))
} finally {
  releaseGate?.()
  globalThis.fetch = nativeFetch
  await cleanup().catch(() => undefined)
}

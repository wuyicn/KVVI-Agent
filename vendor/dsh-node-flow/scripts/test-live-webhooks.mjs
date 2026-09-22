import { createHmac } from 'node:crypto'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-webhook-${suffix}`
const workflowName = `Live Webhook ${suffix}`
const credentialName = `__webhook_${suffix}`
const secret = `webhook-secret-${suffix}`
const token = `webhooktoken${suffix.replaceAll('-', '')}abcdef`
let current
let credential

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

async function cleanup() {
  const listed = await requestJson('/dsh-node-flow/workflows')
  const workflow = listed.data.workflows?.find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
  const credentials = await requestJson('/dsh-node-flow/credentials')
  for (const candidate of credentials.data.credentials ?? []) {
    if (candidate.name === credentialName) await post('/dsh-node-flow/credentials', { action: 'delete', id: candidate.id }).catch(() => undefined)
  }
  const runs = await requestJson('/dsh-node-flow/runs')
  for (const run of runs.data.runs ?? []) {
    if (run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
}

try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.data.capabilities?.webhookSignatures !== true || capabilities.data.capabilities?.webhookResponses !== true || capabilities.data.capabilities?.webhookIdempotency !== true) {
    throw new Error('Running DSH backend does not expose advanced Webhook capabilities')
  }
  const savedCredential = await post('/dsh-node-flow/credentials', {
    action: 'save',
    credential: { name: credentialName, kind: 'webhook-secret', secret: { value: secret } },
  })
  if (!savedCredential.response.ok || savedCredential.data.credential?.kind !== 'webhook-secret') throw new Error(`Webhook Secret creation failed: ${JSON.stringify(savedCredential.data)}`)
  credential = savedCredential.data.credential

  const now = new Date().toISOString()
  const doc = {
    version: 1,
    name: workflowName,
    nodes: [
      {
        id: 'webhook',
        type: 'workflow',
        position: { x: 80, y: 160 },
        data: {
          kind: 'webhook',
          label: 'Signed Webhook',
          httpMethod: 'POST',
          webhookToken: token,
          credentialId: credential.id,
          webhookSignatureHeader: 'x-test-signature',
          webhookIdempotencyHeader: 'idempotency-key',
          webhookIdempotencyTtl: '3600',
          webhookResponseMode: 'custom',
          webhookResponseStatus: '202',
          webhookResponseHeaders: '{"content-type":"application/json","x-event":"{{result}}"}',
          webhookResponseBody: '{"accepted":true,"event":"{{result}}"}',
        },
      },
      { id: 'output', type: 'workflow', position: { x: 380, y: 160 }, data: { kind: 'output', label: 'Event', template: '{{result.body.event}}' } },
    ],
    edges: [{ id: 'edge', source: 'webhook', target: 'output' }],
  }
  let result = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: 0, workflow: { id: workflowId, name: workflowName, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc } })
  if (!result.response.ok) throw new Error(result.data.error || `Workflow creation failed: ${result.response.status}`)
  current = result.data.workflow
  result = await post('/dsh-node-flow/workflows', { action: 'status', id: workflowId, status: 'enabled', expectedRevision: current.revision })
  if (!result.response.ok) throw new Error(result.data.error || `Workflow publish failed: ${result.response.status}`)
  current = result.data.workflow

  const beforeRuns = await requestJson('/dsh-node-flow/runs')
  const body = JSON.stringify({ event: 'created' })
  const invalid = await fetch(`${baseUrl}/dsh-node-flow/webhook?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': 'sha256=00' },
    body,
  })
  if (invalid.status !== 401) throw new Error(`Invalid signature was not rejected: ${invalid.status}`)
  const afterInvalidRuns = await requestJson('/dsh-node-flow/runs')
  if ((afterInvalidRuns.data.runs?.length ?? 0) !== (beforeRuns.data.runs?.length ?? 0)) throw new Error('Invalid signature created a run record')

  const signature = createHmac('sha256', secret).update(body).digest('hex')
  const accepted = await fetch(`${baseUrl}/dsh-node-flow/webhook?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': `sha256=${signature}`, 'idempotency-key': 'delivery-1' },
    body,
  })
  const responseBody = await accepted.text()
  if (accepted.status !== 202) throw new Error(`Signed webhook returned HTTP ${accepted.status}: ${responseBody}`)
  if (accepted.headers.get('x-event') !== 'created' || !accepted.headers.get('x-dsh-run-id')) throw new Error('Custom webhook headers were not returned')
  if (responseBody !== '{"accepted":true,"event":"created"}') throw new Error(`Unexpected webhook response body: ${responseBody}`)

  const replay = await fetch(`${baseUrl}/dsh-node-flow/webhook?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': `sha256=${signature}`, 'idempotency-key': 'delivery-1' },
    body,
  })
  const replayBody = await replay.text()
  if (replay.status !== accepted.status || replayBody !== responseBody || replay.headers.get('x-dsh-idempotent-replay') !== 'true') throw new Error(`Webhook duplicate did not replay the first response: ${replay.status} ${replayBody}`)

  const changedBody = JSON.stringify({ event: 'changed' })
  const changedSignature = createHmac('sha256', secret).update(changedBody).digest('hex')
  const conflict = await fetch(`${baseUrl}/dsh-node-flow/webhook?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': `sha256=${changedSignature}`, 'idempotency-key': 'delivery-1' },
    body: changedBody,
  })
  if (conflict.status !== 409) throw new Error(`Webhook idempotency conflict was not rejected: ${conflict.status}`)

  const missingKey = await fetch(`${baseUrl}/dsh-node-flow/webhook?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-signature': `sha256=${signature}` },
    body,
  })
  if (missingKey.status !== 400) throw new Error(`Webhook missing idempotency key was not rejected: ${missingKey.status}`)

  const persisted = await requestJson('/dsh-node-flow/runs')
  const run = persisted.data.runs?.find((candidate) => candidate.workflowId === workflowId)
  if (run?.status !== 'ok') throw new Error('Signed webhook run was not persisted')
  if (JSON.stringify(run).includes(signature) || JSON.stringify(run).includes(secret) || JSON.stringify(run).includes('delivery-1')) throw new Error('Webhook signature, secret, or idempotency key leaked into run history')

  console.log(JSON.stringify({ ok: true, signatureRejectedBeforeRun: true, signedRun: true, duplicateReplay: true, conflictRejected: true, missingKeyRejected: true, customStatus: accepted.status, customHeader: accepted.headers.get('x-event'), secretHidden: true }, null, 2))
} finally {
  await cleanup().catch(() => undefined)
}

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claimWebhookIdempotency, completeWebhookIdempotency, removeWebhookIdempotencyWorkflow } from '../src/webhookIdempotencyStore.js'

test('claims, replays, rejects conflicts, expires, and encrypts webhook responses', () => {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'dsh-webhook-idempotency-'))
  const base = { workflowId: 'workflow', nodeId: 'webhook', method: 'POST', key: 'delivery-1', fingerprint: 'fingerprint-a', runId: 'run-1', ttlSeconds: 60, now: 1_000 }
  const claimed = claimWebhookIdempotency(dataDirectory, base)
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimWebhookIdempotency(dataDirectory, { ...base, runId: 'run-2' }).kind, 'processing')
  completeWebhookIdempotency(dataDirectory, claimed.kind === 'claimed' ? claimed.id : '', { status: 202, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', runId: 'run-1' })
  const replay = claimWebhookIdempotency(dataDirectory, { ...base, runId: 'run-3' })
  assert.equal(replay.kind, 'replay')
  assert.equal(replay.kind === 'replay' ? replay.response.body : '', '{"ok":true}')
  assert.equal(claimWebhookIdempotency(dataDirectory, { ...base, fingerprint: 'fingerprint-b', runId: 'run-4' }).kind, 'conflict')
  assert.equal(claimWebhookIdempotency(dataDirectory, { ...base, now: 62_000, runId: 'run-5' }).kind, 'claimed')
  const persisted = readFileSync(join(dataDirectory, 'webhook-idempotency.json'), 'utf8')
  assert.equal(persisted.includes('{"ok":true}'), false)
  removeWebhookIdempotencyWorkflow(dataDirectory, 'workflow')
  assert.equal(JSON.parse(readFileSync(join(dataDirectory, 'webhook-idempotency.json'), 'utf8')).length, 0)
})

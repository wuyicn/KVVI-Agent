import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { buildWebhookSuccessResponse, normalizeWebhookIdempotencyHeader, normalizeWebhookIdempotencyKey, normalizeWebhookIdempotencyTtl, normalizeWebhookSignatureHeader, parseWebhookResponseHeaders, verifyWebhookSignature, webhookIdempotencyId, webhookRequestFingerprint } from '../src/webhookProtocol.js'

test('normalizes webhook idempotency settings and fingerprints requests', () => {
  assert.equal(normalizeWebhookIdempotencyHeader(undefined), undefined)
  assert.equal(normalizeWebhookIdempotencyHeader('X-Request-Id'), 'x-request-id')
  assert.equal(normalizeWebhookIdempotencyTtl(undefined), 86400)
  assert.throws(() => normalizeWebhookIdempotencyHeader('Authorization'), /幂等键 Header 名称无效/)
  assert.throws(() => normalizeWebhookIdempotencyTtl('30'), /60 秒/)
  assert.throws(() => normalizeWebhookIdempotencyKey('bad\nkey'), /不含换行/)
  assert.notEqual(webhookIdempotencyId('workflow', 'node', 'POST', 'a'), webhookIdempotencyId('workflow', 'node', 'POST', 'b'))
  assert.equal(webhookRequestFingerprint('workflow', 'node', 'POST', Buffer.from('a')), webhookRequestFingerprint('workflow', 'node', 'POST', Buffer.from('a')))
  assert.notEqual(webhookRequestFingerprint('workflow', 'node', 'POST', Buffer.from('a')), webhookRequestFingerprint('workflow', 'node', 'POST', Buffer.from('b')))
})

test('verifies HMAC-SHA256 webhook signatures in hex and base64', () => {
  const body = Buffer.from('{"event":"created"}')
  const secret = 'webhook-secret-value-123'
  const hex = createHmac('sha256', secret).update(body).digest('hex')
  const base64 = createHmac('sha256', secret).update(body).digest('base64')
  assert.equal(verifyWebhookSignature(body, secret, `sha256=${hex}`), true)
  assert.equal(verifyWebhookSignature(body, secret, base64), true)
  assert.equal(verifyWebhookSignature(body, secret, 'sha256=00'), false)
  assert.equal(verifyWebhookSignature(Buffer.from('{}'), secret, hex), false)
})

test('validates signature and response header names', () => {
  assert.equal(normalizeWebhookSignatureHeader(undefined), 'x-dsh-signature-256')
  assert.equal(normalizeWebhookSignatureHeader('X-Hub-Signature-256'), 'x-hub-signature-256')
  assert.throws(() => normalizeWebhookSignatureHeader('bad header'), /Header 名称无效/)
  assert.deepEqual(parseWebhookResponseHeaders('{"X-Result":"{{result.id}}"}'), { 'x-result': '{{result.id}}' })
  assert.throws(() => parseWebhookResponseHeaders('{"Set-Cookie":"token=secret"}'), /不允许使用/)
  assert.throws(() => parseWebhookResponseHeaders('{"X-Test":"a\\nb"}'), /非法换行/)
})

test('builds summary, direct and custom webhook responses', () => {
  const summary = buildWebhookSuccessResponse({ kind: 'webhook', label: 'Webhook' }, { id: 7 }, 'run-1')
  assert.equal(summary.status, 200)
  assert.deepEqual(JSON.parse(summary.body), { ok: true, runId: 'run-1', value: { id: 7 }, status: 'ok' })

  const direct = buildWebhookSuccessResponse({ kind: 'webhook', label: 'Webhook', webhookResponseMode: 'output' }, { id: 8 }, 'run-2')
  assert.equal(direct.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(direct.body, '{"id":8}')

  const custom = buildWebhookSuccessResponse({
    kind: 'webhook',
    label: 'Webhook',
    webhookResponseMode: 'custom',
    webhookResponseStatus: '202',
    webhookResponseHeaders: '{"Content-Type":"application/json","X-Item":"{{result.id}}"}',
    webhookResponseBody: '{"accepted":true,"item":"{{result.id}}"}',
  }, { id: 'abc' }, 'run-3')
  assert.equal(custom.status, 202)
  assert.equal(custom.headers['x-item'], 'abc')
  assert.equal(custom.body, '{"accepted":true,"item":"abc"}')

  const escaped = buildWebhookSuccessResponse({
    kind: 'webhook',
    label: 'Webhook',
    webhookResponseMode: 'custom',
    webhookResponseHeaders: '{"content-type":"application/problem+json"}',
    webhookResponseBody: '{"message":"{{result}}"}',
  }, 'value "with quotes"', 'run-4')
  assert.deepEqual(JSON.parse(escaped.body), { message: 'value "with quotes"' })

  assert.throws(() => buildWebhookSuccessResponse({
    kind: 'webhook',
    label: 'Webhook',
    webhookResponseMode: 'custom',
    webhookResponseHeaders: '{"content-type":"application/json"}',
    webhookResponseBody: '{"message":"{{result}}",}',
  }, 'not-json', 'run-5'), /不是有效 JSON/)
})

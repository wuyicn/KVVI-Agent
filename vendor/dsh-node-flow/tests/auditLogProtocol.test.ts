import assert from 'node:assert/strict'
import test from 'node:test'
import { appendWorkflowAuditEvent, createWorkflowAuditEvent, normalizeWorkflowAuditEvent, sanitizeWorkflowAuditDetails } from '../src/auditLogProtocol.js'

const first = {
  id: 'audit-1',
  at: '2026-09-05T00:00:00.000Z',
  actor: 'local-user' as const,
  action: 'workflow.created' as const,
  target: { type: 'workflow' as const, id: 'workflow-1', name: 'Daily sync' },
}

test('keeps audit targets and metadata bounded and secret-free', () => {
  const details = sanitizeWorkflowAuditDetails({
    revision: 4,
    published: true,
    token: 'must-not-store',
    requestBody: '{"password":"must-not-store"}',
    status: 'connected',
    provider: 'Bearer should-not-store',
    nested: { value: 'must-not-store' },
  })
  assert.deepEqual(details, { revision: 4, published: true, status: 'connected', provider: '[redacted]' })

  const event = createWorkflowAuditEvent({ ...first, details, target: { ...first.target, name: 'Bearer must-not-store' } })
  assert.equal(event.target.name, '[redacted]')
  assert.equal(JSON.stringify(event).includes('must-not-store'), false)
})

test('normalizes persisted audit events and ignores malformed records', () => {
  const event = normalizeWorkflowAuditEvent({ ...first, at: '2026-09-05T08:00:00+08:00', details: { kind: 'oauth2' } })
  assert.equal(event?.at, '2026-09-05T00:00:00.000Z')
  assert.deepEqual(event?.details, { kind: 'oauth2' })
  assert.equal(normalizeWorkflowAuditEvent({ ...first, action: 'workflow.unknown' }), undefined)
  assert.equal(normalizeWorkflowAuditEvent({ ...first, target: { type: 'workflow' } }), undefined)
})

test('prepends unique audit events with bounded retention', () => {
  const second = createWorkflowAuditEvent({
    ...first,
    id: 'audit-2',
    at: '2026-09-05T01:00:00.000Z',
    action: 'workflow.published',
  })
  const third = createWorkflowAuditEvent({
    ...first,
    id: 'audit-3',
    at: '2026-09-05T02:00:00.000Z',
    action: 'workflow.disabled',
  })
  assert.deepEqual(appendWorkflowAuditEvent([first, second], third, 2).map((event) => event.id), ['audit-3', 'audit-2'])
  assert.deepEqual(appendWorkflowAuditEvent([first, second], { ...second, action: 'workflow.restored' }, 3).map((event) => event.id), ['audit-2', 'audit-1'])
})

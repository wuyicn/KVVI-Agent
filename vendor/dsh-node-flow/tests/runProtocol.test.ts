import assert from 'node:assert/strict'
import test from 'node:test'
import { createBlankWorkflowDocument, type WorkflowRunRecord } from '../src/model.js'
import { canResumeRun, recoverInterruptedRuns, upsertRunRecord } from '../src/runProtocol.js'

function run(status: WorkflowRunRecord['status']): WorkflowRunRecord {
  const snapshot = createBlankWorkflowDocument('恢复测试')
  return {
    id: 'run-a',
    name: '恢复测试',
    startedAt: '2026-09-03T01:00:00.000Z',
    status,
    nodeCount: 1,
    failed: 0,
    nodes: [],
    snapshot,
    checkpoint: { nodeId: snapshot.nodes[0].id, input: 'hello', updatedAt: '2026-09-03T01:01:00.000Z' },
  }
}

test('marks persisted running records as interrupted and resumable', () => {
  const recovered = recoverInterruptedRuns([run('running')], '2026-09-03T02:00:00.000Z')[0]
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.resumable, true)
  assert.equal(canResumeRun(recovered), true)
})

test('does not resume successful or snapshot-less runs', () => {
  assert.equal(canResumeRun(run('ok')), false)
  assert.equal(canResumeRun({ ...run('error'), snapshot: undefined }), false)
})

test('allows a cancelled run to continue from its persisted checkpoint', () => {
  assert.equal(canResumeRun(run('cancelled')), true)
})

test('requires a full rerun when multiple nodes failed', () => {
  assert.equal(canResumeRun({ ...run('error'), failed: 2 }), false)
})

test('does not expose child runs as independent recovery sources', () => {
  assert.equal(canResumeRun({ ...run('error'), parentRunId: 'parent-run' }), false)
})

test('upserts run records without duplicates', () => {
  const first = run('error')
  const changed = { ...first, status: 'ok' as const, completedAt: '2026-09-03T03:00:00.000Z' }
  const records = upsertRunRecord([first], changed)
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'ok')
})

test('retains active waiting runs beyond the completed history limit', () => {
  const waiting = { ...run('waiting'), id: 'waiting' }
  const history = Array.from({ length: 5 }, (_, index) => ({ ...run('ok'), id: `history-${index}`, startedAt: `2026-09-03T01:00:0${index}.000Z` }))
  const records = upsertRunRecord(history, waiting, 2)
  assert.equal(records.some((record) => record.id === 'waiting'), true)
  assert.equal(records.filter((record) => record.status === 'ok').length, 2)
})

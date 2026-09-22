import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkflowRunRecord } from '../src/model.js'
import { canStartQueuedWorkflowRun, countActiveWorkflowRootRuns, decideWorkflowConcurrency, normalizeWorkflowConcurrency, validateWorkflowConcurrency } from '../src/workflowConcurrencyProtocol.js'

function run(id: string, status: WorkflowRunRecord['status'], extra: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id,
    workflowId: 'workflow-1',
    name: id,
    startedAt: '2026-09-05T00:00:00.000Z',
    nodeCount: 0,
    status,
    failed: 0,
    nodes: [],
    ...extra,
  }
}

test('keeps legacy workflows parallel and normalizes bounded settings', () => {
  assert.deepEqual(normalizeWorkflowConcurrency(), { mode: 'parallel', maxConcurrent: 1, maxQueue: 50 })
  assert.deepEqual(normalizeWorkflowConcurrency({ mode: 'queue', maxConcurrent: 99, maxQueue: 999 }), { mode: 'queue', maxConcurrent: 20, maxQueue: 100 })
  assert.throws(() => validateWorkflowConcurrency({ mode: 'queue', maxConcurrent: 0 }), /最大并发/)
  assert.throws(() => validateWorkflowConcurrency({ mode: 'queue', maxQueue: -1 }), /最大排队数/)
})

test('skips or queues new root events at the configured limit', () => {
  const active = [run('active', 'running')]
  assert.deepEqual(decideWorkflowConcurrency({ mode: 'skip', maxConcurrent: 1 }, active, 'workflow-1'), {
    action: 'skip', active: 1, queued: 0, reason: '已有 1/1 个运行占用并发槽位',
  })
  assert.deepEqual(decideWorkflowConcurrency({ mode: 'queue', maxConcurrent: 1, maxQueue: 2 }, active, 'workflow-1'), {
    action: 'queue', active: 1, queued: 0,
  })
  const full = [...active, run('queued-1', 'queued', { queue: { trigger: 'webhook' } }), run('queued-2', 'queued', { queue: { trigger: 'schedule' } })]
  assert.equal(decideWorkflowConcurrency({ mode: 'queue', maxConcurrent: 1, maxQueue: 2 }, full, 'workflow-1').action, 'skip')
})

test('waitpoints retain one slot and their continuation does not double count it', () => {
  const waiting = run('wait', 'waiting')
  assert.equal(countActiveWorkflowRootRuns([waiting], 'workflow-1'), 1)
  const continuing = [run('wait', 'waiting', { resumedByRunId: 'continue' }), run('continue', 'running', { resumedFromRunId: 'wait' })]
  assert.equal(countActiveWorkflowRootRuns(continuing, 'workflow-1'), 1)
  assert.equal(canStartQueuedWorkflowRun({ mode: 'queue', maxConcurrent: 1 }, continuing, 'workflow-1'), false)
  assert.equal(canStartQueuedWorkflowRun({ mode: 'queue', maxConcurrent: 2 }, continuing, 'workflow-1'), true)
})

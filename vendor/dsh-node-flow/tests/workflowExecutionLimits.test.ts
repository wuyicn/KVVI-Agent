import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_WORKFLOW_DURATION_SECONDS, MAX_WORKFLOW_STEPS, normalizeWorkflowExecutionLimits, validateWorkflowExecutionLimits } from '../src/workflowExecutionLimits.js'

test('normalizes absent and bounded execution limits', () => {
  assert.deepEqual(normalizeWorkflowExecutionLimits(), { maxDurationSec: undefined, maxSteps: MAX_WORKFLOW_STEPS })
  assert.deepEqual(normalizeWorkflowExecutionLimits({ maxDurationSec: MAX_WORKFLOW_DURATION_SECONDS + 10, maxSteps: MAX_WORKFLOW_STEPS + 10 }), { maxDurationSec: MAX_WORKFLOW_DURATION_SECONDS, maxSteps: MAX_WORKFLOW_STEPS })
})

test('rejects invalid execution budgets', () => {
  assert.throws(() => validateWorkflowExecutionLimits({ maxDurationSec: 0 }), /最长运行时间/)
  assert.throws(() => validateWorkflowExecutionLimits({ maxSteps: MAX_WORKFLOW_STEPS + 1 }), /最大执行步数/)
  assert.doesNotThrow(() => validateWorkflowExecutionLimits({ maxDurationSec: 30, maxSteps: 100 }))
})

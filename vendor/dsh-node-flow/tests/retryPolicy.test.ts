import assert from 'node:assert/strict'
import test from 'node:test'
import { executeWithRetry, normalizeRetryPolicy, retryDelayMilliseconds } from '../src/retryPolicy.js'

test('retries a failed operation until it succeeds', async () => {
  let calls = 0
  const result = await executeWithRetry(async () => {
    calls += 1
    if (calls < 3) throw new Error('temporary failure')
    return 'ok'
  }, { retryCount: '2', retryDelay: '0', retryBackoff: 'fixed' })
  assert.equal(result.value, 'ok')
  assert.equal(result.attempts, 3)
})

test('normalizes and caps exponential retry delays', () => {
  const policy = normalizeRetryPolicy({ retryCount: '99', retryDelay: '2', retryBackoff: 'exponential' })
  assert.equal(policy.retries, 10)
  assert.equal(retryDelayMilliseconds(policy, 1), 2000)
  assert.equal(retryDelayMilliseconds(policy, 3), 8000)
})

test('stops retrying when the run is cancelled', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(executeWithRetry(async () => {
    calls += 1
    controller.abort(new Error('cancelled by test'))
    throw new Error('failure')
  }, { retryCount: '5', retryDelay: '1' }, controller.signal), /cancelled by test/)
  assert.equal(calls, 1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dsns } from '../src/db.mjs'
import { assertTestTarget } from './test-target.mjs'

test('refuses missing disposable cluster marker before any reset', () => {
  assert.throws(() => assertTestTarget(dsns(), undefined), /KVVI_UNSAFE_TEST_TARGET/)
})
test('refuses mismatched admin or runtime endpoints and connection overrides', () => {
  const marker = process.env.KVVI_TEST_CLUSTER_MARKER
  for (const key of Object.keys(dsns())) {
    for (const bad of ['postgres://x@127.0.0.1:55432/postgres', 'postgres://x@remote:59999/postgres', dsns()[key]+'?host=remote']) {
      assert.throws(() => assertTestTarget({...dsns(),[key]:bad},marker), /KVVI_UNSAFE_TEST_TARGET/)
    }
  }
})
test('accepts all connections only when they match the running disposable cluster', () => {
  assert.doesNotThrow(() => assertTestTarget(dsns(), process.env.KVVI_TEST_CLUSTER_MARKER))
  const marker = JSON.parse(process.env.KVVI_TEST_CLUSTER_MARKER)
  assert.throws(() => assertTestTarget(dsns(),JSON.stringify({...marker,dataDirectory:'/tmp/not-a-cluster'})), /KVVI_UNSAFE_TEST_TARGET/)
})

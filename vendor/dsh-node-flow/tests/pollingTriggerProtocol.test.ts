import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkflowDocument, WorkflowNodeData } from '../src/model.js'
import { claimDuePollingTriggers, completePollingTrigger, createPollingTriggerState, failPollingTrigger, pollingIntervalMs, pollingTriggerConfigurationHash, releaseOrphanedPollingClaims, syncPollingTriggerStates, validatePollingTriggerGraph } from '../src/pollingTriggerProtocol.js'

const data: WorkflowNodeData = { kind: 'connector-trigger', label: 'New issue', connectorId: 'github', connectorTrigger: 'new-issue', credentialId: 'credential-1', pollInterval: '60' }

test('creates, claims and releases persistent polling trigger state', () => {
  const state = createPollingTriggerState('workflow-1', 'trigger-1', data, 1000)
  const claimed = claimDuePollingTriggers([state], 1000)
  assert.equal(claimed.claimed.length, 1)
  assert.ok(claimed.states[0].claimedAt)
  assert.equal(releaseOrphanedPollingClaims(claimed.states)[0].claimedAt, undefined)
})

test('uses a baseline first poll and deduplicates later events', () => {
  const state = createPollingTriggerState('workflow-1', 'trigger-1', data, 1000)
  const baseline = completePollingTrigger(state, ['3', '2', '1'], 60_000, 'cursor-1', 2000)
  assert.deepEqual(baseline.newKeys, [])
  const next = completePollingTrigger(baseline.state, ['4', '3', '2'], 60_000, 'cursor-2', 3000)
  assert.deepEqual(next.newKeys, ['4'])
  assert.deepEqual(next.state.recentKeys.slice(0, 4), ['4', '3', '2', '1'])
})

test('preserves compatible state and resets changed trigger definitions', () => {
  const state = { ...createPollingTriggerState('workflow-1', 'trigger-1', data, 1000), initialized: true, recentKeys: ['1'] }
  const document = { version: 1, name: 'Test', nodes: [{ id: 'trigger-1', type: 'workflow', position: { x: 0, y: 0 }, data }], edges: [] } as WorkflowDocument
  assert.deepEqual(syncPollingTriggerStates([state], 'workflow-1', document, 2000)[0].recentKeys, ['1'])
  document.nodes[0].data = { ...data, connectorTrigger: 'new-comment' }
  assert.deepEqual(syncPollingTriggerStates([state], 'workflow-1', document, 2000)[0].recentKeys, [])
  document.nodes[0].data = { ...data, connectorParams: { owner: 'new-owner' } }
  assert.deepEqual(syncPollingTriggerStates([state], 'workflow-1', document, 2000)[0].recentKeys, [])
  assert.notEqual(pollingTriggerConfigurationHash(data), pollingTriggerConfigurationHash(document.nodes[0].data))
  assert.notEqual(pollingTriggerConfigurationHash(data), pollingTriggerConfigurationHash({ ...data, connectorVersion: 2 }))
})

test('resets polling state when a referenced project variable changes', () => {
  const variableData = { ...data, connectorParams: { owner: 'openai', channel: '{{vars.SLACK_CHANNEL}}' } }
  const document = { version: 1, name: 'Test', nodes: [{ id: 'trigger-1', type: 'workflow', position: { x: 0, y: 0 }, data: variableData }], edges: [] } as WorkflowDocument
  const initial = syncPollingTriggerStates([], 'workflow-1', document, 1000, { SLACK_CHANNEL: 'C1' })
  const active = [{ ...initial[0], initialized: true, recentKeys: ['1'] }]
  assert.deepEqual(syncPollingTriggerStates(active, 'workflow-1', document, 2000, { SLACK_CHANNEL: 'C1' })[0].recentKeys, ['1'])
  const reset = syncPollingTriggerStates(active, 'workflow-1', document, 3000, { SLACK_CHANNEL: 'C2' })
  assert.equal(reset[0].initialized, false)
  assert.deepEqual(reset[0].recentKeys, [])
})

test('backs off failures and validates polling graphs', () => {
  const state = createPollingTriggerState('workflow-1', 'trigger-1', data, 1000)
  assert.match(failPollingTrigger(state, 15_000, new Error('连接器请求失败'), 2000).lastError ?? '', /连接器请求失败/)
  assert.throws(() => pollingIntervalMs({ ...data, pollInterval: '5' }), /15/)
  const valid = { version: 1, name: 'Test', nodes: [{ id: 'trigger-1', type: 'workflow', position: { x: 0, y: 0 }, data }, { id: 'out', type: 'workflow', position: { x: 1, y: 0 }, data: { kind: 'output', label: 'Done' } }], edges: [{ id: 'e1', source: 'trigger-1', target: 'out' }] } as WorkflowDocument
  assert.doesNotThrow(() => validatePollingTriggerGraph(valid))
  assert.throws(() => validatePollingTriggerGraph({ ...valid, edges: [] }), /必须连接一个下游节点/)
})

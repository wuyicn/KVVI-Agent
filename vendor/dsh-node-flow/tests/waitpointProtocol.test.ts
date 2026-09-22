import assert from 'node:assert/strict'
import test from 'node:test'
import { canResolveWaitpoint, createDebugWaitpoint, createWorkflowWaitpoint, releaseOrphanedWaitpointClaims, sanitizeWaitpointRun, validateWorkflowDebugDocument, validateWorkflowWaitpoints, waitpointTimedOut, waitpointTokenHash, waitpointTokenMatches } from '../src/waitpointProtocol.js'
import type { WorkflowDocument, WorkflowRunRecord } from '../src/model.js'

test('normalizes delay and approval waitpoints', () => {
  const delay = createWorkflowWaitpoint({ kind: 'wait', label: 'Delay', waitAmount: '2', waitUnit: 'hours' }, 'wait', 'input', 0)
  assert.equal(delay.resumeAt, '1970-01-01T02:00:00.000Z')
  assert.equal(delay.input, 'input')
  const approval = createWorkflowWaitpoint({ kind: 'wait', label: 'Approve', waitMode: 'approval', waitTimeout: '1.5' }, 'approve', 'value', 0)
  assert.equal(approval.expiresAt, '1970-01-01T01:30:00.000Z')
  assert.throws(() => createWorkflowWaitpoint({ kind: 'wait', label: 'Bad', waitMode: 'unknown' }, 'bad', '', 0), /等待方式/)
  assert.throws(() => createWorkflowWaitpoint({ kind: 'wait', label: 'Bad', waitUnit: 'weeks', waitAmount: '1' }, 'bad', '', 0), /等待单位/)
})

test('hashes callback tokens and removes the hash from API records', () => {
  const token = 'a'.repeat(43)
  const waitpoint = { nodeId: 'wait', mode: 'callback' as const, createdAt: new Date(0).toISOString(), input: '', tokenHash: waitpointTokenHash(token) }
  assert.equal(waitpointTokenMatches(waitpoint, token), true)
  assert.equal(waitpointTokenMatches(waitpoint, `${token}x`), false)
  const run = { id: 'run', name: 'test', startedAt: new Date(0).toISOString(), status: 'waiting', nodeCount: 1, failed: 0, nodes: [], waitpoint } satisfies WorkflowRunRecord
  assert.equal(sanitizeWaitpointRun(run).waitpoint?.tokenHash, undefined)
})

test('only auto-resumes due delays and releases orphaned claims', () => {
  const snapshot: WorkflowDocument = {
    version: 1,
    name: 'wait',
    nodes: [{ id: 'wait', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'wait', label: 'Wait' } }],
    edges: [],
  }
  const base = { id: 'source', name: 'wait', startedAt: new Date(0).toISOString(), status: 'waiting', nodeCount: 1, failed: 0, nodes: [], snapshot } satisfies WorkflowRunRecord
  assert.equal(canResolveWaitpoint({ ...base, waitpoint: { nodeId: 'wait', mode: 'approval', createdAt: new Date(0).toISOString(), input: '' } }, 1000), false)
  assert.equal(canResolveWaitpoint({ ...base, waitpoint: { nodeId: 'wait', mode: 'delay', createdAt: new Date(0).toISOString(), input: '', resumeAt: new Date(500).toISOString() } }, 1000), true)
  const claimed = { ...base, resumedByRunId: 'missing', completedAt: new Date(1).toISOString(), waitpoint: { nodeId: 'wait', mode: 'callback' as const, createdAt: new Date(0).toISOString(), input: '' } }
  assert.equal(releaseOrphanedWaitpointClaims([claimed])[0].resumedByRunId, undefined)
  const recoverable = { ...base, id: 'continuation', status: 'interrupted' as const, resumable: true }
  assert.equal(releaseOrphanedWaitpointClaims([{ ...claimed, resumedByRunId: recoverable.id }, recoverable])[0].resumedByRunId, recoverable.id)
})

test('preserves child waitpoint linkage without treating it as an automatic wait', () => {
  const waitpoint = {
    nodeId: 'call-child',
    mode: 'child' as const,
    createdAt: new Date(0).toISOString(),
    input: '',
    childRunId: 'child-run',
    parentRunId: 'parent-run',
    parentNodeId: 'call-child',
  }
  const run = {
    id: 'parent-run',
    name: 'parent',
    startedAt: new Date(0).toISOString(),
    status: 'waiting' as const,
    nodeCount: 1,
    failed: 0,
    nodes: [],
    snapshot: { version: 1, name: 'parent', nodes: [{ id: 'call-child', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'call-workflow', label: 'Call child' } }], edges: [] },
    waitpoint,
  } satisfies WorkflowRunRecord
  assert.equal(canResolveWaitpoint(run, Number.MAX_SAFE_INTEGER), false)
  assert.deepEqual(sanitizeWaitpointRun(run).waitpoint, waitpoint)
})

test('rejects waits inside loops and unsafe fan-out', () => {
  const base: WorkflowDocument = {
    version: 1,
    name: 'wait graph',
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'wait', type: 'workflow', position: { x: 1, y: 0 }, data: { kind: 'wait', label: 'Wait', waitAmount: '1', waitUnit: 'seconds' } },
      { id: 'output', type: 'workflow', position: { x: 2, y: 0 }, data: { kind: 'output', label: 'Done' } },
    ],
    edges: [{ id: 'one', source: 'trigger', target: 'wait' }, { id: 'two', source: 'wait', target: 'output' }],
  }
  assert.doesNotThrow(() => validateWorkflowWaitpoints(base))
  assert.throws(() => validateWorkflowWaitpoints({ ...base, edges: [...base.edges, { id: 'parallel', source: 'trigger', target: 'output' }] }), /扇出/)
  const looped: WorkflowDocument = {
    ...base,
    nodes: [...base.nodes, { id: 'loop', type: 'workflow', position: { x: 0, y: 1 }, data: { kind: 'loop', label: 'Loop' } }],
    edges: [{ id: 'iterate', source: 'loop', sourceHandle: 'iterate', target: 'wait' }],
  }
  assert.throws(() => validateWorkflowWaitpoints(looped), /Loop/)
  const afterLoop: WorkflowDocument = {
    ...base,
    nodes: [...base.nodes, { id: 'loop', type: 'workflow', position: { x: 0, y: 1 }, data: { kind: 'loop', label: 'Loop' } }],
    edges: [{ id: 'start-loop', source: 'trigger', target: 'loop' }, { id: 'done-wait', source: 'loop', sourceHandle: 'done', target: 'wait' }, { id: 'wait-output', source: 'wait', target: 'output' }],
  }
  assert.doesNotThrow(() => validateWorkflowWaitpoints(afterLoop))
})

test('creates a debug waitpoint without any automatic resume or expiry', () => {
  const waitpoint = createDebugWaitpoint('node', 'safe input', 'step', 'previous', 0)
  assert.deepEqual(waitpoint, {
    nodeId: 'node',
    mode: 'debug',
    createdAt: '1970-01-01T00:00:00.000Z',
    input: 'safe input',
    debugReason: 'step',
    previousNodeId: 'previous',
  })
  const run = {
    id: 'debug-run',
    name: 'debug',
    startedAt: new Date(0).toISOString(),
    status: 'waiting' as const,
    nodeCount: 1,
    failed: 0,
    nodes: [],
    snapshot: {
      version: 1,
      name: 'debug',
      nodes: [{ id: 'node', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } }],
      edges: [],
    },
    waitpoint,
  } satisfies WorkflowRunRecord
  assert.equal(canResolveWaitpoint(run, Number.MAX_SAFE_INTEGER), false)
  assert.equal(waitpointTimedOut(waitpoint, Number.MAX_SAFE_INTEGER), false)
})

test('accepts only one connected manual linear path for debugger v1', () => {
  const linear: WorkflowDocument = {
    version: 1,
    name: 'debug-linear',
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'code', type: 'workflow', position: { x: 1, y: 0 }, data: { kind: 'code', label: 'Code' } },
      { id: 'output', type: 'workflow', position: { x: 2, y: 0 }, data: { kind: 'output', label: 'Done' } },
    ],
    edges: [{ id: 'first', source: 'trigger', target: 'code' }, { id: 'second', source: 'code', target: 'output' }],
  }
  assert.doesNotThrow(() => validateWorkflowDebugDocument(linear))
  assert.throws(() => validateWorkflowDebugDocument({ ...linear, edges: [...linear.edges, { id: 'fan-out', source: 'trigger', target: 'output' }] }), /单一路径/)
  assert.throws(() => validateWorkflowDebugDocument({ ...linear, edges: [...linear.edges, { id: 'loop', source: 'output', target: 'trigger' }] }), /入口不能有上游连线|循环图/)
  assert.throws(() => validateWorkflowDebugDocument({ ...linear, nodes: [...linear.nodes, { id: 'wait', type: 'workflow', position: { x: 3, y: 0 }, data: { kind: 'wait', label: 'Wait' } }] }), /线性工作流/)
  assert.throws(() => validateWorkflowDebugDocument({ ...linear, nodes: linear.nodes.map((node) => node.id === 'code' ? { ...node, data: { ...node.data, onError: 'route' as const } } : node) }), /错误分支/)
})

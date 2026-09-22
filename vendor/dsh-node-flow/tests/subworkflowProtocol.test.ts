import assert from 'node:assert/strict'
import test from 'node:test'
import type { SavedWorkflow, WorkflowContractField, WorkflowDocument } from '../src/model.js'
import {
  capturePublishedSubworkflows,
  normalizeWorkflowContract,
  renderSubworkflowInput,
  validateSubworkflowRuntimeCall,
  validateWorkflowContract,
} from '../src/subworkflowProtocol.js'

const documentOf = (name: string, target?: string): WorkflowDocument => ({
  version: 1,
  name,
  nodes: target ? [{ id: `call-${target}`, type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'call-workflow', label: '调用', workflowId: target } }] : [],
  edges: [],
})

const saved = (id: string, target?: string): SavedWorkflow => {
  const doc = documentOf(id, target)
  return {
    id,
    name: id,
    status: 'enabled',
    revision: 1,
    draftRevision: 1,
    publishedRevision: 1,
    publishedAt: '2026-09-04T00:00:00.000Z',
    publishedDoc: doc,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    doc,
  }
}

test('normalizes contracts and preserves unique valid fields', () => {
  const fields = normalizeWorkflowContract([
    { name: ' customer ', label: '客户', type: 'string', required: true },
    { name: 'customer', type: 'number' },
    { name: 'not-valid.name', type: 'object' },
  ])
  assert.deepEqual(fields, [{ name: 'customer', label: '客户', type: 'string', required: true, description: undefined }])
})

test('renders structured subworkflow input without losing object types', () => {
  const value = { customer: { id: 7 }, active: true }
  assert.deepEqual(renderSubworkflowInput('{{result.customer}}', value), { id: 7 })
  assert.deepEqual(renderSubworkflowInput('{"id":{{result.customer.id}},"active":{{result.active}}}', value), { id: 7, active: true })
})

test('validates required workflow contract fields and types', () => {
  const contract: WorkflowContractField[] = [{ name: 'id', type: 'number', required: true }]
  assert.deepEqual(validateWorkflowContract('{"id":7}', contract, '子工作流输入'), { id: 7 })
  assert.throws(() => validateWorkflowContract('{}', contract, '子工作流输入'), /缺少必填字段/)
  assert.throws(() => validateWorkflowContract('{"id":"7"}', contract, '子工作流输入'), /应为 number/)
})

test('captures immutable published snapshots recursively', () => {
  const snapshots = capturePublishedSubworkflows('root', documentOf('root', 'child'), [saved('child', 'grandchild'), saved('grandchild')])
  assert.deepEqual(Object.keys(snapshots).sort(), ['child', 'grandchild'])
  assert.equal(snapshots.child.publishedRevision, 1)
})

test('captures published child snapshots that contain a persistent Wait node', () => {
  const waitDocument: WorkflowDocument = {
    version: 1,
    name: 'child with wait',
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'wait', type: 'workflow', position: { x: 1, y: 0 }, data: { kind: 'wait', label: 'Wait', waitMode: 'callback' } },
      { id: 'output', type: 'workflow', position: { x: 2, y: 0 }, data: { kind: 'output', label: 'Done' } },
    ],
    edges: [{ id: 'first', source: 'trigger', target: 'wait' }, { id: 'second', source: 'wait', target: 'output' }],
  }
  const child = saved('child')
  child.publishedDoc = waitDocument
  child.doc = waitDocument
  const snapshots = capturePublishedSubworkflows('root', documentOf('root', 'child'), [child])
  assert.equal(snapshots.child.doc.nodes.find((node) => node.data.kind === 'wait')?.data.waitMode, 'callback')
})

test('rejects disabled targets, recursion, and excessive nesting', () => {
  assert.throws(() => capturePublishedSubworkflows('root', documentOf('root', 'missing'), []), /不存在/)
  assert.throws(() => capturePublishedSubworkflows('root', documentOf('root', 'child'), [saved('child', 'root')]), /递归调用/)
  assert.throws(() => validateSubworkflowRuntimeCall(['root', 'child'], 'root'), /递归调用/)
  assert.throws(() => validateSubworkflowRuntimeCall(['a', 'b'], 'c', 2), /最多嵌套 2 层/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createBlankWorkflowDocument, createNode, type SavedWorkflow, type WorkflowVersion } from '../src/model.js'
import { createWorkflowVersion, diffWorkflowDocuments, restoreWorkflowVersion, upsertWorkflowVersion, workflowDiffCount } from '../src/workflowVersionProtocol.js'

const firstTime = '2026-09-04T01:00:00.000Z'
const secondTime = '2026-09-04T02:00:00.000Z'

function workflow(): SavedWorkflow {
  const doc = createBlankWorkflowDocument('版本测试')
  return {
    id: 'workflow-a',
    name: '版本测试',
    status: 'enabled',
    revision: 4,
    draftRevision: 3,
    publishedRevision: 2,
    publishedAt: firstTime,
    publishedDoc: structuredClone(doc),
    createdAt: firstTime,
    updatedAt: firstTime,
    doc,
  }
}

test('captures an immutable workflow version', () => {
  const current = workflow()
  current.doc.nodes[0].data.lastRun = { logs: [], at: firstTime, running: false }
  const version = createWorkflowVersion(current, 'draft')
  current.doc.nodes[0].data.label = '后续修改'
  assert.equal(version.id, 'workflow-a:r4')
  assert.equal(version.doc.nodes[0].data.label, '手动触发')
  assert.equal(version.doc.nodes[0].data.lastRun, undefined)
  assert.equal(version.publishedRevision, 2)
})

test('restores history as a new draft without changing the live snapshot', () => {
  const current = workflow()
  const version = createWorkflowVersion({ ...current, name: '旧名称', doc: { ...current.doc, name: '旧名称' } }, 'draft')
  const restored = restoreWorkflowVersion(current, version, false, secondTime)
  assert.equal(restored.revision, 5)
  assert.equal(restored.draftRevision, 4)
  assert.equal(restored.name, '旧名称')
  assert.deepEqual(restored.publishedDoc, current.publishedDoc)
  assert.equal(restored.publishedRevision, 2)
})

test('restores and publishes a historical version atomically', () => {
  const current = workflow()
  const version = createWorkflowVersion(current, 'published')
  version.doc.nodes.push(createNode('output', '历史输出', { x: 360, y: 200 }))
  const restored = restoreWorkflowVersion(current, version, true, secondTime)
  assert.equal(restored.status, 'enabled')
  assert.equal(restored.revision, 5)
  assert.equal(restored.publishedRevision, 4)
  assert.deepEqual(restored.publishedDoc, restored.doc)
})

test('describes node, edge and metadata differences', () => {
  const before = createBlankWorkflowDocument('旧名称')
  const after = structuredClone(before)
  after.name = '新名称'
  after.nodes[0].data.label = '新开始'
  after.nodes.push(createNode('output', '结果', { x: 360, y: 200 }))
  after.edges.push({ id: 'edge-a', source: after.nodes[0].id, target: after.nodes[1].id })
  const diff = diffWorkflowDocuments(before, after)
  assert.equal(diff.nameChanged, true)
  assert.equal(diff.changedNodes[0].fields.includes('名称'), true)
  assert.equal(diff.addedNodes[0].label, '结果')
  assert.equal(diff.addedEdges[0].id, 'edge-a')
  assert.equal(workflowDiffCount(diff), 4)
})

test('keeps only the configured number of versions per workflow', () => {
  const current = workflow()
  const versions = [1, 2, 3].reduce<WorkflowVersion[]>((items, revision) => upsertWorkflowVersion(items, createWorkflowVersion({ ...current, revision }, 'draft'), 2), [])
  assert.deepEqual(versions.map((version) => version.revision), [3, 2])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createBlankWorkflowDocument, refreshWebhookTokens, type SavedWorkflow } from '../src/model.js'
import {
  createSavedWorkflow,
  executionDocument,
  hasUnpublishedChanges,
  normalizeSavedWorkflow,
  publishWorkflow,
  updateWorkflowDraft,
  workflowRevisionMatches,
} from '../src/workflowProtocol.js'

const firstTime = '2026-09-03T01:00:00.000Z'
const secondTime = '2026-09-03T02:00:00.000Z'

function draft(name = '流程 A'): SavedWorkflow {
  return {
    id: 'workflow-a',
    name,
    status: 'disabled',
    revision: 0,
    draftRevision: 0,
    createdAt: firstTime,
    updatedAt: firstTime,
    doc: createBlankWorkflowDocument(name),
  }
}

test('migrates enabled legacy records to a published snapshot', () => {
  const legacy = { ...draft(), status: 'enabled', revision: undefined, draftRevision: undefined } as unknown as SavedWorkflow
  const workflow = normalizeSavedWorkflow(legacy)
  assert.equal(workflow.revision, 1)
  assert.equal(workflow.draftRevision, 1)
  assert.equal(workflow.publishedRevision, 1)
  assert.deepEqual(workflow.publishedDoc, workflow.doc)
})

test('keeps the published document immutable while the draft changes', () => {
  const created = createSavedWorkflow(draft(), firstTime)
  const published = publishWorkflow(created, 'enabled', firstTime)
  const changedDocument = { ...published.doc, name: '新草稿' }
  const changed = updateWorkflowDraft(published, { ...published, name: '新草稿', doc: changedDocument }, secondTime)

  assert.equal(changed.revision, published.revision + 1)
  assert.equal(changed.draftRevision, published.draftRevision + 1)
  assert.equal(changed.publishedRevision, published.draftRevision)
  assert.equal(executionDocument(changed).name, '流程 A')
  assert.equal(changed.doc.name, '新草稿')
  assert.equal(hasUnpublishedChanges(changed), true)
  changed.doc.nodes[0].data.label = '已修改草稿'
  assert.notEqual(executionDocument(changed).nodes[0].data.label, '已修改草稿')
})

test('publishing updates the execution snapshot and disabling preserves it', () => {
  const created = createSavedWorkflow(draft(), firstTime)
  const changed = updateWorkflowDraft(created, { ...created, name: '流程 B', doc: { ...created.doc, name: '流程 B' } }, secondTime)
  const published = publishWorkflow(changed, 'enabled', secondTime)
  const disabled = publishWorkflow(published, 'disabled', secondTime)

  assert.equal(published.publishedRevision, changed.draftRevision)
  assert.equal(executionDocument(published).name, '流程 B')
  assert.equal(hasUnpublishedChanges(published), false)
  assert.deepEqual(disabled.publishedDoc, published.publishedDoc)
  assert.equal(disabled.status, 'disabled')
})

test('accepts only one writer for the same expected revision', () => {
  const created = createSavedWorkflow(draft(), firstTime)
  const firstWriter = updateWorkflowDraft(created, { ...created, name: '写入 A', doc: { ...created.doc, name: '写入 A' } }, secondTime)

  assert.equal(workflowRevisionMatches(created, created.revision), true)
  assert.equal(workflowRevisionMatches(firstWriter, created.revision), false)
  assert.equal(workflowRevisionMatches(undefined, 0), true)
  assert.equal(workflowRevisionMatches(undefined, 1), false)
})

test('refreshes webhook tokens when a workflow becomes an independent copy', () => {
  const document = createBlankWorkflowDocument()
  document.nodes.push({
    id: 'webhook-a',
    type: 'workflow',
    position: { x: 300, y: 200 },
    data: { kind: 'webhook', label: 'Webhook', webhookToken: 'original-token-value-1234567890' },
  })
  const copy = refreshWebhookTokens(document)
  assert.notEqual(copy.nodes[1].data.webhookToken, document.nodes[1].data.webhookToken)
  assert.equal(copy.nodes[1].data.webhookToken!.length >= 24, true)
  assert.equal(document.nodes[1].data.webhookToken, 'original-token-value-1234567890')
})

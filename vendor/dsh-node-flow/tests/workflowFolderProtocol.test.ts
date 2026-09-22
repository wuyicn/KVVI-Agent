import assert from 'node:assert/strict'
import test from 'node:test'
import { createBlankWorkflowDocument, type SavedWorkflow } from '../src/model.js'
import {
  createWorkflowFolder,
  moveWorkflowToFolder,
  normalizeWorkflowFolder,
  normalizeWorkflowFolderId,
  normalizeWorkflowFolderName,
  renameWorkflowFolder,
  workflowFolderRevisionMatches,
} from '../src/workflowFolderProtocol.js'
import { createSavedWorkflow, normalizeSavedWorkflow, publishWorkflow } from '../src/workflowProtocol.js'

const firstTime = '2026-09-05T00:00:00.000Z'
const secondTime = '2026-09-05T01:00:00.000Z'

function workflow(): SavedWorkflow {
  return createSavedWorkflow({
    id: 'workflow-folder-test',
    name: 'Folder flow',
    folderId: 'folder-one',
    status: 'disabled',
    revision: 0,
    draftRevision: 0,
    createdAt: firstTime,
    updatedAt: firstTime,
    doc: createBlankWorkflowDocument('Folder flow'),
  }, firstTime)
}

test('normalizes safe flat folder records and rejects invalid identifiers', () => {
  assert.equal(normalizeWorkflowFolderId(' folder_A-01 '), 'folder_A-01')
  assert.equal(normalizeWorkflowFolderId('bad folder'), undefined)
  assert.equal(normalizeWorkflowFolderId(''), undefined)
  assert.equal(normalizeWorkflowFolderName('  运营\n自动化  '), '运营 自动化')
  assert.throws(() => normalizeWorkflowFolderName(' \t '), /不能为空/)
  assert.equal(normalizeWorkflowFolder({ id: 'folder-1', name: '  Operations ', revision: 0, createdAt: firstTime, updatedAt: secondTime })?.revision, 1)
  assert.equal(normalizeWorkflowFolder({ id: 'invalid id', name: 'Broken', createdAt: firstTime, updatedAt: secondTime }), undefined)
})

test('creates and renames folders with monotonic revisions', () => {
  const folder = createWorkflowFolder({ id: 'folder-one', name: '  Team A ' }, firstTime)
  assert.deepEqual(folder, { id: 'folder-one', name: 'Team A', revision: 1, createdAt: firstTime, updatedAt: firstTime })
  assert.equal(workflowFolderRevisionMatches(folder, 1), true)
  assert.equal(workflowFolderRevisionMatches(folder, 2), false)
  const renamed = renameWorkflowFolder(folder, 'Team B', secondTime)
  assert.equal(renamed.name, 'Team B')
  assert.equal(renamed.revision, 2)
  assert.equal(renamed.updatedAt, secondTime)
  assert.equal(renameWorkflowFolder(renamed, 'Team B', secondTime).revision, renamed.revision)
})

test('moves only control-plane metadata and preserves published execution snapshots', () => {
  const published = publishWorkflow(workflow(), 'enabled', firstTime)
  const snapshot = structuredClone(published.publishedDoc)
  const moved = moveWorkflowToFolder(published, 'folder-two', secondTime)

  assert.equal(moved.folderId, 'folder-two')
  assert.equal(moved.revision, published.revision + 1)
  assert.equal(moved.draftRevision, published.draftRevision)
  assert.equal(moved.publishedRevision, published.publishedRevision)
  assert.deepEqual(moved.doc, published.doc)
  assert.deepEqual(moved.publishedDoc, snapshot)
  assert.equal(moveWorkflowToFolder(moved, 'folder-two', secondTime).revision, moved.revision)
})

test('migrates legacy workflows without a folder assignment', () => {
  const legacy = { ...workflow(), folderId: 'bad folder id' } as SavedWorkflow
  assert.equal(normalizeSavedWorkflow(legacy).folderId, undefined)
  assert.equal(normalizeSavedWorkflow({ ...workflow(), folderId: undefined }).folderId, undefined)
})

import type { SavedWorkflow, WorkflowDocument, WorkflowStatus } from './model.js'
import { normalizeWorkflowFolderId } from './workflowFolderProtocol.js'

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function cloneDocument(document: WorkflowDocument): WorkflowDocument {
  return structuredClone(document)
}

export function normalizeSavedWorkflow(workflow: SavedWorkflow): SavedWorkflow {
  const revision = positiveInteger(workflow.revision, 1)
  const draftRevision = positiveInteger(workflow.draftRevision, 1)
  const wasPublished = workflow.status === 'enabled'
  const publishedRevision = workflow.publishedRevision === undefined
    ? (wasPublished ? draftRevision : undefined)
    : positiveInteger(workflow.publishedRevision, draftRevision)
  const publishedDoc = workflow.publishedDoc ?? (wasPublished ? cloneDocument(workflow.doc) : undefined)
  return {
    ...workflow,
    folderId: normalizeWorkflowFolderId(workflow.folderId),
    revision,
    draftRevision,
    publishedRevision,
    publishedAt: workflow.publishedAt ?? (wasPublished ? workflow.updatedAt : undefined),
    publishedDoc,
  }
}

export function createSavedWorkflow(incoming: SavedWorkflow, now: string): SavedWorkflow {
  const normalized = normalizeSavedWorkflow(incoming)
  const status: WorkflowStatus = incoming.status === 'enabled' ? 'enabled' : 'disabled'
  return {
    ...normalized,
    name: incoming.name || incoming.doc.name || '未命名工作流',
    status,
    revision: 1,
    draftRevision: 1,
    publishedRevision: status === 'enabled' ? 1 : undefined,
    publishedAt: status === 'enabled' ? now : undefined,
    publishedDoc: status === 'enabled' ? cloneDocument(incoming.doc) : undefined,
    createdAt: incoming.createdAt || now,
    updatedAt: now,
    doc: { ...cloneDocument(incoming.doc), name: incoming.name || incoming.doc.name || '未命名工作流' },
  }
}

export function updateWorkflowDraft(existing: SavedWorkflow, incoming: SavedWorkflow, now: string): SavedWorkflow {
  const current = normalizeSavedWorkflow(existing)
  const name = incoming.name || incoming.doc.name || '未命名工作流'
  return {
    ...current,
    name,
    description: incoming.description ?? current.description,
    revision: current.revision + 1,
    draftRevision: current.draftRevision + 1,
    updatedAt: now,
    doc: { ...cloneDocument(incoming.doc), name },
  }
}

export function publishWorkflow(existing: SavedWorkflow, status: WorkflowStatus, now: string): SavedWorkflow {
  const current = normalizeSavedWorkflow(existing)
  if (status === 'disabled') {
    return { ...current, status, revision: current.revision + 1, updatedAt: now }
  }
  return {
    ...current,
    status,
    revision: current.revision + 1,
    updatedAt: now,
    publishedRevision: current.draftRevision,
    publishedAt: now,
    publishedDoc: cloneDocument(current.doc),
  }
}

export function hasUnpublishedChanges(workflow: SavedWorkflow): boolean {
  const normalized = normalizeSavedWorkflow(workflow)
  return normalized.status === 'enabled' && normalized.publishedRevision !== normalized.draftRevision
}

export function executionDocument(workflow: SavedWorkflow): WorkflowDocument {
  const normalized = normalizeSavedWorkflow(workflow)
  return normalized.status === 'enabled' ? (normalized.publishedDoc ?? normalized.doc) : normalized.doc
}

export function workflowRevisionMatches(existing: SavedWorkflow | undefined, expectedRevision: unknown): boolean {
  if (!existing) return Number(expectedRevision) === 0
  return normalizeSavedWorkflow(existing).revision === Number(expectedRevision)
}

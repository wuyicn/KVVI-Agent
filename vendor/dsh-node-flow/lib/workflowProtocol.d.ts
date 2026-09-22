import type { SavedWorkflow, WorkflowDocument, WorkflowStatus } from './model.js';
export declare function normalizeSavedWorkflow(workflow: SavedWorkflow): SavedWorkflow;
export declare function createSavedWorkflow(incoming: SavedWorkflow, now: string): SavedWorkflow;
export declare function updateWorkflowDraft(existing: SavedWorkflow, incoming: SavedWorkflow, now: string): SavedWorkflow;
export declare function publishWorkflow(existing: SavedWorkflow, status: WorkflowStatus, now: string): SavedWorkflow;
export declare function hasUnpublishedChanges(workflow: SavedWorkflow): boolean;
export declare function executionDocument(workflow: SavedWorkflow): WorkflowDocument;
export declare function workflowRevisionMatches(existing: SavedWorkflow | undefined, expectedRevision: unknown): boolean;

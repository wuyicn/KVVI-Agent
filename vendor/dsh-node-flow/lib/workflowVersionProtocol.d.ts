import type { SavedWorkflow, WorkflowDocument, WorkflowVersion, WorkflowVersionDiff, WorkflowVersionKind } from './model.js';
export declare function createWorkflowVersion(workflow: SavedWorkflow, kind: WorkflowVersionKind, createdAt?: string, sourceVersionId?: string): WorkflowVersion;
export declare function restoreWorkflowVersion(workflow: SavedWorkflow, version: WorkflowVersion, publish: boolean, now: string): SavedWorkflow;
export declare function upsertWorkflowVersion(versions: WorkflowVersion[], version: WorkflowVersion, maxPerWorkflow?: number): WorkflowVersion[];
export declare function diffWorkflowDocuments(before: WorkflowDocument, after: WorkflowDocument): WorkflowVersionDiff;
export declare function workflowDiffCount(diff: WorkflowVersionDiff): number;

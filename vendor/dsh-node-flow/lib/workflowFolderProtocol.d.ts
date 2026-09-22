import type { SavedWorkflow, WorkflowFolder } from './model.js';
export declare const MAX_WORKFLOW_FOLDERS = 100;
export declare const MAX_WORKFLOW_FOLDER_NAME_LENGTH = 80;
export type WorkflowFolderInput = {
    id: string;
    name: string;
};
/** Returns undefined for an empty or malformed optional folder assignment. */
export declare function normalizeWorkflowFolderId(value: unknown): string | undefined;
export declare function requireWorkflowFolderId(value: unknown): string;
export declare function normalizeWorkflowFolderName(value: unknown): string;
/** Drops malformed persisted records rather than exposing them to the browser. */
export declare function normalizeWorkflowFolder(value: unknown): WorkflowFolder | undefined;
export declare function createWorkflowFolder(input: WorkflowFolderInput, now: string): WorkflowFolder;
export declare function renameWorkflowFolder(existing: WorkflowFolder, name: unknown, now: string): WorkflowFolder;
export declare function workflowFolderRevisionMatches(existing: WorkflowFolder | undefined, expectedRevision: unknown): boolean;
/** Move metadata only: execution snapshots and editable graph revisions remain intact. */
export declare function moveWorkflowToFolder(workflow: SavedWorkflow, folderId: string | undefined, now: string): SavedWorkflow;

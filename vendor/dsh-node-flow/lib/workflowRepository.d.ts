import { type SavedWorkflow, type WorkflowAuditEvent, type WorkflowAuditTargetType, type WorkflowFolder, type WorkflowRunRecord, type WorkflowRunSummary, type WorkflowStatus, type WorkflowVersion } from './model.js';
export declare class WorkflowConflictError extends Error {
    readonly latest: SavedWorkflow;
    constructor(latest: SavedWorkflow);
}
export declare class WorkflowFolderConflictError extends Error {
    readonly latest: WorkflowFolder;
    constructor(latest: WorkflowFolder);
}
export declare function workflowFoldersSupported(): boolean;
export declare function isWorkflowSyncPending(id: string): boolean;
export declare function acceptLatestWorkflow(workflow: SavedWorkflow): void;
export declare function listSavedWorkflows(): Promise<SavedWorkflow[]>;
/** Folder metadata stays host-authoritative and is intentionally not browser-cached. */
export declare function listWorkflowFolders(): Promise<WorkflowFolder[]>;
export declare function createSavedWorkflowFolder(name: string): Promise<{
    folder: WorkflowFolder;
    folders: WorkflowFolder[];
}>;
export declare function renameSavedWorkflowFolder(folder: WorkflowFolder, name: string): Promise<{
    folder: WorkflowFolder;
    folders: WorkflowFolder[];
}>;
export declare function deleteSavedWorkflowFolder(folder: WorkflowFolder, targetFolderId?: string): Promise<{
    folders: WorkflowFolder[];
    workflows: SavedWorkflow[];
    moved: number;
}>;
export declare function moveSavedWorkflowToFolder(workflow: SavedWorkflow, folderId?: string): Promise<SavedWorkflow>;
export declare function saveSavedWorkflow(workflow: SavedWorkflow): Promise<SavedWorkflow>;
export declare function updateSavedWorkflowStatus(workflow: SavedWorkflow, status: WorkflowStatus): Promise<SavedWorkflow>;
export declare function listWorkflowVersions(workflow: SavedWorkflow): Promise<WorkflowVersion[]>;
export declare function restoreSavedWorkflowVersion(workflow: SavedWorkflow, versionId: string, publish: boolean): Promise<SavedWorkflow>;
export declare function saveWorkflowRun(run: WorkflowRunRecord): Promise<void>;
export declare function markWorkflowRun(workflow: SavedWorkflow, startedAt: string): Promise<SavedWorkflow>;
export declare function listWorkflowRuns(): Promise<WorkflowRunRecord[]>;
export declare function listWorkflowRunSummaries(): Promise<WorkflowRunSummary[]>;
/** Audit history remains host-authoritative and is intentionally never browser-cached. */
export declare function listWorkflowAuditEvents(options?: {
    limit?: number;
    targetType?: WorkflowAuditTargetType;
}): Promise<WorkflowAuditEvent[]>;
export declare function getWorkflowRunDetail(id: string): Promise<WorkflowRunRecord>;
export declare function runSavedWorkflow(workflow: SavedWorkflow, runId?: string, signal?: AbortSignal, input?: unknown): Promise<{
    workflow: SavedWorkflow;
    run: WorkflowRunRecord;
}>;
export declare function cancelWorkflowRun(runId: string): Promise<void>;
export declare function resumeWorkflowRun(run: Pick<WorkflowRunRecord, 'id'>, runId?: string, signal?: AbortSignal): Promise<WorkflowRunRecord>;
export declare function replayWorkflowRun(run: Pick<WorkflowRunRecord, 'id'>, runId?: string, signal?: AbortSignal): Promise<WorkflowRunRecord>;
export declare function createWaitpointCallbackToken(runId: string): Promise<{
    callbackUrl: string;
    token: string;
}>;
export declare function resolveWorkflowApproval(runId: string, decision: 'approved' | 'rejected', note: string): Promise<WorkflowRunRecord>;
export declare function deleteSavedWorkflow(workflow: SavedWorkflow): Promise<void>;

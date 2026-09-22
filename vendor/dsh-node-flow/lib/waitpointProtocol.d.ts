import type { WorkflowDocument, WorkflowNodeData, WorkflowRunRecord, WorkflowWaitpoint } from './model.js';
export declare class WorkflowWaitSignal extends Error {
    readonly waitpoint: WorkflowWaitpoint;
    constructor(waitpoint: WorkflowWaitpoint);
}
export declare function createDebugWaitpoint(nodeId: string, input: string, reason: 'breakpoint' | 'step', previousNodeId?: string, now?: number): WorkflowWaitpoint;
export declare function waitpointTokenHash(token: string): string;
export declare function waitpointTokenMatches(waitpoint: WorkflowWaitpoint, token: string): boolean;
export declare function createWorkflowWaitpoint(data: WorkflowNodeData, nodeId: string, input: string, now?: number): WorkflowWaitpoint;
export declare function validateWorkflowWaitpoints(document: WorkflowDocument): void;
/**
 * Debugger v1 deliberately accepts only a single, linear manual chain. This
 * makes a persisted "next step" unambiguous and keeps loops, fan-out and
 * external waits out of an interactive session.
 */
export declare function validateWorkflowDebugDocument(document: WorkflowDocument): void;
export declare function canResolveWaitpoint(run: WorkflowRunRecord, now?: number): boolean;
export declare function releaseOrphanedWaitpointClaims(runs: WorkflowRunRecord[]): WorkflowRunRecord[];
export declare function waitpointTimedOut(waitpoint: WorkflowWaitpoint, now?: number): boolean;
export declare function sanitizeWaitpointRun(run: WorkflowRunRecord): WorkflowRunRecord;

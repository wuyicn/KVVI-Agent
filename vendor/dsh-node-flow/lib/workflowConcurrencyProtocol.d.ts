import type { WorkflowConcurrency, WorkflowConcurrencyMode, WorkflowRunRecord } from './model.js';
export declare const MAX_WORKFLOW_CONCURRENT_RUNS = 20;
export declare const MAX_WORKFLOW_QUEUED_RUNS = 100;
export type NormalizedWorkflowConcurrency = {
    mode: WorkflowConcurrencyMode;
    maxConcurrent: number;
    maxQueue: number;
};
export type WorkflowConcurrencyDecision = {
    action: 'start' | 'queue' | 'skip';
    active: number;
    queued: number;
    reason?: string;
};
/**
 * Normalizes absent legacy settings to unlimited parallel starts. A configured
 * limit is intentionally bounded so a malformed imported document cannot turn
 * a single DSH process into an unbounded execution queue.
 */
export declare function normalizeWorkflowConcurrency(value?: WorkflowConcurrency): NormalizedWorkflowConcurrency;
/** Reject invalid explicitly configured values before a draft can be published. */
export declare function validateWorkflowConcurrency(value?: WorkflowConcurrency): void;
/** A waiting root keeps exactly one slot; its continuation replaces that slot. */
export declare function isActiveWorkflowRootRun(run: WorkflowRunRecord, workflowId: string): boolean;
export declare function isQueuedWorkflowRootRun(run: WorkflowRunRecord, workflowId: string): boolean;
export declare function countActiveWorkflowRootRuns(runs: WorkflowRunRecord[], workflowId: string): number;
export declare function countQueuedWorkflowRootRuns(runs: WorkflowRunRecord[], workflowId: string): number;
/** Decide whether a new root trigger starts now, persists in FIFO, or is skipped. */
export declare function decideWorkflowConcurrency(concurrency: WorkflowConcurrency | undefined, runs: WorkflowRunRecord[], workflowId: string): WorkflowConcurrencyDecision;
/** A queued item may start whenever the current policy exposes a free slot. */
export declare function canStartQueuedWorkflowRun(concurrency: WorkflowConcurrency | undefined, runs: WorkflowRunRecord[], workflowId: string): boolean;

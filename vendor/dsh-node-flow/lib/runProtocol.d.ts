import type { WorkflowRunRecord } from './model.js';
export declare function canResumeRun(run: WorkflowRunRecord): boolean;
export declare function recoverInterruptedRuns(runs: WorkflowRunRecord[], now?: string): WorkflowRunRecord[];
export declare function upsertRunRecord(runs: WorkflowRunRecord[], run: WorkflowRunRecord, limit?: number): WorkflowRunRecord[];

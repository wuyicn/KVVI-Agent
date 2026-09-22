import type { WorkflowNodeData } from './model.js';
export type RetryPolicy = {
    retries: number;
    delayMs: number;
    backoff: 'fixed' | 'exponential';
};
export declare class RetryExhaustedError extends Error {
    readonly attempts: number;
    readonly lastError: unknown;
    constructor(message: string, attempts: number, lastError: unknown);
}
export declare function normalizeRetryPolicy(data: Pick<WorkflowNodeData, 'retryCount' | 'retryDelay' | 'retryBackoff'>): RetryPolicy;
export declare function retryDelayMilliseconds(policy: RetryPolicy, retryIndex: number): number;
export declare function executeWithRetry<T>(operation: (attempt: number) => Promise<T>, data: Pick<WorkflowNodeData, 'retryCount' | 'retryDelay' | 'retryBackoff'>, signal?: AbortSignal): Promise<{
    value: T;
    attempts: number;
}>;

import type { WorkflowExecutionLimits } from './model.js';
export declare const MAX_WORKFLOW_DURATION_SECONDS: number;
export declare const MAX_WORKFLOW_STEPS = 100000;
export type NormalizedWorkflowExecutionLimits = {
    maxDurationSec?: number;
    maxSteps: number;
};
export declare function normalizeWorkflowExecutionLimits(value?: WorkflowExecutionLimits): NormalizedWorkflowExecutionLimits;
export declare function validateWorkflowExecutionLimits(value?: WorkflowExecutionLimits): void;

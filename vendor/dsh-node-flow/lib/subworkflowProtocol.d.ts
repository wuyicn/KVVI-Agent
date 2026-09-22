import type { SavedWorkflow, WorkflowContractField, WorkflowDocument, WorkflowExecutionSnapshot } from './model.js';
export declare const MAX_SUBWORKFLOW_DEPTH = 8;
export declare function normalizeWorkflowContract(fields: WorkflowContractField[] | undefined): WorkflowContractField[];
export declare function renderSubworkflowInput(template: string | undefined, result: unknown, variables?: Record<string, unknown>): unknown;
export declare function validateWorkflowContract(value: unknown, fields: WorkflowContractField[] | undefined, label: string): unknown;
export declare function capturePublishedSubworkflows(rootWorkflowId: string | undefined, rootDocument: WorkflowDocument, workflows: SavedWorkflow[], maximumDepth?: number): Record<string, WorkflowExecutionSnapshot>;
export declare function validateSubworkflowRuntimeCall(stack: string[], targetWorkflowId: string, maximumDepth?: number): void;

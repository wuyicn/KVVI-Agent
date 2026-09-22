import type { WorkflowContractField } from './model.js';
export type WorkflowContractInputValues = Record<string, string>;
export declare function parseWorkflowContractField(field: WorkflowContractField, source: string, label?: string): unknown;
export declare function parseWorkflowContractInput(fields: WorkflowContractField[] | undefined, values: WorkflowContractInputValues, label?: string): Record<string, unknown>;

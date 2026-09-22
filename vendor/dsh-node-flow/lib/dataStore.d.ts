import type { DataStoreOperation, WorkflowNodeData } from './model.js';
export type DataStoreRecord = {
    key: string;
    value: unknown;
    updatedAt: string;
};
export declare function normalizeDataStoreNamespace(value?: string): string;
export declare function normalizeDataStoreKey(value: string, label?: string): string;
export declare function normalizeDataStoreOperation(value?: string): DataStoreOperation;
export declare function validateDataStoreNodeConfiguration(data: WorkflowNodeData): void;
export declare function readDataStoreValue(dataDirectory: string, workflowId: string, namespaceValue: string | undefined, keyValue: string): DataStoreRecord | undefined;
export declare function writeDataStoreValue(dataDirectory: string, workflowId: string, namespaceValue: string | undefined, keyValue: string, value: unknown): DataStoreRecord;
export declare function deleteDataStoreValue(dataDirectory: string, workflowId: string, namespaceValue: string | undefined, keyValue: string): boolean;
export declare function deleteDataStoreWorkflow(dataDirectory: string, workflowId: string): number;
export declare function listDataStoreValues(dataDirectory: string, workflowId: string, namespaceValue: string | undefined, prefixValue?: string): DataStoreRecord[];

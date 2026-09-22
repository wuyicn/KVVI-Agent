import type { ProjectVariableKind, ProjectVariableSummary, WorkflowNodeData } from './model.js';
export type ProjectVariableInput = {
    id?: string;
    name: string;
    kind: ProjectVariableKind;
    description?: string;
    value?: string;
};
export declare function listProjectVariableSummaries(dataDirectory: string): ProjectVariableSummary[];
export declare function resolveProjectVariables(dataDirectory: string): Record<string, string>;
export declare function resolvePublicProjectVariables(dataDirectory: string): Record<string, string>;
export declare function listProjectSecretValues(dataDirectory: string): string[];
export declare function saveProjectVariable(dataDirectory: string, input: ProjectVariableInput): ProjectVariableSummary;
export declare function deleteProjectVariable(dataDirectory: string, id: string): boolean;
export declare function extractProjectVariableReferences(value: unknown): string[];
export declare function extractNodeProjectVariableReferences(data: WorkflowNodeData): string[];
export declare function extractUnsafeProjectSecretReferences(data: WorkflowNodeData): string[];
export declare function redactProjectSecrets<T>(value: T, secrets: string[]): T;

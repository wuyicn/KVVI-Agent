import type { CredentialKind, CredentialSummary, WorkflowNodeData } from './model.js';
export type ConnectorFieldType = 'text' | 'textarea' | 'json' | 'number' | 'select' | 'boolean';
export type ConnectorFieldOption = {
    value: string;
    label: string;
};
export type ConnectorDynamicOptionsDefinition = {
    dependsOn?: string[];
    build: (context: ConnectorBuildContext) => ConnectorRequest;
    extract: (value: unknown) => ConnectorFieldOption[];
};
export type ConnectorFieldDefinition = {
    id: string;
    label: string;
    type: ConnectorFieldType;
    required?: boolean;
    placeholder?: string;
    description?: string;
    defaultValue?: string;
    options?: ConnectorFieldOption[];
    dynamicOptions?: ConnectorDynamicOptionsDefinition;
    min?: number;
    max?: number;
};
export type ConnectorRequest = {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    responseMode?: 'auto' | 'json' | 'text';
    validateResponse?: (value: unknown, status: number) => void;
};
export type ConnectorBuildContext = {
    value: (fieldId: string) => string;
    optional: (fieldId: string) => string | undefined;
    json: (fieldId: string) => unknown;
    integer: (fieldId: string) => number;
    flag: (fieldId: string) => boolean;
    path: (fieldId: string) => string;
    query: (url: string, values: Record<string, string | number | boolean | undefined>) => string;
};
export type ConnectorActionDefinition = {
    id: string;
    label: string;
    description: string;
    fields: ConnectorFieldDefinition[];
    build: (context: ConnectorBuildContext) => ConnectorRequest;
};
export type ConnectorPollingResult = {
    items: unknown[];
    cursor?: string;
};
export type ConnectorTriggerDefinition = {
    id: string;
    label: string;
    description: string;
    fields: ConnectorFieldDefinition[];
    build: (context: ConnectorBuildContext) => ConnectorRequest;
    extract: (value: unknown) => ConnectorPollingResult;
    key: (item: unknown) => string;
};
export type ConnectorDefinition = {
    id: string;
    /** Monotonic schema/runtime version. Legacy definitions default to version 1. */
    version?: number;
    name: string;
    description: string;
    category: 'AI' | '协作' | '开发' | '数据' | '销售' | '效率' | '支付';
    color: string;
    origins: string[];
    credentialKinds: CredentialKind[];
    credentialHeaderName?: string;
    authHint: string;
    actions: ConnectorActionDefinition[];
    triggers?: ConnectorTriggerDefinition[];
};
export type ConnectorCatalogFieldDefinition = Omit<ConnectorFieldDefinition, 'dynamicOptions'> & {
    dynamicOptions?: {
        dependsOn?: string[];
    };
};
export type ConnectorCatalogActionDefinition = Omit<ConnectorActionDefinition, 'build' | 'fields'> & {
    fields: ConnectorCatalogFieldDefinition[];
};
export type ConnectorCatalogTriggerDefinition = Omit<ConnectorTriggerDefinition, 'build' | 'extract' | 'key' | 'fields'> & {
    fields: ConnectorCatalogFieldDefinition[];
};
export type ConnectorCatalogItem = Omit<ConnectorDefinition, 'version' | 'actions' | 'triggers'> & {
    version: number;
    actions: ConnectorCatalogActionDefinition[];
    triggers?: ConnectorCatalogTriggerDefinition[];
};
export declare function defineConnector(definition: ConnectorDefinition): ConnectorDefinition;
export declare const connectorFields: {
    text: (id: string, label: string, required?: boolean, placeholder?: string) => ConnectorFieldDefinition;
    area: (id: string, label: string, required?: boolean, placeholder?: string) => ConnectorFieldDefinition;
    json: (id: string, label: string, required?: boolean, placeholder?: string) => ConnectorFieldDefinition;
    number: (id: string, label: string, defaultValue: string, min?: number, max?: number) => ConnectorFieldDefinition;
    defaultText: (id: string, label: string, defaultValue: string) => ConnectorFieldDefinition;
    defaultArea: (id: string, label: string, defaultValue: string) => ConnectorFieldDefinition;
    defaultJson: (id: string, label: string, defaultValue: string) => ConnectorFieldDefinition;
};
export declare function jsonRequest(method: string, url: string, body?: unknown, headers?: Record<string, string>): ConnectorRequest;
export declare function compact(values: Record<string, unknown>): Record<string, unknown>;
export declare function formBody(values: Record<string, string | undefined>): string;
export declare function connectorCatalog(connectors: ConnectorDefinition[]): ConnectorCatalogItem[];
export declare function connectorDefinitionVersion(connector: ConnectorDefinition): number;
export declare function resolveConnectorDefinition(connectors: ConnectorDefinition[], id: string | undefined, version?: number): ConnectorDefinition;
export declare function connectorDefaultParams(action: ConnectorActionDefinition): Record<string, string>;
export declare function validateConnectorNodeConfiguration(connectors: ConnectorDefinition[], data: WorkflowNodeData, credential?: CredentialSummary): ConnectorDefinition;
export declare function buildConnectorRequest(connectors: ConnectorDefinition[], data: WorkflowNodeData, input: unknown, credential?: CredentialSummary, variables?: Record<string, unknown>): ConnectorRequest;
export declare function buildConnectorTriggerRequest(connectors: ConnectorDefinition[], data: WorkflowNodeData, credential?: CredentialSummary, variables?: Record<string, unknown>): {
    connector: ConnectorDefinition;
    trigger: ConnectorTriggerDefinition;
    request: ConnectorRequest;
};
export declare function buildConnectorDynamicOptionsRequest(connectors: ConnectorDefinition[], data: WorkflowNodeData, operationId: string | undefined, fieldId: string | undefined, credential?: CredentialSummary, variables?: Record<string, unknown>): {
    connector: ConnectorDefinition;
    field: ConnectorFieldDefinition;
    request: ConnectorRequest;
    extract: (value: unknown) => ConnectorFieldOption[];
};
export declare function sanitizeConnectorDynamicOptions(options: ConnectorFieldOption[]): ConnectorFieldOption[];
export declare class ConnectorRegistry {
    private readonly definitions;
    constructor(initial?: ConnectorDefinition[]);
    register(definition: ConnectorDefinition): () => void;
    get(id: string | undefined, version?: number): ConnectorDefinition | undefined;
    list(): ConnectorDefinition[];
    catalog(): ConnectorCatalogItem[];
    build(data: WorkflowNodeData, input: unknown, credential?: CredentialSummary, variables?: Record<string, unknown>): ConnectorRequest;
}

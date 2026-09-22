import type { WorkflowNodeData } from './model.js';
export type HttpNodeResult = {
    status: number;
    value: unknown;
    output: string;
    logs: string[];
};
export type PreparedHttpRequest = {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    responseMode?: string;
    timeout?: string;
    credentialId?: string;
    failOnHttpError?: boolean;
    validateResponse?: (value: unknown, status: number) => void;
};
export declare class HttpNodeError extends Error {
    readonly result?: HttpNodeResult | undefined;
    constructor(message: string, result?: HttpNodeResult | undefined);
}
export declare function executeHttpNode(data: WorkflowNodeData, input: string, resolveHeaders: (credentialId: string, forceRefresh?: boolean) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>, parentSignal?: AbortSignal, variables?: Record<string, unknown>): Promise<HttpNodeResult>;
export declare function executePreparedHttpRequest(request: PreparedHttpRequest, resolveHeaders: (credentialId: string, forceRefresh?: boolean) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>, parentSignal?: AbortSignal, credentialsResolved?: boolean): Promise<HttpNodeResult>;

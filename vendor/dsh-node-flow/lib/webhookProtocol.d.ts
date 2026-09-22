import type { WorkflowNodeData } from './model.js';
export type WebhookSuccessResponse = {
    status: number;
    headers: Record<string, string>;
    body: string;
};
export declare function normalizeWebhookSignatureHeader(value: string | undefined): string;
export declare function normalizeWebhookIdempotencyHeader(value: string | undefined): string | undefined;
export declare function normalizeWebhookIdempotencyTtl(value: string | undefined): number;
export declare function normalizeWebhookIdempotencyKey(value: string | undefined): string;
export declare function webhookIdempotencyId(workflowId: string, nodeId: string, method: string, key: string): string;
export declare function webhookRequestFingerprint(workflowId: string, nodeId: string, method: string, rawBody: Uint8Array, query?: string): string;
export declare function verifyWebhookSignature(body: Uint8Array | string, secret: string, signature: string | undefined): boolean;
export declare function parseWebhookResponseHeaders(source: string | undefined): Record<string, string>;
export declare function normalizeWebhookResponseStatus(value: string | undefined): number;
export declare function buildWebhookSuccessResponse(data: WorkflowNodeData, resultValue: unknown, runId: string, variables?: Record<string, unknown>): WebhookSuccessResponse;
export declare function validateWebhookConfiguration(data: WorkflowNodeData): void;

export type WebhookIdempotencyResponse = {
    status: number;
    headers: Record<string, string>;
    body: string;
    runId: string;
};
export type WebhookIdempotencyClaim = {
    kind: 'claimed';
    id: string;
} | {
    kind: 'processing';
    runId: string;
} | {
    kind: 'replay';
    response: WebhookIdempotencyResponse;
} | {
    kind: 'conflict';
};
export declare function claimWebhookIdempotency(dataDirectory: string, input: {
    workflowId: string;
    nodeId: string;
    method: string;
    key: string;
    fingerprint: string;
    runId: string;
    ttlSeconds: number;
    now?: number;
}): WebhookIdempotencyClaim;
export declare function completeWebhookIdempotency(dataDirectory: string, id: string, response: WebhookIdempotencyResponse): void;
export declare function releaseWebhookIdempotency(dataDirectory: string, id: string): void;
export declare function removeWebhookIdempotencyWorkflow(dataDirectory: string, workflowId: string): void;

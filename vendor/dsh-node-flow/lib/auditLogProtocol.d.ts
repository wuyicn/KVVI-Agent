import type { WorkflowAuditEvent } from './model.js';
export declare const MAX_WORKFLOW_AUDIT_EVENTS = 1000;
export type WorkflowAuditEventInput = Omit<WorkflowAuditEvent, 'details'> & {
    details?: unknown;
};
export declare function sanitizeWorkflowAuditDetails(value: unknown): Record<string, string | number | boolean> | undefined;
/** Normalize persisted entries before returning them to the browser. */
export declare function normalizeWorkflowAuditEvent(value: unknown): WorkflowAuditEvent | undefined;
export declare function createWorkflowAuditEvent(input: WorkflowAuditEventInput): WorkflowAuditEvent;
/** Prepend one event, remove duplicate IDs, and enforce bounded retention. */
export declare function appendWorkflowAuditEvent(existing: unknown, event: WorkflowAuditEvent, retention?: number): WorkflowAuditEvent[];

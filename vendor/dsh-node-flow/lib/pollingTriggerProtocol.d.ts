import type { WorkflowDocument, WorkflowNodeData } from './model.js';
export type PollingTriggerState = {
    id: string;
    workflowId: string;
    nodeId: string;
    connectorId: string;
    connectorVersion?: number;
    triggerId: string;
    configurationHash: string;
    nextPollAt: string;
    recentKeys: string[];
    initialized: boolean;
    cursor?: string;
    lastPolledAt?: string;
    lastEventAt?: string;
    lastError?: string;
    claimedAt?: string;
};
export declare function pollingTriggerId(workflowId: string, nodeId: string): string;
export declare function pollingTriggerConfigurationHash(data: WorkflowNodeData, variables?: Record<string, string>): string;
export declare function pollingIntervalMs(data: WorkflowNodeData): number;
export declare function createPollingTriggerState(workflowId: string, nodeId: string, data: WorkflowNodeData, now?: number, variables?: Record<string, string>): PollingTriggerState;
export declare function syncPollingTriggerStates(current: PollingTriggerState[], workflowId: string, document: WorkflowDocument | undefined, now?: number, variables?: Record<string, string>): PollingTriggerState[];
export declare function claimDuePollingTriggers(states: PollingTriggerState[], now?: number): {
    states: PollingTriggerState[];
    claimed: PollingTriggerState[];
};
export declare function completePollingTrigger(state: PollingTriggerState, keys: string[], intervalMs: number, cursor: string | undefined, now?: number): {
    state: PollingTriggerState;
    newKeys: string[];
};
export declare function failPollingTrigger(state: PollingTriggerState, intervalMs: number, error: unknown, now?: number): PollingTriggerState;
export declare function releaseOrphanedPollingClaims(states: PollingTriggerState[]): PollingTriggerState[];
export declare function validatePollingTriggerGraph(document: WorkflowDocument): void;

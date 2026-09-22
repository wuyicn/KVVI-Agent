export type WorkflowNodeSample = {
    input?: unknown;
    output?: unknown;
    at: string;
};
type WorkflowSamples = Record<string, WorkflowNodeSample>;
export declare function readWorkflowSamples(workflowId: string): WorkflowSamples;
export declare function saveWorkflowNodeSample(workflowId: string, nodeId: string, sample: WorkflowNodeSample): void;
export {};

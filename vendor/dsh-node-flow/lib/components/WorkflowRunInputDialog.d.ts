import type { WorkflowContractField } from '../model.js';
export declare function WorkflowRunInputDialog({ workflowName, fields: sourceFields, published, debug, onClose, onSubmit, }: {
    workflowName: string;
    fields: WorkflowContractField[];
    published?: boolean;
    debug?: boolean;
    onClose: () => void;
    onSubmit: (input: Record<string, unknown>) => Promise<void> | void;
}): import("react").JSX.Element;

import type { WorkflowRunRecord } from '../model.js';
export declare function ExecutionPanel({ onClose, debugRun, debugBusy, onDebugAction, onCancelDebug }: {
    onClose: () => void;
    debugRun: WorkflowRunRecord | null;
    debugBusy: boolean;
    onDebugAction: (action: 'continue' | 'step') => Promise<void> | void;
    onCancelDebug: () => void;
}): import("react").JSX.Element;

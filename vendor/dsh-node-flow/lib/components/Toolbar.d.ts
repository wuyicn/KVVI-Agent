/**
 * Toolbar — add nodes, run/export the workflow.
 *
 * `Run` walks the compiled step list in order and executes each node kind:
 * agent/code nodes hit the host routes; output/condition nodes are evaluated
 * locally. Results flow downstream through a `lastOutput` variable (the most
 * recent agent/code output), available to output (`{{result}}`) and condition
 * nodes.
 *
 * @module components/Toolbar
 */
import type { WorkflowContractField, WorkflowRunRecord, WorkflowStatus } from '../model.js';
export declare function Toolbar({ workflowId, onExitNodeMode, onBackToDashboard, onSave, saveState, workflowStatus, workflowHasUnpublishedChanges, executionInputs, onStatusChange, onRunComplete, onOpenLibrary, onOpenTemplates, onShowExecution, executionOpen, onStartDebug, onClearDebug, debugActive, debugBusy, }: {
    workflowId?: string;
    onExitNodeMode?: () => void;
    onBackToDashboard?: () => void;
    onSave?: () => void;
    saveState: 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict' | 'error';
    workflowStatus: WorkflowStatus;
    workflowHasUnpublishedChanges: boolean;
    executionInputs?: WorkflowContractField[];
    onStatusChange?: (status: WorkflowStatus) => void | Promise<void>;
    onRunComplete?: (run: WorkflowRunRecord) => void | Promise<void>;
    onOpenLibrary: () => void;
    onOpenTemplates: () => void;
    onShowExecution: () => void;
    executionOpen: boolean;
    onStartDebug: (input: unknown) => Promise<void> | void;
    onClearDebug: () => void;
    debugActive: boolean;
    debugBusy: boolean;
}): import("react").JSX.Element;

/**
 * Main canvas — React Flow wrapper wiring the store to the renderer.
 *
 * @module components/Canvas
 */
import type { WorkflowContractField, WorkflowRunRecord, WorkflowStatus } from '../model.js';
export declare function Canvas({ workflowId, onExitNodeMode, onBackToDashboard, onSave, saveState, workflowStatus, workflowHasUnpublishedChanges, executionInputs, onStatusChange, onRunComplete, }?: {
    workflowId?: string;
    onExitNodeMode?: () => void;
    onBackToDashboard?: () => void;
    onSave?: () => void;
    saveState?: 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict' | 'error';
    workflowStatus?: WorkflowStatus;
    workflowHasUnpublishedChanges?: boolean;
    executionInputs?: WorkflowContractField[];
    onStatusChange?: (status: WorkflowStatus) => void | Promise<void>;
    onRunComplete?: (run: WorkflowRunRecord) => void | Promise<void>;
}): import("react").JSX.Element;

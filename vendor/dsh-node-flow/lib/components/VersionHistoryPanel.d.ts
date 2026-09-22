import type { SavedWorkflow, WorkflowVersion } from '../model.js';
export declare function VersionHistoryPanel({ workflow, onClose, onRestore, }: {
    workflow: SavedWorkflow;
    onClose: () => void;
    onRestore: (workflow: SavedWorkflow, version: WorkflowVersion, publish: boolean) => Promise<SavedWorkflow>;
}): import("react").JSX.Element;

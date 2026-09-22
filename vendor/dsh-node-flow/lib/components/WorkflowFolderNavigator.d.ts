import type { SavedWorkflow, WorkflowFolder } from '../model.js';
export type WorkflowFolderFilter = 'all' | 'uncategorized' | string;
export declare function WorkflowFolderNavigator({ folders, workflows, selected, onSelect, onCreateWorkflow, onCreateFolder, onRenameFolder, onDeleteFolder, }: {
    folders: WorkflowFolder[];
    workflows: SavedWorkflow[];
    selected: WorkflowFolderFilter;
    onSelect: (filter: WorkflowFolderFilter) => void;
    onCreateWorkflow: (folderId?: string) => void;
    onCreateFolder: (name: string) => Promise<WorkflowFolder>;
    onRenameFolder: (folder: WorkflowFolder, name: string) => Promise<WorkflowFolder>;
    onDeleteFolder: (folder: WorkflowFolder, targetFolderId?: string) => Promise<number>;
}): import("react").JSX.Element;

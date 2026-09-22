import { type WorkflowDocument, type WorkflowFolder } from '../model.js';
export declare function CreateWorkflowDialog({ onClose, onCreate, folders, initialFolderId, }: {
    onClose: () => void;
    onCreate: (name: string, document: WorkflowDocument, folderId?: string) => void | Promise<void>;
    folders?: WorkflowFolder[];
    initialFolderId?: string;
}): import("react").JSX.Element;

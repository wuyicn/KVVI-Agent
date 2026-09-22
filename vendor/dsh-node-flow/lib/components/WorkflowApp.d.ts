export type WorkflowSaveState = 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict' | 'error';
export declare function WorkflowApp({ onExit }: {
    onExit: () => void;
}): import("react").JSX.Element;

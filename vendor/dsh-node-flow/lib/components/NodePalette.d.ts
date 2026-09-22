/**
 * Left-side node palette drawer. List node types grouped by category; drag an
 * item onto the canvas to place it there (or click to add at a random spot).
 * Also hosts the example workflows.
 *
 * @module components/NodePalette
 */
import type { WorkflowNodeType } from '../model.js';
type PaletteTab = 'nodes' | 'templates';
export declare function NodePalette({ onClose, onAdd, initialTab, insertMode, }: {
    onClose?: () => void;
    onAdd?: (kind: WorkflowNodeType, label: string) => void;
    initialTab?: PaletteTab;
    insertMode?: boolean;
}): import("react").JSX.Element;
export {};

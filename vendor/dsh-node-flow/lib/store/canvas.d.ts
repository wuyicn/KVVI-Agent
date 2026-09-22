/**
 * Zustand store for the canvas — nodes, edges, selection, and the bridge to
 * DSH's `ctx.workflows` service. Kept framework-agnostic so the same store can
 * back both the standalone demo UI and the embedded DSH client plugin.
 *
 * @module store
 */
import { type NodeChange, type EdgeChange, type Connection } from '@xyflow/react';
import { type WorkflowConcurrency, type WorkflowContractField, type WorkflowDocument, type WorkflowExecutionLimits, type WorkflowNode, type WorkflowEdge, type WorkflowNodeType } from '../model.js';
type CanvasState = {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    activeEdgeIds: string[];
    selectedId: string | null;
    selectedEdgeId: string | null;
    workflowName: string;
    workflowInputs: WorkflowContractField[];
    workflowOutputs: WorkflowContractField[];
    workflowConcurrency?: WorkflowConcurrency;
    workflowExecutionLimits?: WorkflowExecutionLimits;
    theme: 'dark' | 'light';
    onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void;
    onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void;
    onConnect: (conn: Connection) => void;
    addNodeAt: (kind: WorkflowNodeType, label: string, position: {
        x: number;
        y: number;
    }) => string;
    insertNodeOnEdge: (edgeId: string, kind: WorkflowNodeType, label: string) => string | null;
    updateNodeData: (id: string, patch: Partial<WorkflowNode['data']>) => void;
    clearActiveEdges: () => void;
    markEdgeActive: (id: string) => void;
    removeNode: (id: string) => void;
    removeEdge: (id: string) => void;
    select: (id: string | null) => void;
    selectEdge: (id: string | null) => void;
    setTheme: (theme: 'dark' | 'light') => void;
    toggleTheme: () => void;
    setWorkflowName: (name: string) => void;
    setWorkflowContract: (inputs: WorkflowContractField[], outputs: WorkflowContractField[]) => void;
    setWorkflowConcurrency: (concurrency: WorkflowConcurrency | undefined) => void;
    setWorkflowExecutionLimits: (limits: WorkflowExecutionLimits | undefined) => void;
    /** Export the current canvas as a DSH workflow spec. */
    exportDocument: () => WorkflowDocument;
    /** Build the ordered step list for ctx.workflows. */
    toSteps: () => unknown[];
    /** Load a saved document into the canvas. */
    importDocument: (doc: WorkflowDocument) => void;
};
export declare const useCanvasStore: import("zustand").UseBoundStore<import("zustand").StoreApi<CanvasState>>;
export {};

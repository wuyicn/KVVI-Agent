/**
 * Zustand store for the canvas — nodes, edges, selection, and the bridge to
 * DSH's `ctx.workflows` service. Kept framework-agnostic so the same store can
 * back both the standalone demo UI and the embedded DSH client plugin.
 *
 * @module store
 */

import { create } from 'zustand'
import { applyNodeChanges, applyEdgeChanges, addEdge, type NodeChange, type EdgeChange, type Connection } from '@xyflow/react'
import { createNode, NODE_SIZE, toStepList, type WorkflowConcurrency, type WorkflowContractField, type WorkflowDocument, type WorkflowExecutionLimits, type WorkflowNode, type WorkflowEdge, type WorkflowNodeType } from '../model.js'

type CanvasState = {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  activeEdgeIds: string[]
  selectedId: string | null
  selectedEdgeId: string | null
  workflowName: string
  workflowInputs: WorkflowContractField[]
  workflowOutputs: WorkflowContractField[]
  workflowConcurrency?: WorkflowConcurrency
  workflowExecutionLimits?: WorkflowExecutionLimits
  theme: 'dark' | 'light'
  // actions
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void
  onConnect: (conn: Connection) => void
  addNodeAt: (kind: WorkflowNodeType, label: string, position: { x: number; y: number }) => string
  insertNodeOnEdge: (edgeId: string, kind: WorkflowNodeType, label: string) => string | null
  updateNodeData: (id: string, patch: Partial<WorkflowNode['data']>) => void
  clearActiveEdges: () => void
  markEdgeActive: (id: string) => void
  removeNode: (id: string) => void
  removeEdge: (id: string) => void
  select: (id: string | null) => void
  selectEdge: (id: string | null) => void
  setTheme: (theme: 'dark' | 'light') => void
  toggleTheme: () => void
  setWorkflowName: (name: string) => void
  setWorkflowContract: (inputs: WorkflowContractField[], outputs: WorkflowContractField[]) => void
  setWorkflowConcurrency: (concurrency: WorkflowConcurrency | undefined) => void
  setWorkflowExecutionLimits: (limits: WorkflowExecutionLimits | undefined) => void
  /** Export the current canvas as a DSH workflow spec. */
  exportDocument: () => WorkflowDocument
  /** Build the ordered step list for ctx.workflows. */
  toSteps: () => unknown[]
  /** Load a saved document into the canvas. */
  importDocument: (doc: WorkflowDocument) => void
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [
    {
      id: 'trigger-1',
      type: 'workflow',
      position: { x: 80, y: 200 },
      data: { kind: 'trigger', label: 'Start' },
      style: { width: NODE_SIZE.trigger.width, height: NODE_SIZE.trigger.height },
    },
  ],
  edges: [],
  activeEdgeIds: [],
  selectedId: null,
  selectedEdgeId: null,
  workflowName: 'Untitled workflow',
  workflowInputs: [],
  workflowOutputs: [],
  workflowConcurrency: undefined,
  workflowExecutionLimits: undefined,
  theme: 'dark',

  setTheme: (t) => {
    try {
      localStorage.setItem('dsh-node-flow:theme', t)
    } catch {
      /* ignore */
    }
    set({ theme: t })
  },
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem('dsh-node-flow:theme', next)
    } catch {
      /* ignore */
    }
    set({ theme: next })
  },

  onNodesChange: (changes) => {
    const structuralChanges = changes.filter((change) => change.type !== 'select')
    if (structuralChanges.length === 0) return
    set((s) => ({ nodes: applyNodeChanges(structuralChanges, s.nodes) }))
  },
  onEdgesChange: (changes) => {
    const structuralChanges = changes.filter((change) => change.type !== 'select')
    if (structuralChanges.length === 0) return
    set((s) => {
      const edges = applyEdgeChanges(structuralChanges, s.edges)
      const edgeIds = new Set(edges.map((edge) => edge.id))
      return {
        edges,
        activeEdgeIds: s.activeEdgeIds.filter((id) => edgeIds.has(id)),
      }
    })
  },
  onConnect: (conn) =>
    set((s) => ({ edges: addEdge({ ...conn, data: { label: undefined } }, s.edges) })),

  addNodeAt: (kind, label, position) => {
    const n = { ...createNode(kind, label, position), selected: true }
    set((s) => ({
      nodes: [...s.nodes.map((node) => ({ ...node, selected: false })), n],
      edges: s.edges.map((edge) => ({ ...edge, selected: false })),
      selectedId: n.id,
      selectedEdgeId: null,
    }))
    return n.id
  },

  insertNodeOnEdge: (edgeId, kind, label) => {
    const state = get()
    const edge = state.edges.find((candidate) => candidate.id === edgeId)
    if (!edge) return null
    const source = state.nodes.find((node) => node.id === edge.source)
    const target = state.nodes.find((node) => node.id === edge.target)
    if (!source || !target) return null

    const node = createNode(kind, label, {
      x: (source.position.x + target.position.x) / 2,
      y: (source.position.y + target.position.y) / 2,
    })
    const suffix = Date.now().toString(36)
    const incoming: WorkflowEdge = {
      ...edge,
      id: `${edge.id}-in-${suffix}`,
      target: node.id,
      targetHandle: null,
    }
    const branchHandle = kind === 'if'
      ? 'true'
      : kind === 'switch'
        ? 'default'
        : kind === 'loop' || kind === 'while'
          ? 'done'
          : undefined
    const outgoing: WorkflowEdge = {
      id: `${edge.id}-out-${suffix}`,
      source: node.id,
      sourceHandle: branchHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
      type: edge.type,
      data: { label: undefined },
    }
    set({
      nodes: [...state.nodes.map((candidate) => ({ ...candidate, selected: false })), { ...node, selected: true }],
      edges: [...state.edges.filter((candidate) => candidate.id !== edgeId).map((candidate) => ({ ...candidate, selected: false })), incoming, outgoing],
      activeEdgeIds: state.activeEdgeIds.filter((id) => id !== edgeId),
      selectedId: node.id,
      selectedEdgeId: null,
    })
    return node.id
  },

  updateNodeData: (id, patch) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
    })),

  clearActiveEdges: () => set({ activeEdgeIds: [] }),
  markEdgeActive: (id) =>
    set((s) => (s.activeEdgeIds.includes(id) ? {} : { activeEdgeIds: [...s.activeEdgeIds, id] })),

  removeNode: (id) =>
    set((s) => {
      const edges = s.edges.filter((e) => e.source !== id && e.target !== id)
      const edgeIds = new Set(edges.map((edge) => edge.id))
      return {
        nodes: s.nodes.filter((n) => n.id !== id),
        edges,
        activeEdgeIds: s.activeEdgeIds.filter((edgeId) => edgeIds.has(edgeId)),
        selectedId: s.selectedId === id ? null : s.selectedId,
        selectedEdgeId: null,
      }
    }),

  removeEdge: (id) =>
    set((s) => ({
      edges: s.edges.filter((e) => e.id !== id),
      activeEdgeIds: s.activeEdgeIds.filter((edgeId) => edgeId !== id),
      selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
    })),

  select: (id) => set((s) => {
    if (s.selectedId === id && s.selectedEdgeId === null) return s
    return {
      nodes: s.nodes.map((node) => ({ ...node, selected: node.id === id })),
      edges: s.edges.map((edge) => ({ ...edge, selected: false })),
      selectedId: id,
      selectedEdgeId: null,
    }
  }),
  selectEdge: (id) => set((s) => {
    if (s.selectedEdgeId === id && s.selectedId === null) return s
    return {
      nodes: s.nodes.map((node) => ({ ...node, selected: false })),
      edges: s.edges.map((edge) => ({ ...edge, selected: edge.id === id })),
      selectedEdgeId: id,
      selectedId: null,
    }
  }),
  setWorkflowName: (name) => set({ workflowName: name }),
  setWorkflowContract: (workflowInputs, workflowOutputs) => set({ workflowInputs, workflowOutputs }),
  setWorkflowConcurrency: (workflowConcurrency) => set({ workflowConcurrency }),
  setWorkflowExecutionLimits: (workflowExecutionLimits) => set({ workflowExecutionLimits }),

  exportDocument: () => ({
    version: 1,
    name: get().workflowName,
    concurrency: get().workflowConcurrency,
    executionLimits: get().workflowExecutionLimits,
    inputs: get().workflowInputs,
    outputs: get().workflowOutputs,
    nodes: get().nodes,
    edges: get().edges,
  }),

  toSteps: () => toStepList(get().exportDocument()),

  importDocument: (doc) =>
    set({
      nodes: doc.nodes.map((node) => ({
        ...node,
        selected: false,
        style: { ...node.style, width: NODE_SIZE[node.data.kind].width, height: NODE_SIZE[node.data.kind].height },
      })),
      edges: doc.edges.map((edge) => ({ ...edge, selected: false })),
      activeEdgeIds: [],
      selectedId: null,
      selectedEdgeId: null,
      workflowName: doc.name,
      workflowConcurrency: doc.concurrency,
      workflowExecutionLimits: doc.executionLimits,
      workflowInputs: Array.isArray(doc.inputs) ? doc.inputs : [],
      workflowOutputs: Array.isArray(doc.outputs) ? doc.outputs : [],
    }),
}))

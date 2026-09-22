import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Main canvas — React Flow wrapper wiring the store to the renderer.
 *
 * @module components/Canvas
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, BackgroundVariant } from '@xyflow/react';
import { Activity, LayoutTemplate, Plus, Workflow } from 'lucide-react';
import { useCanvasStore } from '../store/canvas.js';
import { WorkflowNodeView } from '../nodes/WorkflowNodeView.js';
import { Toolbar } from './Toolbar.js';
import { Inspector } from './Inspector.js';
import { NodePalette } from './NodePalette.js';
import { ExecutionPanel } from './ExecutionPanel.js';
import { WorkflowEdgeView } from './WorkflowEdgeView.js';
const nodeTypes = { workflow: WorkflowNodeView };
const edgeTypes = { workflow: WorkflowEdgeView };
const DEFAULT_LABELS = {
    trigger: '触发器',
    webhook: 'Webhook',
    schedule: '定时触发',
    'connector-trigger': '应用触发器',
    agent: 'Agent',
    'call-workflow': '调用工作流',
    connector: '应用连接器',
    'data-store': 'Data Store',
    wait: '等待',
    code: '代码执行',
    http: 'HTTP 请求',
    output: '输出',
    if: 'If',
    switch: 'Switch',
    loop: 'Loop',
    while: 'While',
    note: '备注',
};
const FIT_VIEW_OPTIONS = {
    padding: { top: 24, right: 24, bottom: 24, left: 24 },
    minZoom: 0.2,
    maxZoom: 1,
};
export function Canvas({ workflowId, onExitNodeMode, onBackToDashboard, onSave, saveState = 'saved', workflowStatus = 'disabled', workflowHasUnpublishedChanges = false, executionInputs, onStatusChange, onRunComplete, } = {}) {
    const nodes = useCanvasStore((s) => s.nodes);
    const edges = useCanvasStore((s) => s.edges);
    const activeEdgeIds = useCanvasStore((s) => s.activeEdgeIds);
    const onNodesChange = useCanvasStore((s) => s.onNodesChange);
    const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
    const onConnect = useCanvasStore((s) => s.onConnect);
    const select = useCanvasStore((s) => s.select);
    const selectEdge = useCanvasStore((s) => s.selectEdge);
    const addNodeAt = useCanvasStore((s) => s.addNodeAt);
    const insertNodeOnEdge = useCanvasStore((s) => s.insertNodeOnEdge);
    const selectedId = useCanvasStore((s) => s.selectedId);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [paletteTab, setPaletteTab] = useState('nodes');
    const [insertEdgeId, setInsertEdgeId] = useState(null);
    const [executionOpen, setExecutionOpen] = useState(false);
    const [debugRun, setDebugRun] = useState(null);
    const [debugBusy, setDebugBusy] = useState(false);
    const rfRef = useRef(null);
    const applyRemoteRun = (run) => {
        const waitNodeId = run.waitpoint?.nodeId;
        const store = useCanvasStore.getState();
        store.clearActiveEdges();
        for (const node of store.nodes)
            store.updateNodeData(node.id, { lastRun: undefined });
        for (const record of run.nodes) {
            store.updateNodeData(record.id, {
                lastRun: {
                    input: typeof record.input === 'string' ? record.input : JSON.stringify(record.input ?? ''),
                    logs: record.logs ?? [],
                    value: record.output,
                    error: record.error,
                    errorHandled: record.errorHandled,
                    at: new Date().toLocaleTimeString(),
                    duration: record.ms,
                    attempts: record.attempts,
                    childRunId: record.childRunId,
                    waiting: run.status === 'waiting' && record.id === waitNodeId,
                    debugPaused: run.status === 'waiting' && Boolean(record.debugPaused),
                },
            });
        }
    };
    const startDebug = async (input) => {
        if (!workflowId || debugBusy)
            throw new Error('请先保存工作流再开始调试');
        setDebugBusy(true);
        try {
            const runId = `debug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
            const response = await fetch('/dsh-node-flow/workflows', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'debug', id: workflowId, runId, document: useCanvasStore.getState().exportDocument(), input }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.run)
                throw new Error(data.error || `HTTP ${response.status}`);
            setDebugRun(data.run);
            applyRemoteRun(data.run);
            setExecutionOpen(true);
        }
        catch (error) {
            window.alert(error instanceof Error ? error.message : String(error));
        }
        finally {
            setDebugBusy(false);
        }
    };
    const controlDebug = async (action) => {
        const source = debugRun;
        if (!source || source.status !== 'waiting' || source.waitpoint?.mode !== 'debug' || debugBusy)
            return;
        setDebugBusy(true);
        try {
            const response = await fetch('/dsh-node-flow/runs', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: action === 'step' ? 'debug-step' : 'debug-continue', id: source.id }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.run)
                throw new Error(data.error || `HTTP ${response.status}`);
            setDebugRun(data.run);
            applyRemoteRun(data.run);
        }
        catch (error) {
            window.alert(error instanceof Error ? error.message : String(error));
        }
        finally {
            setDebugBusy(false);
        }
    };
    const cancelDebug = async () => {
        const source = debugRun;
        if (!source || debugBusy)
            return;
        setDebugBusy(true);
        try {
            const response = await fetch('/dsh-node-flow/workflows', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'cancel', runId: source.id }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok)
                throw new Error(data.error || `HTTP ${response.status}`);
            const cancelled = { ...source, status: 'cancelled', completedAt: new Date().toISOString(), waitpoint: undefined };
            setDebugRun(cancelled);
            applyRemoteRun(cancelled);
        }
        catch (error) {
            window.alert(error instanceof Error ? error.message : String(error));
        }
        finally {
            setDebugBusy(false);
        }
    };
    const renderedEdges = useMemo(() => {
        const activeIds = new Set(activeEdgeIds);
        return edges.map((edge) => {
            const classes = (edge.className ?? '')
                .split(/\s+/)
                .filter((className) => className && className !== 'wf-edge--active' && className !== 'wf-edge--error');
            if (edge.sourceHandle === 'error')
                classes.push('wf-edge--error');
            if (activeIds.has(edge.id))
                classes.push('wf-edge--active');
            return {
                ...edge,
                type: 'workflow',
                data: {
                    ...edge.data,
                    error: edge.sourceHandle === 'error',
                    onInsert: () => {
                        setInsertEdgeId(edge.id);
                        setPaletteTab('nodes');
                        setPaletteOpen(true);
                    },
                },
                className: classes.join(' ') || undefined,
            };
        });
    }, [activeEdgeIds, edges]);
    const openPalette = (tab) => {
        setInsertEdgeId(null);
        setPaletteTab(tab);
        setPaletteOpen(true);
    };
    const addFromPalette = (kind, label) => {
        if (insertEdgeId) {
            insertNodeOnEdge(insertEdgeId, kind, label);
            setInsertEdgeId(null);
            return;
        }
        addNodeAt(kind, label, { x: 180 + Math.random() * 220, y: 120 + Math.random() * 220 });
    };
    // Delete / Backspace removes the selected edge, else the selected node.
    // Guarded so it never fires while typing in an input/textarea/select or a contenteditable.
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.key !== 'Delete' && e.key !== 'Backspace')
                return;
            const t = e.target;
            if (document.querySelector('[role="dialog"][aria-modal="true"]')
                || document.querySelector('.wf-action-menu, .wf-palette, .wf-execution')
                || (t && (t.tagName === 'INPUT'
                    || t.tagName === 'TEXTAREA'
                    || t.tagName === 'SELECT'
                    || t.isContentEditable
                    || Boolean(t.closest('button, a'))))) {
                return;
            }
            const store = useCanvasStore.getState();
            if (store.selectedEdgeId) {
                e.preventDefault();
                store.removeEdge(store.selectedEdgeId);
            }
            else if (store.selectedId) {
                e.preventDefault();
                store.removeNode(store.selectedId);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);
    useEffect(() => {
        const closeOnEscape = (event) => {
            if (event.key !== 'Escape')
                return;
            if (document.querySelector('[role="dialog"][aria-modal="true"], .wf-action-menu'))
                return;
            if (paletteOpen) {
                setPaletteOpen(false);
                setInsertEdgeId(null);
            }
            else if (executionOpen) {
                setExecutionOpen(false);
            }
            else {
                select(null);
            }
        };
        document.addEventListener('keydown', closeOnEscape);
        return () => document.removeEventListener('keydown', closeOnEscape);
    }, [executionOpen, paletteOpen, select]);
    const onDragOver = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    };
    const onDrop = (e) => {
        e.preventDefault();
        const kind = e.dataTransfer.getData('application/reactflow');
        if (!kind || !rfRef.current)
            return;
        const pos = rfRef.current.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        addNodeAt(kind, DEFAULT_LABELS[kind] ?? kind, pos);
    };
    return (_jsxs("div", { className: "wf-shell", children: [_jsx(Toolbar, { workflowId: workflowId, onExitNodeMode: onExitNodeMode, onBackToDashboard: onBackToDashboard, onSave: onSave, saveState: saveState, workflowStatus: workflowStatus, workflowHasUnpublishedChanges: workflowHasUnpublishedChanges, executionInputs: executionInputs, onStatusChange: onStatusChange, onRunComplete: onRunComplete, onClearDebug: () => setDebugRun(null), onStartDebug: startDebug, debugActive: debugRun?.status === 'waiting' && debugRun.waitpoint?.mode === 'debug', debugBusy: debugBusy, onOpenLibrary: () => openPalette('nodes'), onOpenTemplates: () => openPalette('templates'), onShowExecution: () => setExecutionOpen((open) => !open), executionOpen: executionOpen }), _jsxs("div", { className: "wf-main", children: [_jsxs("nav", { className: "wf-rail", "aria-label": "\u5DE5\u4F5C\u6D41\u5DE5\u5177", children: [_jsx("button", { className: paletteOpen && paletteTab === 'nodes' ? 'is-active' : '', onClick: () => openPalette('nodes'), title: "\u6DFB\u52A0\u8282\u70B9", "aria-label": "\u6DFB\u52A0\u8282\u70B9", children: _jsx(Plus, { size: 19 }) }), _jsx("button", { className: paletteOpen && paletteTab === 'templates' ? 'is-active' : '', onClick: () => openPalette('templates'), title: "\u5DE5\u4F5C\u6D41\u6A21\u677F", "aria-label": "\u5DE5\u4F5C\u6D41\u6A21\u677F", children: _jsx(LayoutTemplate, { size: 18 }) }), _jsx("span", { className: "wf-rail__divider" }), _jsx("button", { className: executionOpen ? 'is-active' : '', onClick: () => setExecutionOpen((open) => !open), title: "\u8FD0\u884C\u8BE6\u60C5", "aria-label": "\u8FD0\u884C\u8BE6\u60C5", children: _jsx(Activity, { size: 18 }) })] }), _jsxs("div", { className: "wf-canvas", children: [_jsxs(ReactFlow, { nodes: nodes, edges: renderedEdges, nodeTypes: nodeTypes, edgeTypes: edgeTypes, defaultEdgeOptions: { type: 'workflow' }, onNodesChange: onNodesChange, onEdgesChange: onEdgesChange, onConnect: onConnect, onNodeClick: (_event, node) => select(node.id), onEdgeClick: (_event, edge) => selectEdge(edge.id), onPaneClick: () => select(null), onDragOver: onDragOver, onDrop: onDrop, onInit: (inst) => {
                                    const flow = inst;
                                    rfRef.current = flow;
                                    window.requestAnimationFrame(() => {
                                        window.requestAnimationFrame(() => { void flow.fitView(FIT_VIEW_OPTIONS); });
                                    });
                                }, fitView: true, fitViewOptions: FIT_VIEW_OPTIONS, proOptions: { hideAttribution: true }, deleteKeyCode: null, children: [_jsx(Background, { variant: BackgroundVariant.Dots, gap: 18, size: 1 }), _jsx(Controls, {}), _jsx(MiniMap, { position: "bottom-right", nodeColor: (n) => {
                                            const kinds = {
                                                trigger: '#10b981', webhook: '#2563a8', schedule: '#fb923c', agent: '#8b5cf6', 'call-workflow': '#4f75d8',
                                                if: '#fbbf24', switch: '#f472b6', code: '#14b8a6', http: '#176b87', output: '#ef4444',
                                            };
                                            return kinds[n.data?.kind ?? ''] ?? '#94a3b8';
                                        } })] }), _jsxs("div", { className: "wf-canvas-meta", children: [_jsx(Workflow, { size: 13 }), " ", nodes.length, " \u4E2A\u8282\u70B9 ", _jsx("span", {}), " ", edges.length, " \u6761\u8FDE\u63A5"] }), paletteOpen && (_jsx(NodePalette, { initialTab: paletteTab, insertMode: insertEdgeId !== null, onAdd: addFromPalette, onClose: () => {
                                    setPaletteOpen(false);
                                    setInsertEdgeId(null);
                                } }, `${paletteTab}-${insertEdgeId ?? 'free'}`)), executionOpen && _jsx(ExecutionPanel, { onClose: () => setExecutionOpen(false), debugRun: debugRun, debugBusy: debugBusy, onDebugAction: controlDebug, onCancelDebug: () => { void cancelDebug(); } })] }), selectedId && _jsx(Inspector, { workflowId: workflowId })] })] }));
}

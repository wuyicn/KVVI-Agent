import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, CopyPlus, RefreshCw, X } from 'lucide-react';
import { Canvas } from './Canvas.js';
import { CreateWorkflowDialog } from './CreateWorkflowDialog.js';
import { WorkflowDashboard } from './WorkflowDashboard.js';
import { refreshWebhookTokens } from '../model.js';
import { useCanvasStore } from '../store/canvas.js';
import { acceptLatestWorkflow, cancelWorkflowRun, deleteSavedWorkflow, deleteSavedWorkflowFolder, createSavedWorkflowFolder, isWorkflowSyncPending, listWorkflowFolders, listSavedWorkflows, markWorkflowRun, resumeWorkflowRun, restoreSavedWorkflowVersion, renameSavedWorkflowFolder, runSavedWorkflow, saveSavedWorkflow, saveWorkflowRun, updateSavedWorkflowStatus, moveSavedWorkflowToFolder, WorkflowConflictError, } from '../workflowRepository.js';
import { executionDocument, hasUnpublishedChanges } from '../workflowProtocol.js';
function workflowId() {
    return globalThis.crypto?.randomUUID?.() ?? `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function cleanDocument(document) {
    return {
        ...document,
        nodes: document.nodes.map((node) => ({
            ...node,
            dragging: undefined,
            measured: undefined,
            selected: false,
            data: { ...node.data, lastRun: undefined },
        })),
        edges: document.edges.map((edge) => ({ ...edge, selected: false })),
    };
}
function sortWorkflows(workflows) {
    return [...workflows].sort((left, right) => {
        const created = right.createdAt.localeCompare(left.createdAt);
        return created !== 0 ? created : left.id.localeCompare(right.id);
    });
}
export function WorkflowApp({ onExit }) {
    const nodes = useCanvasStore((state) => state.nodes);
    const edges = useCanvasStore((state) => state.edges);
    const workflowName = useCanvasStore((state) => state.workflowName);
    const workflowInputs = useCanvasStore((state) => state.workflowInputs);
    const workflowOutputs = useCanvasStore((state) => state.workflowOutputs);
    const workflowConcurrency = useCanvasStore((state) => state.workflowConcurrency);
    const workflowExecutionLimits = useCanvasStore((state) => state.workflowExecutionLimits);
    const [view, setView] = useState('dashboard');
    const [section, setSection] = useState('workflows');
    const [workflows, setWorkflows] = useState([]);
    const [folders, setFolders] = useState([]);
    const [activeWorkflow, setActiveWorkflow] = useState(null);
    const [loading, setLoading] = useState(true);
    const [createOpen, setCreateOpen] = useState(false);
    const [createFolderId, setCreateFolderId] = useState();
    const [saveState, setSaveState] = useState('saved');
    const [notice, setNotice] = useState(null);
    const [conflict, setConflict] = useState(null);
    const [conflictResolving, setConflictResolving] = useState(false);
    const activeWorkflowRef = useRef(null);
    const savedSignature = useRef('');
    const saveQueue = useRef(Promise.resolve());
    const saveRevision = useRef(0);
    const createInFlight = useRef(false);
    const navigationInFlight = useRef(false);
    const noticeSequence = useRef(0);
    const workflowMutations = useRef(new Set());
    const conflictActionInFlight = useRef(false);
    const currentDocument = useMemo(() => cleanDocument({
        version: 1,
        name: workflowName,
        concurrency: workflowConcurrency,
        executionLimits: workflowExecutionLimits,
        inputs: workflowInputs,
        outputs: workflowOutputs,
        nodes,
        edges,
    }), [edges, nodes, workflowConcurrency, workflowExecutionLimits, workflowInputs, workflowName, workflowOutputs]);
    const currentSignature = useMemo(() => JSON.stringify(currentDocument), [currentDocument]);
    const snapshotNow = useCallback(() => cleanDocument(useCanvasStore.getState().exportDocument()), []);
    const notify = useCallback((tone, message) => {
        const id = ++noticeSequence.current;
        setNotice({ id, tone, message });
        window.setTimeout(() => setNotice((current) => current?.id === id ? null : current), 3200);
    }, []);
    const setCurrentWorkflow = useCallback((workflow) => {
        activeWorkflowRef.current = workflow;
        setActiveWorkflow(workflow);
    }, []);
    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const [nextWorkflows, nextFolders] = await Promise.all([listSavedWorkflows(), listWorkflowFolders()]);
            setWorkflows(nextWorkflows);
            setFolders(nextFolders);
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        void refresh();
    }, [refresh]);
    const openWorkflow = useCallback((workflow) => {
        if (workflowMutations.current.has(workflow.id))
            return;
        const document = cleanDocument(workflow.doc);
        saveRevision.current += 1;
        useCanvasStore.getState().importDocument(document);
        setCurrentWorkflow(workflow);
        savedSignature.current = JSON.stringify(cleanDocument(useCanvasStore.getState().exportDocument()));
        setSaveState(isWorkflowSyncPending(workflow.id) ? 'offline' : 'saved');
        setConflict(null);
        setConflictResolving(false);
        setView('editor');
    }, [setCurrentWorkflow]);
    const persist = useCallback((document, patch) => {
        const target = activeWorkflowRef.current;
        if (!target)
            return Promise.resolve(null);
        const revision = ++saveRevision.current;
        setSaveState('saving');
        const operation = saveQueue.current.then(async () => {
            const current = activeWorkflowRef.current?.id === target.id ? activeWorkflowRef.current : target;
            const saved = await saveSavedWorkflow({
                ...current,
                ...patch,
                name: document.name,
                doc: document,
            });
            setWorkflows((items) => sortWorkflows([saved, ...items.filter((item) => item.id !== saved.id)]));
            const isCurrentWorkflow = activeWorkflowRef.current?.id === saved.id;
            if (isCurrentWorkflow)
                setCurrentWorkflow(saved);
            if (isCurrentWorkflow && revision === saveRevision.current) {
                savedSignature.current = JSON.stringify(document);
                setSaveState(isWorkflowSyncPending(saved.id) ? 'offline' : 'saved');
            }
            return saved;
        });
        saveQueue.current = operation.then(() => undefined, () => undefined);
        return operation.catch((error) => {
            if (error instanceof WorkflowConflictError) {
                setConflict({ latest: error.latest, localDocument: document });
                if (revision === saveRevision.current)
                    setSaveState('conflict');
            }
            else {
                if (revision === saveRevision.current)
                    setSaveState('error');
                notify('error', error instanceof Error ? error.message : '工作流保存失败');
            }
            return null;
        });
    }, [notify, setCurrentWorkflow]);
    useEffect(() => {
        if (view !== 'editor' || !activeWorkflow || conflict || currentSignature === savedSignature.current)
            return;
        setSaveState('dirty');
        const timer = window.setTimeout(() => { void persist(currentDocument); }, 850);
        return () => window.clearTimeout(timer);
    }, [activeWorkflow, conflict, currentDocument, currentSignature, persist, view]);
    const createWorkflow = useCallback(async (name, document, folderId) => {
        if (createInFlight.current)
            return;
        createInFlight.current = true;
        const now = new Date().toISOString();
        const workflow = {
            id: workflowId(),
            name,
            folderId,
            status: 'disabled',
            revision: 0,
            draftRevision: 0,
            createdAt: now,
            updatedAt: now,
            doc: cleanDocument({ ...document, name }),
        };
        try {
            const saved = await saveSavedWorkflow(workflow);
            setWorkflows((items) => sortWorkflows([saved, ...items]));
            setCreateOpen(false);
            setCreateFolderId(undefined);
            openWorkflow(saved);
        }
        catch (error) {
            notify('error', error instanceof Error ? error.message : '工作流创建失败');
        }
        finally {
            createInFlight.current = false;
        }
    }, [notify, openWorkflow]);
    const createWorkflowFolder = useCallback(async (name) => {
        const result = await createSavedWorkflowFolder(name);
        setFolders(result.folders);
        return result.folder;
    }, []);
    const renameWorkflowFolder = useCallback(async (folder, name) => {
        const result = await renameSavedWorkflowFolder(folder, name);
        setFolders(result.folders);
        return result.folder;
    }, []);
    const deleteWorkflowFolder = useCallback(async (folder, targetFolderId) => {
        await saveQueue.current;
        const result = await deleteSavedWorkflowFolder(folder, targetFolderId);
        setFolders(result.folders);
        setWorkflows(sortWorkflows(result.workflows));
        const active = activeWorkflowRef.current;
        if (active) {
            const refreshed = result.workflows.find((workflow) => workflow.id === active.id);
            if (refreshed)
                setCurrentWorkflow(refreshed);
        }
        return result.moved;
    }, [setCurrentWorkflow]);
    const moveWorkflowFolder = useCallback(async (workflow, folderId) => {
        if (workflowMutations.current.has(workflow.id))
            throw new Error('当前工作流正在执行其他操作');
        workflowMutations.current.add(workflow.id);
        try {
            await saveQueue.current;
            const current = activeWorkflowRef.current?.id === workflow.id ? activeWorkflowRef.current : workflow;
            const saved = await moveSavedWorkflowToFolder(current, folderId);
            setWorkflows((items) => sortWorkflows(items.map((item) => item.id === saved.id ? saved : item)));
            if (activeWorkflowRef.current?.id === saved.id)
                setCurrentWorkflow(saved);
        }
        finally {
            workflowMutations.current.delete(workflow.id);
        }
    }, [setCurrentWorkflow]);
    const duplicateWorkflow = useCallback(async (workflow) => {
        if (workflowMutations.current.has(workflow.id))
            return;
        workflowMutations.current.add(workflow.id);
        const now = new Date().toISOString();
        const name = `${workflow.name} - 副本`;
        try {
            const saved = await saveSavedWorkflow({
                ...workflow,
                id: workflowId(),
                name,
                status: 'disabled',
                revision: 0,
                draftRevision: 0,
                publishedRevision: undefined,
                publishedAt: undefined,
                publishedDoc: undefined,
                createdAt: now,
                updatedAt: now,
                lastRunAt: undefined,
                doc: refreshWebhookTokens(cleanDocument({ ...workflow.doc, name })),
            });
            setWorkflows((items) => sortWorkflows([saved, ...items]));
            notify('success', `已复制“${workflow.name}”`);
        }
        catch (error) {
            notify('error', error instanceof Error ? error.message : '工作流复制失败');
        }
        finally {
            workflowMutations.current.delete(workflow.id);
        }
    }, [notify]);
    const deleteWorkflow = useCallback(async (workflow) => {
        if (!window.confirm(`确定删除“${workflow.name}”吗？此操作无法撤销。`))
            return;
        if (workflowMutations.current.has(workflow.id))
            return;
        workflowMutations.current.add(workflow.id);
        try {
            await deleteSavedWorkflow(workflow);
            setWorkflows((items) => items.filter((item) => item.id !== workflow.id));
            notify('success', '工作流已删除');
        }
        catch (error) {
            if (error instanceof WorkflowConflictError) {
                setWorkflows((items) => sortWorkflows([error.latest, ...items.filter((item) => item.id !== error.latest.id)]));
                notify('error', '删除失败：服务器中已有更新，请重新确认');
            }
            else {
                notify('error', error instanceof Error ? error.message : '工作流删除失败');
            }
        }
        finally {
            workflowMutations.current.delete(workflow.id);
        }
    }, [notify]);
    const updateStatus = useCallback(async (workflow, status) => {
        if (workflowMutations.current.has(workflow.id))
            return;
        workflowMutations.current.add(workflow.id);
        try {
            if (activeWorkflowRef.current?.id === workflow.id) {
                const document = snapshotNow();
                if (JSON.stringify(document) !== savedSignature.current) {
                    const savedDraft = await persist(document);
                    if (!savedDraft)
                        return;
                }
            }
            const operation = saveQueue.current.then(async () => {
                const current = activeWorkflowRef.current?.id === workflow.id ? activeWorkflowRef.current : workflow;
                const saved = await updateSavedWorkflowStatus(current, status);
                setWorkflows((items) => items.map((item) => item.id === saved.id ? saved : item));
                if (activeWorkflowRef.current?.id === saved.id)
                    setCurrentWorkflow(saved);
                notify('success', status === 'enabled' ? (workflow.status === 'enabled' ? '已发布最新草稿' : '工作流已启用') : '工作流已停用');
            });
            saveQueue.current = operation.then(() => undefined, () => undefined);
            await operation;
        }
        catch (error) {
            if (error instanceof WorkflowConflictError) {
                setWorkflows((items) => items.map((item) => item.id === error.latest.id ? error.latest : item));
                if (activeWorkflowRef.current?.id === error.latest.id) {
                    setConflict({ latest: error.latest, localDocument: snapshotNow() });
                    setSaveState('conflict');
                }
                notify('error', '发布前发现服务器已有更新');
            }
            else {
                notify('error', error instanceof Error ? error.message : '工作流状态更新失败');
            }
        }
        finally {
            workflowMutations.current.delete(workflow.id);
        }
    }, [notify, persist, setCurrentWorkflow, snapshotNow]);
    const runFromDashboard = useCallback(async (workflow, runId, signal, input) => {
        if (workflowMutations.current.has(workflow.id))
            return;
        workflowMutations.current.add(workflow.id);
        try {
            const result = await runSavedWorkflow(workflow, runId, signal, input);
            setWorkflows((items) => sortWorkflows(items.map((item) => item.id === result.workflow.id ? result.workflow : item)));
            if (activeWorkflowRef.current?.id === result.workflow.id)
                setCurrentWorkflow(result.workflow);
            notify(result.run.status === 'ok' || result.run.status === 'handled' || result.run.status === 'waiting' ? 'success' : 'error', result.run.status === 'ok'
                ? '工作流运行成功'
                : result.run.status === 'handled'
                    ? '工作流运行完成，错误已由分支处理'
                    : result.run.status === 'waiting'
                        ? '工作流已进入等待状态'
                        : '工作流运行完成，但存在失败节点');
        }
        catch (error) {
            if (signal.aborted)
                notify('success', '工作流运行已停止');
            else
                notify('error', error instanceof Error ? error.message : '工作流运行失败');
            throw error;
        }
        finally {
            workflowMutations.current.delete(workflow.id);
        }
    }, [notify, setCurrentWorkflow]);
    const restoreVersion = useCallback(async (workflow, version, publish) => {
        if (workflowMutations.current.has(workflow.id))
            throw new Error('当前工作流正在执行其他操作');
        workflowMutations.current.add(workflow.id);
        try {
            const operation = saveQueue.current.then(() => restoreSavedWorkflowVersion(workflow, version.id, publish));
            saveQueue.current = operation.then(() => undefined, () => undefined);
            const saved = await operation;
            setWorkflows((items) => sortWorkflows(items.map((item) => item.id === saved.id ? saved : item)));
            if (activeWorkflowRef.current?.id === saved.id)
                setCurrentWorkflow(saved);
            notify('success', publish ? `已将 v${version.revision} 恢复并发布` : `已将 v${version.revision} 恢复为新草稿`);
            return saved;
        }
        catch (error) {
            if (error instanceof WorkflowConflictError) {
                setWorkflows((items) => items.map((item) => item.id === error.latest.id ? error.latest : item));
                notify('error', '恢复前发现服务器已有更新，请重新打开版本历史');
            }
            else {
                notify('error', error instanceof Error ? error.message : '历史版本恢复失败');
            }
            throw error;
        }
        finally {
            workflowMutations.current.delete(workflow.id);
        }
    }, [notify, setCurrentWorkflow]);
    const cancelDashboardRun = useCallback(async (runId) => {
        await cancelWorkflowRun(runId);
    }, []);
    const resumeDashboardRun = useCallback(async (run, runId, signal) => {
        try {
            const resumed = await resumeWorkflowRun(run, runId, signal);
            notify(resumed.status === 'ok' || resumed.status === 'handled' || resumed.status === 'cancelled' ? 'success' : 'error', resumed.status === 'ok'
                ? '已从失败节点恢复并完成'
                : resumed.status === 'handled'
                    ? '恢复运行完成，错误已由分支处理'
                    : resumed.status === 'cancelled'
                        ? '恢复运行已停止'
                        : '恢复运行结束，但仍有失败节点');
            return resumed;
        }
        catch (error) {
            if (signal.aborted)
                notify('success', '恢复运行已停止');
            else
                notify('error', error instanceof Error ? error.message : '恢复运行失败');
            throw error;
        }
    }, [notify]);
    const backToDashboard = useCallback(async () => {
        if (navigationInFlight.current)
            return;
        navigationInFlight.current = true;
        try {
            const document = snapshotNow();
            if (activeWorkflowRef.current && JSON.stringify(document) !== savedSignature.current) {
                const saved = await persist(document);
                if (!saved)
                    return;
            }
            await saveQueue.current;
            setView('dashboard');
            setSection('workflows');
            setCurrentWorkflow(null);
        }
        finally {
            navigationInFlight.current = false;
        }
    }, [persist, setCurrentWorkflow, snapshotNow]);
    const exitEditor = useCallback(async () => {
        if (navigationInFlight.current)
            return;
        navigationInFlight.current = true;
        try {
            const document = snapshotNow();
            if (activeWorkflowRef.current && JSON.stringify(document) !== savedSignature.current) {
                const saved = await persist(document);
                if (!saved)
                    return;
            }
            await saveQueue.current;
            onExit();
        }
        finally {
            navigationInFlight.current = false;
        }
    }, [onExit, persist, snapshotNow]);
    const completeEditorRun = useCallback(async (run) => {
        const workflow = activeWorkflowRef.current;
        if (!workflow)
            return;
        const record = { ...run, workflowId: workflow.id, name: workflow.name };
        await saveWorkflowRun(record);
        const saved = await markWorkflowRun(workflow, record.startedAt);
        setWorkflows((items) => items.map((item) => item.id === saved.id ? saved : item));
        if (activeWorkflowRef.current?.id === saved.id)
            setCurrentWorkflow(saved);
    }, [setCurrentWorkflow]);
    return (_jsxs(_Fragment, { children: [view === 'dashboard' ? (_jsx(WorkflowDashboard, { workflows: workflows, folders: folders, loading: loading, section: section, onSectionChange: setSection, onCreate: (folderId) => { setCreateFolderId(folderId); setCreateOpen(true); }, onOpen: openWorkflow, onRun: runFromDashboard, onCancelRun: cancelDashboardRun, onResumeRun: resumeDashboardRun, onDuplicate: duplicateWorkflow, onDelete: deleteWorkflow, onCreateFolder: createWorkflowFolder, onRenameFolder: renameWorkflowFolder, onDeleteFolder: deleteWorkflowFolder, onMoveToFolder: moveWorkflowFolder, onRestoreVersion: restoreVersion, onStatusChange: updateStatus, onUseTemplate: (name, document, folderId) => createWorkflow(name, { ...document, name }, folderId), onExit: onExit })) : (_jsx(Canvas, { workflowId: activeWorkflow?.id, onExitNodeMode: () => { void exitEditor(); }, onBackToDashboard: () => { void backToDashboard(); }, onSave: () => {
                    const document = snapshotNow();
                    if (JSON.stringify(document) !== savedSignature.current)
                        void persist(document);
                }, saveState: saveState, workflowStatus: activeWorkflow?.status ?? 'disabled', workflowHasUnpublishedChanges: activeWorkflow ? hasUnpublishedChanges(activeWorkflow) : false, executionInputs: activeWorkflow ? executionDocument(activeWorkflow).inputs : workflowInputs, onStatusChange: (status) => activeWorkflow ? updateStatus(activeWorkflow, status) : Promise.resolve(), onRunComplete: completeEditorRun })), createOpen && _jsx(CreateWorkflowDialog, { onClose: () => { setCreateOpen(false); setCreateFolderId(undefined); }, onCreate: createWorkflow, folders: folders, initialFolderId: createFolderId }), conflict && (_jsx("div", { className: "wf-dialog-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-conflict-dialog", role: "dialog", "aria-modal": "true", "aria-label": "\u5DE5\u4F5C\u6D41\u7248\u672C\u51B2\u7A81", children: [_jsxs("header", { children: [_jsx("span", { children: _jsx(CircleAlert, { size: 18 }) }), _jsxs("div", { children: [_jsx("strong", { children: "\u68C0\u6D4B\u5230\u53E6\u4E00\u4E2A\u7248\u672C" }), _jsx("p", { children: "\u670D\u52A1\u5668\u4E2D\u7684\u5DE5\u4F5C\u6D41\u5DF2\u88AB\u5176\u4ED6\u9875\u9762\u4FEE\u6539\u3002\u672C\u5730\u753B\u5E03\u4F1A\u4FDD\u7559\u5230\u4F60\u9009\u62E9\u5904\u7406\u65B9\u5F0F\u3002" })] })] }), _jsxs("div", { className: "wf-conflict-dialog__details", children: [_jsxs("span", { children: ["\u670D\u52A1\u5668\u7248\u672C ", _jsxs("strong", { children: ["v", conflict.latest.revision] })] }), _jsxs("span", { children: ["\u66F4\u65B0\u65F6\u95F4 ", _jsx("strong", { children: new Date(conflict.latest.updatedAt).toLocaleString() })] })] }), _jsxs("footer", { children: [_jsxs("button", { className: "wf-dialog-btn", disabled: conflictResolving, onClick: () => {
                                        if (conflictActionInFlight.current)
                                            return;
                                        acceptLatestWorkflow(conflict.latest);
                                        openWorkflow(conflict.latest);
                                    }, children: [_jsx(RefreshCw, { size: 15 }), "\u52A0\u8F7D\u670D\u52A1\u5668\u7248\u672C"] }), _jsxs("button", { className: "wf-dialog-btn wf-dialog-btn--primary", disabled: conflictResolving, onClick: async () => {
                                        if (conflictActionInFlight.current)
                                            return;
                                        conflictActionInFlight.current = true;
                                        setConflictResolving(true);
                                        const now = new Date().toISOString();
                                        const name = `${conflict.localDocument.name || conflict.latest.name} - 本地副本`;
                                        try {
                                            acceptLatestWorkflow(conflict.latest);
                                            const saved = await saveSavedWorkflow({
                                                ...conflict.latest,
                                                id: workflowId(),
                                                name,
                                                status: 'disabled',
                                                revision: 0,
                                                draftRevision: 0,
                                                publishedRevision: undefined,
                                                publishedAt: undefined,
                                                publishedDoc: undefined,
                                                createdAt: now,
                                                updatedAt: now,
                                                lastRunAt: undefined,
                                                doc: refreshWebhookTokens({ ...conflict.localDocument, name }),
                                            });
                                            setWorkflows((items) => sortWorkflows([conflict.latest, saved, ...items.filter((item) => item.id !== conflict.latest.id)]));
                                            openWorkflow(saved);
                                            notify('success', '本地画布已保存为独立副本');
                                        }
                                        catch (error) {
                                            notify('error', error instanceof Error ? error.message : '本地副本保存失败');
                                        }
                                        finally {
                                            conflictActionInFlight.current = false;
                                            setConflictResolving(false);
                                        }
                                    }, children: [conflictResolving ? _jsx(RefreshCw, { className: "wf-spin", size: 15 }) : _jsx(CopyPlus, { size: 15 }), conflictResolving ? '正在保存' : '另存为副本'] })] })] }) })), notice && (_jsxs("div", { className: `wf-notice wf-notice--${notice.tone}`, role: "status", children: [notice.tone === 'success' ? _jsx(CheckCircle2, { size: 16 }) : _jsx(CircleAlert, { size: 16 }), _jsx("span", { children: notice.message }), _jsx("button", { onClick: () => setNotice(null), "aria-label": "\u5173\u95ED\u63D0\u793A", children: _jsx(X, { size: 14 }) })] }))] }));
}

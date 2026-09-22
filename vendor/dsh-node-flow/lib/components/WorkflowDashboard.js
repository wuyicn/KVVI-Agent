import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlarmClock, Bot, Braces, CheckCircle2, ChevronRight, CircleOff, Clock3, Copy, FileClock, FolderInput, GitBranch, HardDrive, History, Hourglass, KeyRound, LayoutTemplate, ListFilter, ListTree, Play, Plus, RefreshCw, RotateCcw, Search, ScrollText, Square, Trash2, Workflow, XCircle, } from 'lucide-react';
import { buildBasicIfExample, buildDailySwitchExample, buildLoopExample, buildNewsExample, buildQaIfExample, buildWeatherExample, buildWhileExample, } from '../model.js';
import { createWaitpointCallbackToken, getWorkflowRunDetail, listWorkflowRunSummaries, listWorkflowRuns, replayWorkflowRun, resolveWorkflowApproval } from '../workflowRepository.js';
import { executionDocument, hasUnpublishedChanges } from '../workflowProtocol.js';
import { CredentialsPanel } from './CredentialsPanel.js';
import { ProjectVariablesPanel } from './ProjectVariablesPanel.js';
import { AuditLogPanel } from './AuditLogPanel.js';
import { VersionHistoryPanel } from './VersionHistoryPanel.js';
import { WorkflowRunInputDialog } from './WorkflowRunInputDialog.js';
import { WorkflowFolderNavigator } from './WorkflowFolderNavigator.js';
const NAV_ITEMS = [
    { id: 'workflows', label: '工作流', icon: Workflow },
    { id: 'runs', label: '运行记录', icon: Activity },
    { id: 'schedules', label: '定时任务', icon: AlarmClock },
    { id: 'templates', label: '模板', icon: LayoutTemplate },
    { id: 'credentials', label: '连接', icon: KeyRound },
    { id: 'variables', label: '变量', icon: Braces },
    { id: 'audit', label: '审计日志', icon: ScrollText },
];
const TEMPLATES = [
    { name: 'AI 天气播报', description: '抓取实时天气，由 Agent 生成自然语言播报。', icon: Bot, build: buildWeatherExample },
    { name: '定时新闻摘要', description: '按 Cron 计划收集新闻并生成精简摘要。', icon: FileClock, build: buildNewsExample },
    { name: '基础条件分流', description: '根据输入结果分别执行不同的处理路径。', icon: GitBranch, build: buildBasicIfExample },
    { name: 'AI 问答分流', description: '先让 Agent 分类，再路由到对应输出。', icon: Bot, build: buildQaIfExample },
    { name: '时段 Switch', description: '根据当前时段匹配多个业务分支。', icon: Clock3, build: buildDailySwitchExample },
    { name: '数组循环处理', description: '遍历一组数据并收集每次执行结果。', icon: RefreshCw, build: buildLoopExample },
    { name: '条件循环', description: '条件成立时持续运行流程体。', icon: RefreshCw, build: buildWhileExample },
];
function formatDate(value) {
    if (!value)
        return '从未';
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return value;
    return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatRunValue(value) {
    if (value === undefined || value === null)
        return '无';
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
function SectionHeader({ title, description, children, }) {
    return (_jsxs("header", { className: "wf-page-header", children: [_jsxs("div", { children: [_jsx("h1", { children: title }), _jsx("p", { children: description })] }), children && _jsx("div", { className: "wf-page-header__actions", children: children })] }));
}
export function WorkflowDashboard({ workflows, folders, loading, section, onSectionChange, onCreate, onOpen, onRun, onCancelRun, onResumeRun, onDuplicate, onDelete, onCreateFolder, onRenameFolder, onDeleteFolder, onMoveToFolder, onRestoreVersion, onStatusChange, onUseTemplate, onExit, }) {
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('all');
    const [folderFilter, setFolderFilter] = useState('all');
    const [runs, setRuns] = useState([]);
    const [schedules, setSchedules] = useState([]);
    const [auxLoading, setAuxLoading] = useState(false);
    const [runningId, setRunningId] = useState(null);
    const [statusUpdatingId, setStatusUpdatingId] = useState(null);
    const [rowAction, setRowAction] = useState(null);
    const [creatingTemplate, setCreatingTemplate] = useState(null);
    const [recoveringRunId, setRecoveringRunId] = useState(null);
    const [historyWorkflow, setHistoryWorkflow] = useState(null);
    const [waitDialog, setWaitDialog] = useState(null);
    const [waitNote, setWaitNote] = useState('');
    const [waitBusy, setWaitBusy] = useState(false);
    const [runDetail, setRunDetail] = useState(null);
    const [runDetailLoading, setRunDetailLoading] = useState(null);
    const [runDetailError, setRunDetailError] = useState(null);
    const [replaySource, setReplaySource] = useState(null);
    const [replayingRunId, setReplayingRunId] = useState(null);
    const [replayError, setReplayError] = useState(null);
    const [runInputWorkflow, setRunInputWorkflow] = useState(null);
    const [moveWorkflow, setMoveWorkflow] = useState(null);
    const [moveFolderId, setMoveFolderId] = useState('');
    const [moveError, setMoveError] = useState('');
    const replayControllerRef = useRef(null);
    const runningRef = useRef(null);
    const activeRunRef = useRef(null);
    const statusUpdatingRef = useRef(null);
    const rowActionRef = useRef(null);
    const creatingTemplateRef = useRef(null);
    const recoveringRunRef = useRef(null);
    const activeRecoveryRef = useRef(null);
    const foldersById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
    const filtered = useMemo(() => workflows.filter((workflow) => {
        const folder = workflow.folderId ? foldersById.get(workflow.folderId) : undefined;
        const matchesQuery = !query.trim() || `${workflow.name} ${workflow.description ?? ''} ${folder?.name ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
        const matchesFolder = folderFilter === 'all'
            || (folderFilter === 'uncategorized' ? !folder : workflow.folderId === folderFilter);
        return matchesQuery && matchesFolder && (status === 'all' || workflow.status === status);
    }), [folderFilter, foldersById, query, status, workflows]);
    const beginDashboardRun = async (workflow, input) => {
        if (runningRef.current)
            throw new Error('已有工作流正在运行');
        const runId = `dashboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const controller = new AbortController();
        runningRef.current = workflow.id;
        activeRunRef.current = { workflowId: workflow.id, runId, controller };
        setRunningId(workflow.id);
        try {
            await onRun(workflow, runId, controller.signal, input);
        }
        finally {
            runningRef.current = null;
            activeRunRef.current = null;
            setRunningId(null);
        }
    };
    const requestDashboardRun = async (workflow) => {
        if (runningRef.current === workflow.id && activeRunRef.current) {
            activeRunRef.current.controller.abort(new Error('运行已取消'));
            await onCancelRun(activeRunRef.current.runId).catch(() => undefined);
            return;
        }
        if (runningRef.current)
            return;
        if (executionDocument(workflow).inputs?.length) {
            setRunInputWorkflow(workflow);
            return;
        }
        try {
            await beginDashboardRun(workflow);
        }
        catch {
            // The application-level callback already displays a concise failure notice.
        }
    };
    useEffect(() => {
        if (section !== 'runs' && section !== 'schedules')
            return;
        let cancelled = false;
        setAuxLoading(true);
        const request = section === 'runs'
            ? listWorkflowRunSummaries().then((items) => ({ runs: items }))
            : fetch('/dsh-node-flow/schedules', { cache: 'no-store' }).then((response) => response.json());
        void request
            .then((data) => {
            if (cancelled)
                return;
            if (section === 'runs')
                setRuns(Array.isArray(data.runs) ? data.runs : []);
            else
                setSchedules(Array.isArray(data.schedules) ? data.schedules : []);
        })
            .catch(() => {
            if (!cancelled) {
                if (section === 'runs')
                    setRuns([]);
                else
                    setSchedules([]);
            }
        })
            .finally(() => {
            if (!cancelled)
                setAuxLoading(false);
        });
        return () => { cancelled = true; };
    }, [section]);
    return (_jsxs("div", { className: "wf-app-shell", children: [_jsxs("aside", { className: "wf-app-sidebar", children: [_jsxs("div", { className: "wf-app-brand", children: [_jsx("span", { children: _jsx(Workflow, { size: 19 }) }), _jsxs("div", { children: [_jsx("strong", { children: "DSH Flow" }), _jsx("small", { children: "Automation" })] })] }), _jsxs("div", { className: "wf-workspace-context", "aria-label": "\u5F53\u524D\u7A7A\u95F4\uFF1A\u672C\u5730\u5DE5\u4F5C\u533A", title: "\u5F53\u524D\u7248\u672C\u7684\u5DE5\u4F5C\u6D41\u7EDF\u4E00\u4FDD\u5B58\u5728\u672C\u673A DSH \u6570\u636E\u76EE\u5F55", children: [_jsx("span", { children: _jsx(HardDrive, { size: 15 }) }), _jsxs("div", { children: [_jsx("small", { children: "\u5F53\u524D\u7A7A\u95F4" }), _jsx("strong", { children: "\u672C\u5730\u5DE5\u4F5C\u533A" })] })] }), _jsx("nav", { "aria-label": "\u6D41\u7A0B\u5E94\u7528\u5BFC\u822A", children: NAV_ITEMS.map((item) => {
                            const Icon = item.icon;
                            return (_jsxs("button", { className: section === item.id ? 'is-active' : '', onClick: () => onSectionChange(item.id), "aria-label": item.label, title: item.label, children: [_jsx(Icon, { size: 17 }), _jsx("span", { children: item.label }), item.id === 'workflows' && workflows.length > 0 && _jsx("small", { children: workflows.length })] }, item.id));
                        }) }), _jsx("div", { className: "wf-app-sidebar__footer", children: _jsxs("button", { onClick: onExit, "aria-label": "\u9000\u51FA\u8282\u70B9\u6A21\u5F0F", title: "\u9000\u51FA\u8282\u70B9\u6A21\u5F0F", children: [_jsx(XCircle, { size: 17 }), _jsx("span", { children: "\u9000\u51FA\u8282\u70B9\u6A21\u5F0F" })] }) })] }), _jsxs("main", { className: "wf-dashboard", children: [section === 'workflows' && (_jsxs(_Fragment, { children: [_jsx(SectionHeader, { title: "\u5DE5\u4F5C\u6D41", description: "\u521B\u5EFA\u3001\u7BA1\u7406\u5E76\u8FD0\u884C\u4F60\u7684\u81EA\u52A8\u5316\u6D41\u7A0B\u3002", children: _jsxs("button", { className: "wf-primary-command", onClick: () => onCreate(folderFilter === 'all' || folderFilter === 'uncategorized' ? undefined : folderFilter), children: [_jsx(Plus, { size: 16 }), "\u65B0\u5EFA\u5DE5\u4F5C\u6D41"] }) }), _jsxs("div", { className: "wf-workflow-library", children: [_jsx(WorkflowFolderNavigator, { folders: folders, workflows: workflows, selected: folderFilter, onSelect: setFolderFilter, onCreateWorkflow: onCreate, onCreateFolder: onCreateFolder, onRenameFolder: onRenameFolder, onDeleteFolder: onDeleteFolder }), _jsxs("div", { className: "wf-workflow-library__content", children: [_jsxs("div", { className: "wf-list-toolbar", children: [_jsxs("label", { className: "wf-dashboard-search", children: [_jsx(Search, { size: 16 }), _jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "\u641C\u7D22\u5DE5\u4F5C\u6D41" })] }), _jsxs("div", { className: "wf-segmented", role: "group", "aria-label": "\u72B6\u6001\u7B5B\u9009", children: [_jsx("button", { className: status === 'all' ? 'is-active' : '', onClick: () => setStatus('all'), children: "\u5168\u90E8" }), _jsx("button", { className: status === 'enabled' ? 'is-active' : '', onClick: () => setStatus('enabled'), children: "\u5DF2\u542F\u7528" }), _jsx("button", { className: status === 'disabled' ? 'is-active' : '', onClick: () => setStatus('disabled'), children: "\u8349\u7A3F" })] }), _jsxs("span", { className: "wf-list-count", children: [_jsx(ListFilter, { size: 14 }), filtered.length, " \u4E2A\u6D41\u7A0B"] })] }), _jsxs("div", { className: "wf-workflow-table", children: [_jsxs("div", { className: "wf-workflow-table__head", children: [_jsx("span", { children: "\u540D\u79F0" }), _jsx("span", { children: "\u72B6\u6001" }), _jsx("span", { children: "\u8282\u70B9" }), _jsx("span", { children: "\u6700\u540E\u66F4\u65B0" }), _jsx("span", { children: "\u6700\u8FD1\u8FD0\u884C" }), _jsx("span", {})] }), loading && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(RefreshCw, { className: "wf-spin", size: 22 }), _jsx("strong", { children: "\u6B63\u5728\u52A0\u8F7D\u5DE5\u4F5C\u6D41" })] }), !loading && filtered.length === 0 && (_jsxs("div", { className: "wf-dashboard-empty", children: [_jsx("span", { children: _jsx(Workflow, { size: 24 }) }), _jsx("strong", { children: workflows.length === 0 ? '还没有工作流' : '没有匹配的工作流' }), _jsx("p", { children: workflows.length === 0 ? '创建第一个流程，或者从模板开始。' : '调整搜索词或状态筛选后再试。' }), workflows.length === 0 && _jsxs("button", { className: "wf-primary-command", onClick: () => onCreate(), children: [_jsx(Plus, { size: 16 }), "\u65B0\u5EFA\u5DE5\u4F5C\u6D41"] })] })), !loading && filtered.map((workflow) => {
                                                        const rowBusy = runningId === workflow.id || statusUpdatingId === workflow.id || rowAction?.id === workflow.id;
                                                        const unpublished = hasUnpublishedChanges(workflow);
                                                        return (_jsxs("div", { className: "wf-workflow-row", "aria-busy": rowBusy, children: [_jsxs("button", { className: "wf-workflow-name", onClick: () => onOpen(workflow), disabled: rowBusy, children: [_jsx("span", { children: _jsx(Workflow, { size: 17 }) }), _jsxs("span", { children: [_jsx("strong", { children: workflow.name }), _jsxs("small", { children: [workflow.description || 'DSH 自动化工作流', workflow.folderId && foldersById.get(workflow.folderId) ? ` · ${foldersById.get(workflow.folderId).name}` : ''] })] })] }), _jsxs("div", { className: "wf-row-status", children: [_jsx("button", { onClick: () => setHistoryWorkflow(workflow), disabled: rowAction !== null || statusUpdatingId === workflow.id || runningId === workflow.id, title: "\u7248\u672C\u5386\u53F2", "aria-label": `查看 ${workflow.name} 的版本历史`, children: _jsx(History, { size: 15 }) }), _jsxs("button", { className: `wf-status-toggle ${workflow.status === 'enabled' ? 'is-enabled' : ''}${unpublished ? ' is-stale' : ''}`, onClick: async () => {
                                                                                if (statusUpdatingRef.current)
                                                                                    return;
                                                                                statusUpdatingRef.current = workflow.id;
                                                                                setStatusUpdatingId(workflow.id);
                                                                                try {
                                                                                    await onStatusChange(workflow, workflow.status === 'enabled' && !unpublished ? 'disabled' : 'enabled');
                                                                                }
                                                                                finally {
                                                                                    statusUpdatingRef.current = null;
                                                                                    setStatusUpdatingId(null);
                                                                                }
                                                                            }, disabled: statusUpdatingId !== null || runningId === workflow.id || rowAction?.id === workflow.id, role: unpublished ? undefined : 'switch', "aria-checked": unpublished ? undefined : workflow.status === 'enabled', "aria-label": unpublished ? `发布 ${workflow.name} 的更新` : workflow.status === 'enabled' ? `停用 ${workflow.name}` : `发布 ${workflow.name}`, children: [_jsx("span", {}), statusUpdatingId === workflow.id ? '更新中' : unpublished ? '待发布' : workflow.status === 'enabled' ? '已启用' : '草稿'] })] }), _jsxs("div", { className: "wf-workflow-meta", children: [_jsx("span", { className: "wf-table-muted", "data-label": "\u8282\u70B9", children: workflow.doc.nodes.length }), _jsx("span", { className: "wf-table-muted", "data-label": "\u6700\u540E\u66F4\u65B0", children: formatDate(workflow.updatedAt) }), _jsx("span", { className: "wf-table-muted", "data-label": "\u6700\u8FD1\u8FD0\u884C", children: formatDate(workflow.lastRunAt) })] }), _jsxs("div", { className: "wf-row-actions", children: [_jsx("button", { onClick: () => { void requestDashboardRun(workflow); }, disabled: (runningId !== null && runningId !== workflow.id) || statusUpdatingId === workflow.id || rowAction?.id === workflow.id, title: runningId === workflow.id ? '停止' : '运行', "aria-label": `${runningId === workflow.id ? '停止' : '运行'} ${workflow.name}`, children: runningId === workflow.id ? _jsx(Square, { size: 14, fill: "currentColor" }) : _jsx(Play, { size: 15, fill: "currentColor" }) }), _jsx("button", { onClick: () => {
                                                                                setMoveWorkflow(workflow);
                                                                                setMoveFolderId(workflow.folderId ?? '');
                                                                                setMoveError('');
                                                                            }, disabled: rowAction !== null || statusUpdatingId === workflow.id || runningId === workflow.id, title: "\u79FB\u52A8\u5230\u6587\u4EF6\u5939", "aria-label": `移动 ${workflow.name} 到文件夹`, children: _jsx(FolderInput, { size: 15 }) }), _jsx("button", { onClick: async () => {
                                                                                if (rowActionRef.current)
                                                                                    return;
                                                                                rowActionRef.current = workflow.id;
                                                                                setRowAction({ id: workflow.id, kind: 'duplicate' });
                                                                                try {
                                                                                    await onDuplicate(workflow);
                                                                                }
                                                                                finally {
                                                                                    rowActionRef.current = null;
                                                                                    setRowAction(null);
                                                                                }
                                                                            }, disabled: rowAction !== null || statusUpdatingId === workflow.id || runningId === workflow.id, title: "\u590D\u5236", "aria-label": `复制 ${workflow.name}`, children: rowAction?.id === workflow.id && rowAction.kind === 'duplicate' ? _jsx(RefreshCw, { className: "wf-spin", size: 15 }) : _jsx(Copy, { size: 15 }) }), _jsx("button", { onClick: async () => {
                                                                                if (rowActionRef.current)
                                                                                    return;
                                                                                rowActionRef.current = workflow.id;
                                                                                setRowAction({ id: workflow.id, kind: 'delete' });
                                                                                try {
                                                                                    await onDelete(workflow);
                                                                                }
                                                                                finally {
                                                                                    rowActionRef.current = null;
                                                                                    setRowAction(null);
                                                                                }
                                                                            }, disabled: rowAction !== null || statusUpdatingId === workflow.id || runningId === workflow.id, title: "\u5220\u9664", "aria-label": `删除 ${workflow.name}`, children: rowAction?.id === workflow.id && rowAction.kind === 'delete' ? _jsx(RefreshCw, { className: "wf-spin", size: 15 }) : _jsx(Trash2, { size: 15 }) }), _jsx("button", { onClick: () => onOpen(workflow), disabled: rowBusy, title: "\u6253\u5F00", "aria-label": `打开 ${workflow.name}`, children: _jsx(ChevronRight, { size: 16 }) })] })] }, workflow.id));
                                                    })] })] })] })] })), section === 'runs' && (_jsxs(_Fragment, { children: [_jsx(SectionHeader, { title: "\u8FD0\u884C\u8BB0\u5F55", description: "\u67E5\u770B\u624B\u52A8\u8FD0\u884C\u4E0E\u5B9A\u65F6\u8FD0\u884C\u7684\u6267\u884C\u7ED3\u679C\u3002" }), _jsxs("div", { className: "wf-simple-table wf-simple-table--runs", children: [_jsxs("div", { className: "wf-simple-table__head", children: [_jsx("span", { children: "\u5DE5\u4F5C\u6D41" }), _jsx("span", { children: "\u72B6\u6001" }), _jsx("span", { children: "\u5F00\u59CB\u65F6\u95F4" }), _jsx("span", { children: "\u8282\u70B9\u6570" }), _jsx("span", { children: "\u5931\u8D25\u8282\u70B9" }), _jsx("span", { children: "\u64CD\u4F5C" })] }), auxLoading && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(RefreshCw, { className: "wf-spin", size: 22 }), _jsx("strong", { children: "\u6B63\u5728\u52A0\u8F7D\u8FD0\u884C\u8BB0\u5F55" })] }), !auxLoading && runs.length === 0 && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(Activity, { size: 25 }), _jsx("strong", { children: "\u6682\u65E0\u8FD0\u884C\u8BB0\u5F55" }), _jsx("p", { children: "\u8FD0\u884C\u5DE5\u4F5C\u6D41\u540E\uFF0C\u7ED3\u679C\u4F1A\u663E\u793A\u5728\u8FD9\u91CC\u3002" })] }), runs.map((run) => {
                                        const running = run.status === 'running';
                                        const queued = run.status === 'queued';
                                        const continued = run.status === 'waiting' && Boolean(run.resumedByRunId);
                                        const waiting = run.status === 'waiting' && !continued;
                                        const interrupted = run.status === 'interrupted';
                                        const cancelled = run.status === 'cancelled';
                                        const skipped = run.status === 'skipped';
                                        const handled = run.status === 'handled';
                                        const limited = run.timedOut === true;
                                        const statusLabel = limited ? '已超限' : run.status === 'ok' ? '成功' : handled ? '错误已处理' : queued ? '排队中' : running ? '运行中' : waiting ? '等待中' : continued ? '已继续' : interrupted ? '已中断' : cancelled ? '已取消' : skipped ? '已跳过' : '失败';
                                        const limitDetail = limited ? run.limitReason === 'steps' ? '超过最大执行步数' : '超过最长运行时间' : undefined;
                                        const StatusIcon = limited ? Clock3 : run.status === 'ok' || handled || continued ? CheckCircle2 : queued ? Clock3 : running ? RefreshCw : waiting ? Hourglass : interrupted ? XCircle : CircleOff;
                                        const waitDetail = waiting && run.waitpoint
                                            ? run.waitpoint.mode === 'delay'
                                                ? `延迟至 ${formatDate(run.waitpoint.resumeAt)}`
                                                : run.waitpoint.mode === 'callback'
                                                    ? `等待外部回调${run.waitpoint.expiresAt ? ` · 截止 ${formatDate(run.waitpoint.expiresAt)}` : ''}`
                                                    : run.waitpoint.mode === 'approval'
                                                        ? `等待人工审批${run.waitpoint.expiresAt ? ` · 截止 ${formatDate(run.waitpoint.expiresAt)}` : ''}`
                                                        : run.waitpoint.mode === 'debug'
                                                            ? `断点暂停${run.waitpoint.debugReason ? ` · ${run.waitpoint.debugReason}` : ''}`
                                                            : `等待子工作流${run.waitpoint.childRunId ? ` · ${run.waitpoint.childRunId}` : ''}`
                                            : undefined;
                                        return _jsxs("div", { className: "wf-simple-row", children: [_jsxs("strong", { children: [run.name, limitDetail ? _jsx("small", { children: limitDetail }) : waitDetail ? _jsx("small", { children: waitDetail }) : queued ? _jsxs("small", { children: ["\u7B49\u5F85\u5E76\u53D1\u69FD\u4F4D", run.queuedAt ? ` · 自 ${formatDate(run.queuedAt)} 起` : ''] }) : skipped ? _jsx("small", { children: run.skipReason || '当前并发策略已跳过本次触发' }) : run.parentRunId ? _jsxs("small", { children: ["\u5B50\u5DE5\u4F5C\u6D41 \u00B7 \u6DF1\u5EA6 ", run.depth ?? 1] }) : run.resumedFromRunId && _jsx("small", { children: "\u6062\u590D\u8FD0\u884C" })] }), _jsxs("span", { "data-label": "\u72B6\u6001", className: `wf-run-badge is-${run.status}`, children: [_jsx(StatusIcon, { className: running ? 'wf-spin' : undefined, size: 13 }), statusLabel] }), _jsx("span", { "data-label": "\u5F00\u59CB\u65F6\u95F4", children: formatDate(run.startedAt) }), _jsx("span", { "data-label": "\u8282\u70B9\u6570", children: run.nodeCount }), _jsxs("span", { "data-label": "\u5931\u8D25\u8282\u70B9", children: [run.failed, run.handledErrors ? ` · ${run.handledErrors} 已处理` : ''] }), _jsxs("span", { "data-label": "\u64CD\u4F5C", className: "wf-run-actions", children: [_jsxs("button", { type: "button", title: "\u67E5\u770B\u8FD0\u884C\u8BE6\u60C5", "aria-label": `查看 ${run.name} 的运行详情`, disabled: runDetailLoading === run.id, onClick: async () => {
                                                                setRunDetailLoading(run.id);
                                                                setRunDetailError(null);
                                                                try {
                                                                    setRunDetail(await getWorkflowRunDetail(run.id));
                                                                }
                                                                catch (error) {
                                                                    setRunDetailError(error instanceof Error ? error.message : String(error));
                                                                }
                                                                finally {
                                                                    setRunDetailLoading(null);
                                                                }
                                                            }, children: [runDetailLoading === run.id ? _jsx(RefreshCw, { className: "wf-spin", size: 12 }) : _jsx(ListTree, { size: 13 }), "\u8BE6\u60C5"] }), queued ? _jsxs("button", { type: "button", onClick: async () => { await onCancelRun(run.id).catch(() => undefined); setRuns(await listWorkflowRunSummaries()); }, children: [_jsx(Square, { size: 12 }), "\u53D6\u6D88\u6392\u961F"] }) : waiting ? _jsxs(_Fragment, { children: [run.waitpoint?.mode === 'callback' && _jsxs("button", { type: "button", disabled: waitBusy, onClick: async () => {
                                                                        setWaitBusy(true);
                                                                        setWaitDialog({ run: run, mode: 'callback' });
                                                                        try {
                                                                            const result = await createWaitpointCallbackToken(run.id);
                                                                            setWaitDialog({ run: run, mode: 'callback', callbackUrl: `${window.location.origin}${result.callbackUrl}`, token: result.token });
                                                                        }
                                                                        catch (error) {
                                                                            setWaitDialog({ run: run, mode: 'callback', error: error instanceof Error ? error.message : String(error) });
                                                                        }
                                                                        finally {
                                                                            setWaitBusy(false);
                                                                        }
                                                                    }, children: [_jsx(KeyRound, { size: 12 }), "\u56DE\u8C03\u51ED\u8BC1"] }), run.waitpoint?.mode === 'approval' && _jsxs("button", { type: "button", onClick: () => { setWaitNote(''); setWaitDialog({ run: run, mode: 'approval' }); }, children: [_jsx(CheckCircle2, { size: 12 }), "\u5904\u7406\u5BA1\u6279"] }), _jsxs("button", { type: "button", onClick: async () => { await onCancelRun(run.id).catch(() => undefined); setRuns(await listWorkflowRunSummaries()); }, children: [_jsx(Square, { size: 12 }), "\u53D6\u6D88"] })] }) : running ? _jsxs("button", { type: "button", onClick: async () => {
                                                                await onCancelRun(run.id).catch(() => undefined);
                                                                setRuns(await listWorkflowRunSummaries());
                                                            }, children: [_jsx(Square, { size: 12, fill: "currentColor" }), "\u505C\u6B62\u8FD0\u884C"] }) : run.resumable && !run.resumedByRunId ? _jsxs("button", { type: "button", disabled: recoveringRunId !== null && recoveringRunId !== run.id, onClick: async () => {
                                                                if (activeRecoveryRef.current?.sourceId === run.id) {
                                                                    activeRecoveryRef.current.controller.abort(new Error('恢复运行已取消'));
                                                                    await onCancelRun(activeRecoveryRef.current.runId).catch(() => undefined);
                                                                    return;
                                                                }
                                                                if (recoveringRunRef.current)
                                                                    return;
                                                                recoveringRunRef.current = run.id;
                                                                setRecoveringRunId(run.id);
                                                                const runId = `resume-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                                                                const controller = new AbortController();
                                                                activeRecoveryRef.current = { sourceId: run.id, runId, controller };
                                                                try {
                                                                    await onResumeRun(run, runId, controller.signal);
                                                                }
                                                                catch {
                                                                    /* Parent surface already reports the recovery error. */
                                                                }
                                                                finally {
                                                                    setRuns(await listWorkflowRunSummaries());
                                                                    activeRecoveryRef.current = null;
                                                                    recoveringRunRef.current = null;
                                                                    setRecoveringRunId(null);
                                                                }
                                                            }, children: [recoveringRunId === run.id ? _jsx(Square, { size: 12, fill: "currentColor" }) : _jsx(RotateCcw, { size: 13 }), recoveringRunId === run.id ? '停止恢复' : '从失败处恢复'] }) : run.replayable ? _jsxs("button", { type: "button", onClick: () => { setReplayError(null); setReplaySource(run); }, children: [_jsx(RotateCcw, { size: 13 }), "\u91CD\u653E"] }) : run.resumedByRunId ? _jsx("span", { children: "\u5DF2\u6062\u590D" }) : _jsx("span", { children: "\u2014" })] })] }, run.id);
                                    })] })] })), section === 'schedules' && (_jsxs(_Fragment, { children: [_jsx(SectionHeader, { title: "\u5B9A\u65F6\u4EFB\u52A1", description: "\u96C6\u4E2D\u67E5\u770B\u5DE5\u4F5C\u6D41\u4E2D\u7684 Cron \u8C03\u5EA6\u3001\u65F6\u533A\u4E0E\u4E0B\u4E00\u6B21\u89E6\u53D1\u3002" }), _jsxs("div", { className: "wf-simple-table wf-simple-table--schedules", children: [_jsxs("div", { className: "wf-simple-table__head", children: [_jsx("span", { children: "\u4EFB\u52A1" }), _jsx("span", { children: "Cron" }), _jsx("span", { children: "\u65F6\u533A" }), _jsx("span", { children: "\u4E0B\u6B21\u89E6\u53D1" }), _jsx("span", { children: "\u4E0A\u6B21\u89E6\u53D1" }), _jsx("span", { children: "\u5DE5\u4F5C\u6D41\u5FEB\u7167" })] }), auxLoading && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(RefreshCw, { className: "wf-spin", size: 22 }), _jsx("strong", { children: "\u6B63\u5728\u52A0\u8F7D\u5B9A\u65F6\u4EFB\u52A1" })] }), !auxLoading && schedules.length === 0 && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(AlarmClock, { size: 25 }), _jsx("strong", { children: "\u6682\u65E0\u5B9A\u65F6\u4EFB\u52A1" }), _jsx("p", { children: "\u5728\u7F16\u8F91\u5668\u4E2D\u6DFB\u52A0 Schedule \u8282\u70B9\u5E76\u4FDD\u5B58\u8BA1\u5212\u3002" })] }), schedules.map((schedule) => _jsxs("div", { className: "wf-simple-row", children: [_jsxs("strong", { children: [schedule.name, schedule.configurationError && _jsx("small", { children: schedule.configurationError })] }), _jsx("code", { "data-label": "Cron", children: schedule.cron }), _jsx("span", { "data-label": "\u65F6\u533A", children: schedule.timezoneLabel ?? schedule.timezone ?? '系统时区' }), _jsx("span", { "data-label": "\u4E0B\u6B21\u89E6\u53D1", children: schedule.nextFire || '—' }), _jsx("span", { "data-label": "\u4E0A\u6B21\u89E6\u53D1", children: schedule.lastFired || '从未' }), _jsx("span", { "data-label": "\u5DE5\u4F5C\u6D41\u5FEB\u7167", children: schedule.doc ? `${schedule.doc.nodes.length} 个节点` : '无快照' })] }, schedule.id))] })] })), section === 'templates' && (_jsxs(_Fragment, { children: [_jsx(SectionHeader, { title: "\u6A21\u677F", description: "\u4ECE\u7ECF\u8FC7\u9A8C\u8BC1\u7684 DSH \u5DE5\u4F5C\u6D41\u7ED3\u6784\u5F00\u59CB\u3002" }), _jsx("div", { className: "wf-template-list", children: TEMPLATES.map((template) => {
                                    const Icon = template.icon;
                                    return (_jsxs("article", { children: [_jsx("span", { children: _jsx(Icon, { size: 20 }) }), _jsxs("div", { children: [_jsx("strong", { children: template.name }), _jsx("p", { children: template.description })] }), _jsx("button", { disabled: creatingTemplate !== null, onClick: async () => {
                                                    if (creatingTemplateRef.current)
                                                        return;
                                                    creatingTemplateRef.current = template.name;
                                                    setCreatingTemplate(template.name);
                                                    try {
                                                        await onUseTemplate(template.name, template.build(), folderFilter === 'all' || folderFilter === 'uncategorized' ? undefined : folderFilter);
                                                    }
                                                    finally {
                                                        creatingTemplateRef.current = null;
                                                        setCreatingTemplate(null);
                                                    }
                                                }, children: creatingTemplate === template.name ? '正在创建' : '使用模板' })] }, template.name));
                                }) })] })), section === 'credentials' && _jsx(CredentialsPanel, {}), section === 'variables' && _jsx(ProjectVariablesPanel, {}), section === 'audit' && _jsx(AuditLogPanel, {})] }), historyWorkflow && (_jsx(VersionHistoryPanel, { workflow: historyWorkflow, onClose: () => setHistoryWorkflow(null), onRestore: async (workflow, version, publish) => {
                    const saved = await onRestoreVersion(workflow, version, publish);
                    setHistoryWorkflow(saved);
                    return saved;
                } })), moveWorkflow && _jsx("div", { className: "wf-dialog-backdrop", role: "presentation", onMouseDown: (event) => {
                    if (rowAction !== null || event.target !== event.currentTarget)
                        return;
                    setMoveWorkflow(null);
                }, children: _jsxs("section", { className: "wf-credential-dialog wf-folder-dialog", role: "dialog", "aria-modal": "true", "aria-label": "\u79FB\u52A8\u5DE5\u4F5C\u6D41", children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(FolderInput, { size: 17 }), _jsx("strong", { children: "\u79FB\u52A8\u5DE5\u4F5C\u6D41" })] }), _jsx("button", { className: "wf-icon-button", disabled: rowAction !== null, onClick: () => setMoveWorkflow(null), "aria-label": "\u5173\u95ED", children: _jsx(XCircle, { size: 17 }) })] }), _jsxs("div", { className: "wf-credential-dialog__body", children: [_jsx("strong", { children: moveWorkflow.name }), _jsx("p", { children: "\u79FB\u52A8\u53EA\u66F4\u65B0\u7EC4\u7EC7\u5F52\u5C5E\uFF0C\u4E0D\u4F1A\u4FEE\u6539\u8349\u7A3F\u3001\u53D1\u5E03\u7248\u672C\u6216\u6267\u884C\u5FEB\u7167\u3002" }), _jsxs("label", { children: [_jsx("span", { children: "\u6587\u4EF6\u5939" }), _jsxs("select", { "aria-label": "\u79FB\u52A8\u5DE5\u4F5C\u6D41\u7684\u76EE\u6807\u6587\u4EF6\u5939", value: moveFolderId, onChange: (event) => setMoveFolderId(event.target.value), children: [_jsx("option", { value: "", children: "\u672A\u5206\u7C7B" }), folders.map((folder) => _jsx("option", { value: folder.id, children: folder.name }, folder.id))] })] }), moveError && _jsx("p", { className: "wf-wait-dialog__error", role: "alert", children: moveError })] }), _jsxs("footer", { children: [_jsx("button", { type: "button", disabled: rowAction !== null, onClick: () => setMoveWorkflow(null), children: "\u53D6\u6D88" }), _jsxs("button", { type: "button", className: "wf-primary-command", disabled: rowAction !== null || moveFolderId === (moveWorkflow.folderId ?? ''), onClick: async () => {
                                        if (rowActionRef.current)
                                            return;
                                        rowActionRef.current = moveWorkflow.id;
                                        setRowAction({ id: moveWorkflow.id, kind: 'move' });
                                        setMoveError('');
                                        try {
                                            await onMoveToFolder(moveWorkflow, moveFolderId || undefined);
                                            setMoveWorkflow(null);
                                        }
                                        catch (error) {
                                            setMoveError(error instanceof Error ? error.message : String(error));
                                        }
                                        finally {
                                            rowActionRef.current = null;
                                            setRowAction(null);
                                        }
                                    }, children: [rowAction?.id === moveWorkflow.id && rowAction.kind === 'move' ? _jsx(RefreshCw, { className: "wf-spin", size: 14 }) : _jsx(FolderInput, { size: 14 }), rowAction?.id === moveWorkflow.id && rowAction.kind === 'move' ? '正在移动' : '确认移动'] })] })] }) }), runDetailError && _jsx("div", { className: "wf-dialog-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-credential-dialog wf-run-detail-dialog", role: "dialog", "aria-modal": "true", "aria-label": "\u8FD0\u884C\u8BE6\u60C5\u9519\u8BEF", children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(CircleOff, { size: 17 }), _jsx("strong", { children: "\u65E0\u6CD5\u52A0\u8F7D\u8FD0\u884C\u8BE6\u60C5" })] }), _jsx("button", { className: "wf-icon-button", onClick: () => setRunDetailError(null), "aria-label": "\u5173\u95ED", children: _jsx(XCircle, { size: 17 }) })] }), _jsx("div", { className: "wf-credential-dialog__body", children: _jsx("p", { className: "wf-wait-dialog__error", children: runDetailError }) }), _jsx("footer", { children: _jsx("button", { type: "button", onClick: () => setRunDetailError(null), children: "\u5173\u95ED" }) })] }) }), runDetail && _jsx("div", { className: "wf-dialog-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-credential-dialog wf-run-detail-dialog", role: "dialog", "aria-modal": "true", "aria-label": "\u8FD0\u884C\u8BE6\u60C5", children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(ListTree, { size: 17 }), _jsx("strong", { children: "\u8FD0\u884C\u8BE6\u60C5" })] }), _jsx("button", { className: "wf-icon-button", onClick: () => setRunDetail(null), "aria-label": "\u5173\u95ED", children: _jsx(XCircle, { size: 17 }) })] }), _jsxs("div", { className: "wf-credential-dialog__body wf-run-detail-dialog__body", children: [_jsxs("div", { className: "wf-run-detail-summary", children: [_jsx("strong", { children: runDetail.name }), _jsxs("span", { children: [formatDate(runDetail.startedAt), " \u00B7 ", runDetail.timedOut ? runDetail.limitReason === 'steps' ? '超过执行步数' : '超过运行时限' : runDetail.status === 'ok' ? '成功' : runDetail.status === 'handled' ? '错误已处理' : runDetail.status] }), _jsxs("span", { children: [runDetail.nodeCount, " \u4E2A\u8282\u70B9 \u00B7 ", runDetail.failed, " \u4E2A\u5931\u8D25", runDetail.handledErrors ? ` · ${runDetail.handledErrors} 个已处理` : ''] }), runDetail.replayedFromRunId && _jsxs("span", { children: ["\u91CD\u653E\u81EA ", runDetail.replayedFromRunId] })] }), _jsx("div", { className: "wf-run-detail-nodes", children: runDetail.nodes.map((node, index) => _jsxs("article", { className: `is-${node.status}`, children: [_jsxs("header", { children: [_jsxs("strong", { children: [index + 1, ". ", node.kind] }), _jsxs("span", { children: [node.status === 'ok' ? '成功' : node.status === 'error' ? node.errorHandled ? '错误已路由' : '失败' : node.status, " \u00B7 ", node.ms, " ms", node.attempts && node.attempts > 1 ? ` · ${node.attempts} 次` : ''] })] }), node.input !== undefined && _jsxs("label", { children: [_jsx("span", { children: "\u8F93\u5165" }), _jsx("pre", { children: formatRunValue(node.input) })] }), (node.output !== undefined || node.error) && _jsxs("label", { children: [_jsx("span", { children: node.error ? '错误' : '输出' }), _jsx("pre", { className: node.error ? 'is-error' : undefined, children: node.error || formatRunValue(node.output) })] }), node.logs && node.logs.length > 0 && _jsxs("label", { children: [_jsx("span", { children: "\u65E5\u5FD7" }), _jsx("pre", { children: node.logs.join('\n') })] })] }, `${node.id}-${index}`)) })] }), _jsx("footer", { children: _jsx("button", { type: "button", onClick: () => setRunDetail(null), children: "\u5173\u95ED" }) })] }) }), runInputWorkflow && _jsx(WorkflowRunInputDialog, { workflowName: runInputWorkflow.name, fields: executionDocument(runInputWorkflow).inputs ?? [], published: runInputWorkflow.status === 'enabled', onClose: () => setRunInputWorkflow(null), onSubmit: async (input) => { await beginDashboardRun(runInputWorkflow, input); } }), replaySource && _jsx("div", { className: "wf-dialog-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-credential-dialog wf-replay-dialog", role: "dialog", "aria-modal": "true", "aria-label": "\u786E\u8BA4\u91CD\u653E\u8FD0\u884C", children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(RotateCcw, { size: 17 }), _jsx("strong", { children: "\u786E\u8BA4\u91CD\u653E\u8FD0\u884C" })] }), _jsx("button", { className: "wf-icon-button", disabled: replayingRunId !== null, onClick: () => setReplaySource(null), "aria-label": "\u5173\u95ED", children: _jsx(XCircle, { size: 17 }) })] }), _jsxs("div", { className: "wf-credential-dialog__body", children: [_jsx("strong", { children: replaySource.name }), _jsx("p", { children: "\u5C06\u4F7F\u7528\u8FD9\u6B21\u8FD0\u884C\u4FDD\u5B58\u7684\u4E0D\u53EF\u53D8\u5DE5\u4F5C\u6D41\u5FEB\u7167\u548C\u539F\u59CB\u5B89\u5168\u8F93\u5165\uFF0C\u91CD\u65B0\u6267\u884C\u5168\u90E8\u6B65\u9AA4\u3002\u4EFB\u4F55\u5199\u5165\u5916\u90E8\u7CFB\u7EDF\u7684\u8282\u70B9\u90FD\u4F1A\u518D\u6B21\u6267\u884C\u3002" }), replayError && _jsx("p", { className: "wf-wait-dialog__error", children: replayError })] }), _jsxs("footer", { children: [_jsx("button", { type: "button", disabled: replayingRunId !== null, onClick: () => setReplaySource(null), children: "\u53D6\u6D88" }), _jsxs("button", { type: "button", className: "wf-primary-command", disabled: replayingRunId !== null, onClick: async () => {
                                        if (replayControllerRef.current)
                                            return;
                                        const runId = `replay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                                        const controller = new AbortController();
                                        replayControllerRef.current = { sourceId: replaySource.id, runId, controller };
                                        setReplayingRunId(replaySource.id);
                                        setReplayError(null);
                                        try {
                                            await replayWorkflowRun(replaySource, runId, controller.signal);
                                            setRuns(await listWorkflowRunSummaries());
                                            setReplaySource(null);
                                        }
                                        catch (error) {
                                            if (controller.signal.aborted)
                                                setReplaySource(null);
                                            else
                                                setReplayError(error instanceof Error ? error.message : String(error));
                                        }
                                        finally {
                                            replayControllerRef.current = null;
                                            setReplayingRunId(null);
                                        }
                                    }, children: [replayingRunId === replaySource.id ? _jsx(RefreshCw, { className: "wf-spin", size: 14 }) : _jsx(RotateCcw, { size: 14 }), replayingRunId === replaySource.id ? '正在重放' : '确认重放'] }), replayingRunId === replaySource.id && _jsxs("button", { type: "button", className: "wf-dialog-btn", onClick: () => { const active = replayControllerRef.current; if (!active)
                                        return; active.controller.abort(new Error('重放已取消')); void onCancelRun(active.runId).catch(() => undefined); }, children: [_jsx(Square, { size: 14 }), "\u505C\u6B62\u91CD\u653E"] })] })] }) }), waitDialog && _jsx("div", { className: "wf-dialog-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-credential-dialog wf-wait-dialog", role: "dialog", "aria-modal": "true", "aria-label": waitDialog.mode === 'callback' ? '外部回调凭证' : '处理审批', children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(Hourglass, { size: 17 }), _jsx("strong", { children: waitDialog.mode === 'callback' ? '外部回调凭证' : '处理审批' })] }), _jsx("button", { className: "wf-icon-button", onClick: () => setWaitDialog(null), "aria-label": "\u5173\u95ED", children: _jsx(XCircle, { size: 17 }) })] }), _jsxs("div", { className: "wf-credential-dialog__body", children: [_jsx("strong", { children: waitDialog.run.name }), waitDialog.error && _jsx("p", { className: "wf-wait-dialog__error", children: waitDialog.error }), waitDialog.mode === 'callback' ? _jsxs(_Fragment, { children: [_jsxs("label", { children: [_jsx("span", { children: "\u56DE\u8C03\u5730\u5740" }), _jsxs("div", { className: "wf-credential-copy", children: [_jsx("input", { readOnly: true, value: waitDialog.callbackUrl ?? '正在生成' }), _jsxs("button", { type: "button", disabled: !waitDialog.callbackUrl, onClick: () => void navigator.clipboard.writeText(waitDialog.callbackUrl ?? ''), children: [_jsx(Copy, { size: 14 }), "\u590D\u5236"] })] })] }), _jsxs("label", { children: [_jsx("span", { children: "\u4E00\u6B21\u6027 Token" }), _jsxs("div", { className: "wf-credential-copy", children: [_jsx("input", { readOnly: true, type: "password", value: waitDialog.token ?? '正在生成' }), _jsxs("button", { type: "button", disabled: !waitDialog.token, onClick: () => void navigator.clipboard.writeText(waitDialog.token ?? ''), children: [_jsx(Copy, { size: 14 }), "\u590D\u5236"] })] })] }), _jsxs("code", { className: "wf-wait-dialog__code", children: ["x-dsh-wait-token: ", waitDialog.token ?? '...'] })] }) : _jsxs("label", { children: [_jsx("span", { children: "\u5BA1\u6279\u5907\u6CE8" }), _jsx("textarea", { rows: 5, value: waitNote, onChange: (event) => setWaitNote(event.target.value), placeholder: "\u53EF\u9009" })] })] }), _jsxs("footer", { children: [_jsx("button", { type: "button", onClick: () => setWaitDialog(null), children: "\u5173\u95ED" }), waitDialog.mode === 'approval' && _jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "wf-dialog-btn", disabled: waitBusy, onClick: async () => { setWaitBusy(true); try {
                                                await resolveWorkflowApproval(waitDialog.run.id, 'rejected', waitNote);
                                                setRuns(await listWorkflowRuns());
                                                setWaitDialog(null);
                                            }
                                            catch (error) {
                                                setWaitDialog((current) => current ? { ...current, error: error instanceof Error ? error.message : String(error) } : null);
                                            }
                                            finally {
                                                setWaitBusy(false);
                                            } }, children: "\u62D2\u7EDD" }), _jsx("button", { type: "button", className: "wf-primary-command", disabled: waitBusy, onClick: async () => { setWaitBusy(true); try {
                                                await resolveWorkflowApproval(waitDialog.run.id, 'approved', waitNote);
                                                setRuns(await listWorkflowRuns());
                                                setWaitDialog(null);
                                            }
                                            catch (error) {
                                                setWaitDialog((current) => current ? { ...current, error: error instanceof Error ? error.message : String(error) } : null);
                                            }
                                            finally {
                                                setWaitBusy(false);
                                            } }, children: "\u901A\u8FC7" })] })] })] }) })] }));
}

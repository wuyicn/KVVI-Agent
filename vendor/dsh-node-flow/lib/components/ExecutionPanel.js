import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bug, CheckCircle2, CircleDashed, Clock3, ExternalLink, Hourglass, Loader2, Play, SkipForward, X } from 'lucide-react';
import { useCanvasStore } from '../store/canvas.js';
import { NodeGlyph } from './nodeCatalog.js';
function formatValue(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined)
        return '';
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
export function ExecutionPanel({ onClose, debugRun, debugBusy, onDebugAction, onCancelDebug }) {
    const nodes = useCanvasStore((state) => state.nodes);
    const executed = useMemo(() => nodes.filter((node) => node.data.lastRun), [nodes]);
    const [activeId, setActiveId] = useState(executed[0]?.id ?? null);
    const active = executed.find((node) => node.id === activeId) ?? executed[0];
    const running = executed.some((node) => node.data.lastRun?.running);
    const waiting = executed.some((node) => node.data.lastRun?.waiting);
    const failed = executed.some((node) => node.data.lastRun?.error && !node.data.lastRun?.errorHandled);
    const handled = executed.some((node) => node.data.lastRun?.errorHandled);
    const debugWaiting = debugRun?.status === 'waiting' && debugRun.waitpoint?.mode === 'debug';
    useEffect(() => {
        if (!activeId && executed[0])
            setActiveId(executed[0].id);
    }, [activeId, executed]);
    return (_jsxs("section", { className: "wf-execution", "aria-label": "\u8FD0\u884C\u8BE6\u60C5", children: [_jsxs("header", { className: "wf-execution__header", children: [_jsxs("div", { className: "wf-execution__title", children: [running ? _jsx(Loader2, { className: "wf-spin", size: 17 }) : waiting ? _jsx(Hourglass, { size: 17 }) : failed ? _jsx(AlertCircle, { size: 17 }) : _jsx(CheckCircle2, { size: 17 }), _jsx("strong", { children: debugRun ? '调试运行' : '本次运行' }), _jsx("span", { children: debugWaiting ? `已暂停 · ${debugRun.waitpoint?.debugReason === 'step' ? '单步' : '断点'}` : running ? '执行中' : waiting ? '等待外部条件' : failed ? '部分节点失败' : handled ? '错误已路由处理' : executed.length ? '执行完成' : '暂无运行结果' })] }), _jsx("button", { className: "wf-icon-btn", onClick: onClose, title: "\u5173\u95ED\u8FD0\u884C\u8BE6\u60C5", "aria-label": "\u5173\u95ED\u8FD0\u884C\u8BE6\u60C5", children: _jsx(X, { size: 17 }) })] }), debugWaiting && (_jsxs("div", { className: "wf-execution__debugbar", role: "group", "aria-label": "\u8C03\u8BD5\u63A7\u5236", children: [_jsxs("div", { children: [_jsx(Bug, { size: 15 }), _jsxs("span", { children: ["\u6682\u505C\u4E8E\u300C", debugRun.waitpoint?.nodeId, "\u300D"] })] }), _jsxs("div", { className: "wf-execution__debug-actions", children: [_jsxs("button", { type: "button", className: "wf-btn wf-btn--primary", disabled: debugBusy, onClick: () => void onDebugAction('continue'), children: [_jsx(Play, { size: 14, fill: "currentColor" }), "\u7EE7\u7EED"] }), _jsxs("button", { type: "button", className: "wf-btn", disabled: debugBusy, onClick: () => void onDebugAction('step'), children: [_jsx(SkipForward, { size: 14 }), "\u5355\u6B65"] }), _jsxs("button", { type: "button", className: "wf-btn wf-btn--danger", disabled: debugBusy, onClick: onCancelDebug, children: [_jsx(X, { size: 14 }), "\u7ED3\u675F\u8C03\u8BD5"] })] })] })), _jsxs("div", { className: "wf-execution__body", children: [_jsxs("div", { className: "wf-execution__steps", role: "list", children: [executed.length === 0 && (_jsxs("div", { className: "wf-execution__empty", children: [_jsx(CircleDashed, { size: 20 }), "\u8FD0\u884C\u5DE5\u4F5C\u6D41\u540E\uFF0C\u8FD9\u91CC\u4F1A\u663E\u793A\u6BCF\u4E2A\u8282\u70B9\u7684\u8F93\u5165\u3001\u8F93\u51FA\u548C\u8017\u65F6\u3002"] })), executed.map((node, index) => {
                                const run = node.data.lastRun;
                                return (_jsxs("button", { type: "button", className: `wf-execution-step${active?.id === node.id ? ' is-active' : ''}`, onClick: () => setActiveId(node.id), children: [_jsx("span", { className: "wf-execution-step__index", children: index + 1 }), _jsx(NodeGlyph, { kind: node.data.kind, size: 30, iconSize: 14 }), _jsxs("span", { className: "wf-execution-step__copy", children: [_jsx("strong", { children: node.data.label }), _jsxs("span", { children: [_jsx(Clock3, { size: 11 }), " ", run.duration ?? 0, " ms", (run.attempts ?? 1) > 1 ? ` · ${run.attempts} 次` : ''] })] }), run.running ? _jsx(Loader2, { className: "wf-spin", size: 15 }) : run.waiting ? _jsx(Hourglass, { className: "is-waiting", size: 15 }) : run.error && !run.errorHandled ? _jsx(AlertCircle, { className: "is-error", size: 15 }) : _jsx(CheckCircle2, { className: "is-success", size: 15 })] }, node.id));
                            })] }), active && (_jsxs("div", { className: "wf-execution__detail", children: [_jsxs("div", { className: "wf-execution__detail-head", children: [_jsx("strong", { children: active.data.label }), _jsx("span", { children: active.data.lastRun?.at })] }), _jsxs("div", { className: "wf-execution__io", children: [active.data.kind !== 'connector-trigger' && _jsxs("div", { children: [_jsx("span", { children: "\u8F93\u5165" }), _jsx("pre", { children: active.data.lastRun?.input || '无输入' })] }), _jsxs("div", { children: [_jsx("span", { children: active.data.lastRun?.error ? active.data.lastRun?.errorHandled ? '已路由错误' : '错误' : '输出' }), _jsx("pre", { className: active.data.lastRun?.error && !active.data.lastRun?.errorHandled ? 'is-error' : '', children: active.data.lastRun?.error || formatValue(active.data.lastRun?.value) || '无输出' })] }), active.data.lastRun?.logs && active.data.lastRun.logs.length > 0 && (_jsxs("div", { children: [_jsx("span", { children: "\u65E5\u5FD7" }), _jsx("pre", { children: active.data.lastRun.logs.join('\n') })] })), active.data.lastRun?.childRunId && _jsxs("div", { className: "wf-execution__child", children: [_jsx("span", { children: "\u5B50\u8FD0\u884C" }), _jsxs("code", { children: [_jsx(ExternalLink, { size: 12 }), active.data.lastRun.childRunId] })] })] })] }))] })] }));
}

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Left-side node palette drawer. List node types grouped by category; drag an
 * item onto the canvas to place it there (or click to add at a random spot).
 * Also hosts the example workflows.
 *
 * @module components/NodePalette
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutTemplate, Search, Workflow, X } from 'lucide-react';
import { useCanvasStore } from '../store/canvas.js';
import { buildWeatherExample, buildNewsExample, buildBasicIfExample, buildQaIfExample, buildDailySwitchExample, buildLoopExample, buildWhileExample } from '../model.js';
import { NODE_CATALOG, NodeGlyph } from './nodeCatalog.js';
const EXAMPLES = [
    { label: '天气', load: buildWeatherExample },
    { label: '定时新闻', load: buildNewsExample },
    { label: 'If 分流', load: buildBasicIfExample },
    { label: 'AI 问答', load: buildQaIfExample },
    { label: 'Switch 时段', load: buildDailySwitchExample },
    { label: 'Loop 数组', load: buildLoopExample },
    { label: 'While 计数', load: buildWhileExample },
];
export function NodePalette({ onClose, onAdd, initialTab = 'nodes', insertMode = false, }) {
    const addNodeAt = useCanvasStore((s) => s.addNodeAt);
    const [query, setQuery] = useState('');
    const [tab, setTab] = useState(initialTab);
    const searchRef = useRef(null);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matches = useMemo(() => NODE_CATALOG.filter((item) => ((!insertMode || !['trigger', 'webhook', 'schedule', 'connector-trigger', 'note'].includes(item.kind))
        && (!normalizedQuery
            || `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase().includes(normalizedQuery)))), [insertMode, normalizedQuery]);
    const groups = useMemo(() => ['触发器', '执行', '流程控制', '辅助'].map((group) => ({
        group,
        items: matches.filter((item) => item.group === group),
    })).filter((group) => group.items.length > 0), [matches]);
    useEffect(() => {
        searchRef.current?.focus();
    }, []);
    const add = (kind, label) => {
        if (onAdd)
            onAdd(kind, label);
        else
            addNodeAt(kind, label, { x: 160 + Math.random() * 240, y: 120 + Math.random() * 240 });
        onClose?.();
    };
    return (_jsxs("aside", { className: "wf-palette", "aria-label": "\u8282\u70B9\u5E93", children: [_jsxs("header", { className: "wf-palette__header", children: [_jsxs("div", { children: [_jsx("strong", { children: "\u6DFB\u52A0\u6B65\u9AA4" }), _jsx("span", { children: "\u9009\u62E9\u4E00\u4E2A\u8282\u70B9\u52A0\u5165\u5F53\u524D\u5DE5\u4F5C\u6D41" })] }), onClose && (_jsx("button", { className: "wf-icon-btn", onClick: onClose, title: "\u5173\u95ED\u8282\u70B9\u5E93", "aria-label": "\u5173\u95ED\u8282\u70B9\u5E93", children: _jsx(X, { size: 17 }) }))] }), _jsxs("div", { className: `wf-palette__tabs${insertMode ? ' is-single' : ''}`, role: "tablist", "aria-label": "\u8282\u70B9\u5E93\u89C6\u56FE", children: [_jsxs("button", { className: tab === 'nodes' ? 'is-active' : '', onClick: () => setTab('nodes'), role: "tab", "aria-selected": tab === 'nodes', children: [_jsx(Workflow, { size: 15 }), " \u8282\u70B9"] }), !insertMode && _jsxs("button", { className: tab === 'templates' ? 'is-active' : '', onClick: () => setTab('templates'), role: "tab", "aria-selected": tab === 'templates', children: [_jsx(LayoutTemplate, { size: 15 }), " \u6A21\u677F"] })] }), tab === 'nodes' && (_jsxs("label", { className: "wf-palette__search", children: [_jsx(Search, { size: 16, "aria-hidden": "true" }), _jsx("input", { ref: searchRef, value: query, onChange: (event) => setQuery(event.target.value), placeholder: "\u641C\u7D22\u8282\u70B9\u6216\u529F\u80FD", "aria-label": "\u641C\u7D22\u8282\u70B9" }), query && (_jsx("button", { onClick: () => setQuery(''), title: "\u6E05\u7A7A\u641C\u7D22", "aria-label": "\u6E05\u7A7A\u641C\u7D22", type: "button", children: _jsx(X, { size: 14 }) }))] })), _jsxs("div", { className: "wf-palette__body", children: [tab === 'nodes' && groups.map((g) => (_jsxs("div", { className: "wf-palette__group", children: [_jsx("div", { className: "wf-palette__group-title", children: g.group }), g.items.map((it) => (_jsxs("button", { type: "button", className: "wf-palette__item", draggable: true, onDragStart: (e) => {
                                    e.dataTransfer.setData('application/reactflow', it.kind);
                                    e.dataTransfer.effectAllowed = 'move';
                                }, onClick: () => add(it.kind, it.label), children: [_jsx(NodeGlyph, { kind: it.kind, size: 34, iconSize: 17 }), _jsxs("span", { className: "wf-palette__copy", children: [_jsx("strong", { children: it.label }), _jsx("span", { children: it.description })] })] }, it.kind)))] }, g.group))), tab === 'nodes' && groups.length === 0 && (_jsx("div", { className: "wf-palette__empty", children: "\u6CA1\u6709\u5339\u914D\u7684\u8282\u70B9" })), tab === 'templates' && _jsxs("div", { className: "wf-palette__group wf-palette__templates", children: [_jsx("div", { className: "wf-palette__group-title", children: "\u5DE5\u4F5C\u6D41\u6A21\u677F" }), EXAMPLES.map((x) => (_jsxs("button", { type: "button", className: "wf-palette__item wf-palette__template", onClick: () => {
                                    if (!window.confirm(`载入“${x.label}”将替换当前画布。确定继续吗？`))
                                        return;
                                    useCanvasStore.getState().importDocument(x.load());
                                    onClose?.();
                                }, children: [_jsx("span", { className: "wf-template-icon", children: _jsx(LayoutTemplate, { size: 16 }) }), _jsxs("span", { className: "wf-palette__copy", children: [_jsx("strong", { children: x.label }), _jsx("span", { children: "\u66FF\u6362\u5F53\u524D\u753B\u5E03\u5E76\u8F7D\u5165\u793A\u4F8B" })] })] }, x.label)))] })] }), _jsx("div", { className: "wf-palette__hint", children: "\u70B9\u51FB\u6DFB\u52A0\uFF0C\u6216\u62D6\u52A8\u5230\u753B\u5E03\u4E2D\u7684\u6307\u5B9A\u4F4D\u7F6E" })] }));
}

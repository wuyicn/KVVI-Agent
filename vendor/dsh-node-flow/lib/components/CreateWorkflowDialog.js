import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Braces, CloudSun, GitBranch, LayoutTemplate, Loader2, Newspaper, Plus, X } from 'lucide-react';
import { buildBasicIfExample, buildLoopExample, buildNewsExample, buildWeatherExample, createBlankWorkflowDocument, } from '../model.js';
const TEMPLATES = [
    {
        id: 'blank',
        name: '空白工作流',
        description: '从手动触发器开始构建',
        icon: Plus,
        build: () => createBlankWorkflowDocument(),
    },
    {
        id: 'weather',
        name: 'AI 天气播报',
        description: '抓取天气并交给 Agent 整理',
        icon: CloudSun,
        build: buildWeatherExample,
    },
    {
        id: 'news',
        name: '定时新闻摘要',
        description: '按计划收集并总结新闻',
        icon: Newspaper,
        build: buildNewsExample,
    },
    {
        id: 'branch',
        name: '条件分流',
        description: '用 If 节点路由不同结果',
        icon: GitBranch,
        build: buildBasicIfExample,
    },
    {
        id: 'loop',
        name: '循环处理',
        description: '遍历数组并收集执行结果',
        icon: Braces,
        build: buildLoopExample,
    },
];
export function CreateWorkflowDialog({ onClose, onCreate, folders = [], initialFolderId, }) {
    const [selectedId, setSelectedId] = useState('blank');
    const [name, setName] = useState('未命名工作流');
    const [folderId, setFolderId] = useState(initialFolderId ?? '');
    const [creating, setCreating] = useState(false);
    const creatingRef = useRef(false);
    const selected = useMemo(() => TEMPLATES.find((template) => template.id === selectedId) ?? TEMPLATES[0], [selectedId]);
    useEffect(() => {
        const closeOnEscape = (event) => {
            if (event.key === 'Escape' && !creatingRef.current)
                onClose();
        };
        document.addEventListener('keydown', closeOnEscape);
        return () => document.removeEventListener('keydown', closeOnEscape);
    }, [onClose]);
    useEffect(() => {
        if (!folderId || folders.some((folder) => folder.id === folderId))
            return;
        setFolderId('');
    }, [folderId, folders]);
    return (_jsx("div", { className: "wf-dialog-backdrop", role: "presentation", onMouseDown: (event) => {
            if (!creatingRef.current && event.target === event.currentTarget)
                onClose();
        }, children: _jsxs("section", { className: "wf-create-dialog", role: "dialog", "aria-modal": "true", "aria-label": "\u521B\u5EFA\u5DE5\u4F5C\u6D41", children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx("strong", { children: "\u521B\u5EFA\u5DE5\u4F5C\u6D41" }), _jsx("span", { children: "\u9009\u62E9\u4E00\u4E2A\u8D77\u70B9\uFF0C\u7A0D\u540E\u53EF\u4EE5\u81EA\u7531\u4FEE\u6539\u3002" })] }), _jsx("button", { className: "wf-icon-btn", onClick: onClose, disabled: creating, "aria-label": "\u5173\u95ED\u521B\u5EFA\u7A97\u53E3", title: "\u5173\u95ED", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "wf-create-dialog__body", children: [_jsxs("label", { className: "wf-create-dialog__name", children: [_jsx("span", { children: "\u5DE5\u4F5C\u6D41\u540D\u79F0" }), _jsx("input", { value: name, onChange: (event) => setName(event.target.value), autoFocus: true })] }), _jsxs("label", { className: "wf-create-dialog__name", children: [_jsx("span", { children: "\u6587\u4EF6\u5939" }), _jsxs("select", { "aria-label": "\u65B0\u5DE5\u4F5C\u6D41\u6587\u4EF6\u5939", value: folderId, onChange: (event) => setFolderId(event.target.value), children: [_jsx("option", { value: "", children: "\u672A\u5206\u7C7B" }), folders.map((folder) => _jsx("option", { value: folder.id, children: folder.name }, folder.id))] })] }), _jsxs("div", { className: "wf-create-dialog__section-title", children: [_jsx(LayoutTemplate, { size: 14 }), " \u9009\u62E9\u6A21\u677F"] }), _jsx("div", { className: "wf-template-grid", children: TEMPLATES.map((template) => {
                                const Icon = template.icon;
                                return (_jsxs("button", { type: "button", className: selectedId === template.id ? 'is-selected' : '', onClick: () => {
                                        setSelectedId(template.id);
                                        if (name === '未命名工作流' || TEMPLATES.some((candidate) => candidate.name === name))
                                            setName(template.name);
                                    }, children: [_jsx("span", { children: _jsx(Icon, { size: 19 }) }), _jsx("strong", { children: template.name }), _jsx("small", { children: template.description })] }, template.id));
                            }) })] }), _jsxs("footer", { children: [_jsx("button", { className: "wf-dialog-btn", onClick: onClose, disabled: creating, children: "\u53D6\u6D88" }), _jsxs("button", { className: "wf-dialog-btn wf-dialog-btn--primary", disabled: !name.trim() || creating, onClick: async () => {
                                if (creatingRef.current)
                                    return;
                                creatingRef.current = true;
                                setCreating(true);
                                const document = selected.build();
                                try {
                                    await onCreate(name.trim(), { ...document, name: name.trim() }, folderId || undefined);
                                }
                                finally {
                                    creatingRef.current = false;
                                    setCreating(false);
                                }
                            }, children: [creating && _jsx(Loader2, { className: "wf-spin", size: 15 }), creating ? '正在创建' : '创建并打开'] })] })] }) }));
}

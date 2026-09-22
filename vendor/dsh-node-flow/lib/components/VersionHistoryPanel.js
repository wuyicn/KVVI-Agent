import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileClock, GitCompareArrows, Loader2, Minus, PencilLine, Plus, Rocket, RotateCcw, X } from 'lucide-react';
import { listWorkflowVersions } from '../workflowRepository.js';
import { diffWorkflowDocuments, workflowDiffCount } from '../workflowVersionProtocol.js';
const VERSION_KIND_LABELS = {
    created: '创建',
    draft: '保存草稿',
    published: '发布',
    disabled: '停用',
    restored: '恢复草稿',
    'restored-published': '恢复并发布',
    imported: '历史基线',
};
function formatVersionTime(value) {
    return new Date(value).toLocaleString('zh-CN');
}
function DiffGroup({ title, tone, items }) {
    if (items.length === 0)
        return null;
    const Icon = tone === 'add' ? Plus : tone === 'remove' ? Minus : PencilLine;
    return (_jsxs("section", { className: `wf-version-diff-group is-${tone}`, children: [_jsxs("header", { children: [_jsx(Icon, { size: 14 }), _jsx("strong", { children: title }), _jsx("span", { children: items.length })] }), _jsx("div", { children: items.map((item) => _jsx("code", { children: item }, item)) })] }));
}
function diffGroups(diff) {
    return [
        { title: '新增节点', tone: 'add', items: diff.addedNodes.map((node) => `${node.label} · ${node.kind}`) },
        { title: '删除节点', tone: 'remove', items: diff.removedNodes.map((node) => `${node.label} · ${node.kind}`) },
        { title: '修改节点', tone: 'change', items: diff.changedNodes.map((node) => `${node.label} · ${node.fields.join('、')}`) },
        { title: '修改工作流设置', tone: 'change', items: [diff.inputsChanged ? '输入契约' : '', diff.outputsChanged ? '输出契约' : '', diff.concurrencyChanged ? '运行并发' : '', diff.executionLimitsChanged ? '执行限制' : ''].filter(Boolean) },
        { title: '新增连接', tone: 'add', items: diff.addedEdges.map((edge) => `${edge.source} → ${edge.target}`) },
        { title: '删除连接', tone: 'remove', items: diff.removedEdges.map((edge) => `${edge.source} → ${edge.target}`) },
        { title: '修改连接', tone: 'change', items: diff.changedEdges.map((edge) => `${edge.source} → ${edge.target}`) },
    ];
}
export function VersionHistoryPanel({ workflow, onClose, onRestore, }) {
    const [current, setCurrent] = useState(workflow);
    const [versions, setVersions] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [compareId, setCompareId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [action, setAction] = useState(null);
    const actionRef = useRef(false);
    const load = useCallback(async (nextWorkflow) => {
        setLoading(true);
        setError('');
        try {
            const items = await listWorkflowVersions(nextWorkflow);
            setVersions(items);
            setSelectedId((selected) => selected && items.some((version) => version.id === selected) ? selected : items[0]?.id ?? null);
            setCompareId((selected) => selected && items.some((version) => version.id === selected) ? selected : items[1]?.id ?? items[0]?.id ?? null);
        }
        catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : '版本历史加载失败');
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        void load(current);
    }, [current, load]);
    const selected = versions.find((version) => version.id === selectedId);
    const compared = versions.find((version) => version.id === compareId);
    const diff = useMemo(() => selected && compared ? diffWorkflowDocuments(selected.doc, compared.doc) : null, [compared, selected]);
    const groups = useMemo(() => diff ? diffGroups(diff) : [], [diff]);
    const chooseVersion = (version) => {
        setSelectedId(version.id);
        if (compareId === version.id) {
            setCompareId((versions.find((candidate) => candidate.id !== version.id) ?? version).id);
        }
    };
    const restore = async (publish) => {
        if (!selected || actionRef.current)
            return;
        const prompt = publish
            ? `确定把 v${selected.revision} 恢复并立即发布吗？当前线上版本会被新的发布快照替换。`
            : `确定把 v${selected.revision} 恢复为新草稿吗？当前线上版本不会改变。`;
        if (!window.confirm(prompt))
            return;
        actionRef.current = true;
        setAction(publish ? 'publish' : 'draft');
        setError('');
        try {
            const saved = await onRestore(current, selected, publish);
            setCurrent(saved);
            setSelectedId(null);
            setCompareId(null);
        }
        catch (restoreError) {
            setError(restoreError instanceof Error ? restoreError.message : '历史版本恢复失败');
        }
        finally {
            actionRef.current = false;
            setAction(null);
        }
    };
    return (_jsx("div", { className: "wf-version-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-version-panel", role: "dialog", "aria-modal": "true", "aria-label": `${current.name} 版本历史`, children: [_jsxs("header", { className: "wf-version-panel__header", children: [_jsxs("div", { children: [_jsx("span", { children: _jsx(FileClock, { size: 18 }) }), _jsxs("div", { children: [_jsx("strong", { children: "\u7248\u672C\u5386\u53F2" }), _jsxs("small", { children: [current.name, " \u00B7 \u5F53\u524D\u8BB0\u5F55 v", current.revision] })] })] }), _jsx("button", { className: "wf-icon-btn", onClick: onClose, "aria-label": "\u5173\u95ED\u7248\u672C\u5386\u53F2", children: _jsx(X, { size: 18 }) })] }), _jsxs("div", { className: "wf-version-panel__body", children: [_jsxs("aside", { className: "wf-version-list", children: [loading && _jsxs("div", { className: "wf-version-empty", children: [_jsx(Loader2, { className: "wf-spin", size: 19 }), "\u6B63\u5728\u52A0\u8F7D\u7248\u672C"] }), !loading && versions.map((version) => (_jsxs("button", { className: selectedId === version.id ? 'is-active' : '', onClick: () => chooseVersion(version), children: [_jsx("span", { className: "wf-version-list__dot" }), _jsxs("span", { children: [_jsxs("strong", { children: ["v", version.revision] }), _jsxs("small", { children: [VERSION_KIND_LABELS[version.kind], " \u00B7 ", formatVersionTime(version.createdAt)] })] }), _jsxs("span", { className: "wf-version-list__badges", children: [version.revision === current.revision && _jsx("em", { children: "\u5F53\u524D" }), version.publishedRevision === version.draftRevision && version.status === 'enabled' && _jsx("em", { className: "is-published", children: "\u5DF2\u53D1\u5E03" })] })] }, version.id))), !loading && versions.length === 0 && _jsx("div", { className: "wf-version-empty", children: "\u6682\u65E0\u7248\u672C\u5386\u53F2" })] }), _jsxs("main", { className: "wf-version-detail", children: [selected ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "wf-version-summary", children: [_jsxs("div", { children: [_jsxs("strong", { children: ["v", selected.revision, " \u00B7 ", VERSION_KIND_LABELS[selected.kind]] }), _jsxs("span", { children: [selected.doc.nodes.length, " \u4E2A\u8282\u70B9 \u00B7 ", selected.doc.edges.length, " \u6761\u8FDE\u63A5"] })] }), _jsxs("div", { className: "wf-version-actions", children: [_jsxs("button", { disabled: action !== null || selected.revision === current.revision, onClick: () => void restore(false), children: [action === 'draft' ? _jsx(Loader2, { className: "wf-spin", size: 14 }) : _jsx(RotateCcw, { size: 14 }), "\u6062\u590D\u4E3A\u8349\u7A3F"] }), _jsxs("button", { className: "is-primary", disabled: action !== null || selected.revision === current.revision, onClick: () => void restore(true), children: [action === 'publish' ? _jsx(Loader2, { className: "wf-spin", size: 14 }) : _jsx(Rocket, { size: 14 }), "\u6062\u590D\u5E76\u53D1\u5E03"] })] })] }), _jsxs("div", { className: "wf-version-compare", children: [_jsx(GitCompareArrows, { size: 16 }), _jsxs("label", { children: ["\u4ECE", _jsx("select", { value: selectedId ?? '', onChange: (event) => setSelectedId(event.target.value), children: versions.map((version) => _jsxs("option", { value: version.id, children: ["v", version.revision, " \u00B7 ", VERSION_KIND_LABELS[version.kind]] }, version.id)) })] }), _jsx("span", { children: "\u6BD4\u8F83\u5230" }), _jsx("label", { children: _jsx("select", { value: compareId ?? '', onChange: (event) => setCompareId(event.target.value), children: versions.map((version) => _jsxs("option", { value: version.id, children: ["v", version.revision, " \u00B7 ", VERSION_KIND_LABELS[version.kind]] }, version.id)) }) })] }), diff && _jsxs("div", { className: "wf-version-diff", children: [_jsxs("div", { className: "wf-version-diff__overview", children: [_jsxs("span", { children: [_jsx("strong", { children: workflowDiffCount(diff) }), " \u9879\u7ED3\u6784\u53D8\u5316"] }), _jsx("span", { children: diff.nameChanged ? '名称已改变' : '名称未改变' }), _jsx("span", { children: diff.descriptionChanged ? '描述已改变' : '描述未改变' }), _jsx("span", { children: diff.inputsChanged || diff.outputsChanged ? '输入 / 输出契约已改变' : '契约未改变' })] }), workflowDiffCount(diff) === 0 ? _jsxs("div", { className: "wf-version-no-diff", children: [_jsx(CheckCircle2, { size: 18 }), "\u4E24\u4E2A\u7248\u672C\u7684\u5DE5\u4F5C\u6D41\u7ED3\u6784\u76F8\u540C"] }) : groups.map((group) => _jsx(DiffGroup, { ...group }, `${group.tone}-${group.title}`))] })] })) : _jsx("div", { className: "wf-version-empty", children: "\u9009\u62E9\u4E00\u4E2A\u7248\u672C\u67E5\u770B\u8BE6\u60C5" }), error && _jsx("div", { className: "wf-version-error", children: error })] })] })] }) }));
}

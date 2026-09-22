import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Braces, Clock3, FolderTree, KeyRound, Loader2, RefreshCw, Search, ShieldCheck, Workflow } from 'lucide-react';
import { listWorkflowAuditEvents } from '../workflowRepository.js';
const TARGET_OPTIONS = [
    { value: 'all', label: '全部对象' },
    { value: 'workflow', label: '工作流' },
    { value: 'credential', label: '连接' },
    { value: 'variable', label: '变量' },
    { value: 'folder', label: '文件夹' },
    { value: 'run', label: '运行' },
    { value: 'waitpoint', label: '等待点' },
];
const ACTION_LABELS = {
    'workflow.created': '创建工作流',
    'workflow.moved': '移动工作流',
    'workflow.published': '发布工作流',
    'workflow.disabled': '停用工作流',
    'workflow.deleted': '删除工作流',
    'workflow.restored': '恢复工作流版本',
    'credential.created': '创建连接',
    'credential.updated': '更新连接',
    'credential.tested': '测试连接',
    'credential.authorization-started': '开始 OAuth2 授权',
    'credential.authorized': '完成 OAuth2 授权',
    'credential.authorization-cancelled': '取消 OAuth2 授权',
    'credential.deleted': '删除连接',
    'variable.created': '创建变量',
    'variable.updated': '更新变量',
    'variable.deleted': '删除变量',
    'folder.created': '创建文件夹',
    'folder.renamed': '重命名文件夹',
    'folder.deleted': '删除文件夹',
    'run.manual-started': '启动手动运行',
    'run.debug-started': '启动断点调试',
    'run.debug-stepped': '执行下一步调试',
    'run.debug-continued': '继续断点调试',
    'run.debug-cancelled': '取消断点调试',
    'run.cancelled': '取消运行',
    'run.resumed': '恢复运行',
    'run.replayed': '重放运行',
    'waitpoint.approved': '通过审批',
    'waitpoint.rejected': '拒绝审批',
};
function targetLabel(type) {
    return TARGET_OPTIONS.find((option) => option.value === type)?.label || type;
}
function targetIcon(type) {
    if (type === 'workflow')
        return _jsx(Workflow, { size: 16 });
    if (type === 'credential')
        return _jsx(KeyRound, { size: 16 });
    if (type === 'variable')
        return _jsx(Braces, { size: 16 });
    if (type === 'folder')
        return _jsx(FolderTree, { size: 16 });
    if (type === 'run')
        return _jsx(Activity, { size: 16 });
    return _jsx(Clock3, { size: 16 });
}
function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
}
function eventMatches(event, query) {
    if (!query)
        return true;
    const source = [
        ACTION_LABELS[event.action],
        event.action,
        event.target.name,
        event.target.id,
        targetLabel(event.target.type),
        event.actor === 'system' ? '系统' : '本地用户',
        ...Object.entries(event.details ?? {}).flatMap(([key, value]) => [key, String(value)]),
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    return source.includes(query.toLocaleLowerCase());
}
export function AuditLogPanel() {
    const [events, setEvents] = useState([]);
    const [targetType, setTargetType] = useState('all');
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const requestVersion = useRef(0);
    const load = useCallback(async () => {
        const version = ++requestVersion.current;
        setLoading(true);
        setError('');
        try {
            const next = await listWorkflowAuditEvents({
                limit: 200,
                targetType: targetType === 'all' ? undefined : targetType,
            });
            if (version === requestVersion.current)
                setEvents(next);
        }
        catch (caught) {
            if (version === requestVersion.current)
                setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            if (version === requestVersion.current)
                setLoading(false);
        }
    }, [targetType]);
    useEffect(() => {
        void load();
        return () => { requestVersion.current += 1; };
    }, [load]);
    const visible = useMemo(() => events.filter((event) => eventMatches(event, query.trim())), [events, query]);
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: "wf-page-header", children: [_jsxs("div", { children: [_jsx("h1", { children: "\u5BA1\u8BA1\u65E5\u5FD7" }), _jsx("p", { children: "\u8BB0\u5F55\u672C\u673A\u63A7\u5236\u9762\u64CD\u4F5C\u3002\u654F\u611F\u8F93\u5165\u3001\u8FDE\u63A5\u5BC6\u94A5\u3001\u8FD0\u884C\u8F93\u51FA\u4E0E\u5BA1\u6279\u5907\u6CE8\u4E0D\u4F1A\u5199\u5165\u3002" })] }), _jsx("div", { className: "wf-page-header__actions", children: _jsx("button", { className: "wf-icon-button", onClick: () => void load(), disabled: loading, "aria-label": "\u5237\u65B0\u5BA1\u8BA1\u65E5\u5FD7", title: "\u5237\u65B0\u5BA1\u8BA1\u65E5\u5FD7", children: loading ? _jsx(Loader2, { className: "wf-spin", size: 17 }) : _jsx(RefreshCw, { size: 17 }) }) })] }), _jsxs("div", { className: "wf-audit-toolbar", children: [_jsxs("label", { className: "wf-audit-filter", children: [_jsx("span", { children: "\u5BF9\u8C61" }), _jsx("select", { "aria-label": "\u5BA1\u8BA1\u5BF9\u8C61\u7B5B\u9009", value: targetType, onChange: (event) => setTargetType(event.target.value), children: TARGET_OPTIONS.map((option) => _jsx("option", { value: option.value, children: option.label }, option.value)) })] }), _jsxs("label", { className: "wf-dashboard-search", children: [_jsx(Search, { size: 16 }), _jsx("input", { "aria-label": "\u7B5B\u9009\u5BA1\u8BA1\u65E5\u5FD7", value: query, onChange: (event) => setQuery(event.target.value), placeholder: "\u7B5B\u9009\u64CD\u4F5C\u3001\u540D\u79F0\u6216 ID" })] }), _jsxs("span", { className: "wf-list-count", children: [visible.length, " \u6761"] })] }), error && _jsx("div", { className: "wf-credential-error", role: "alert", children: error }), loading && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(Loader2, { className: "wf-spin", size: 22 }), _jsx("strong", { children: "\u6B63\u5728\u8BFB\u53D6\u5BA1\u8BA1\u65E5\u5FD7" })] }), !loading && visible.length === 0 && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx("span", { children: _jsx(ShieldCheck, { size: 23 }) }), _jsx("strong", { children: "\u6CA1\u6709\u5339\u914D\u7684\u5BA1\u8BA1\u8BB0\u5F55" }), _jsx("p", { children: "\u8C03\u6574\u7B5B\u9009\u6761\u4EF6\u6216\u5728\u5B8C\u6210\u4E00\u6B21\u7BA1\u7406\u64CD\u4F5C\u540E\u5237\u65B0\u3002" })] }), !loading && visible.length > 0 && _jsx("div", { className: "wf-audit-list", "aria-live": "polite", children: visible.map((event) => {
                    const details = Object.entries(event.details ?? {});
                    return _jsxs("article", { className: `wf-audit-row is-${event.target.type}`, children: [_jsx("span", { className: "wf-audit-row__icon", children: targetIcon(event.target.type) }), _jsxs("div", { className: "wf-audit-row__main", children: [_jsx("strong", { children: ACTION_LABELS[event.action] }), _jsx("small", { children: event.target.name || event.target.id })] }), _jsx("span", { className: "wf-audit-row__target", children: targetLabel(event.target.type) }), _jsx("div", { className: "wf-audit-row__details", children: details.length > 0 ? details.map(([key, value]) => _jsxs("code", { children: [key, ": ", String(value)] }, key)) : _jsx("span", { children: "\u65E0\u9644\u52A0\u4FE1\u606F" }) }), _jsx("span", { className: "wf-audit-row__actor", children: event.actor === 'system' ? '系统' : '本地用户' }), _jsx("time", { dateTime: event.at, title: event.at, children: formatDate(event.at) })] }, event.id);
                }) })] }));
}

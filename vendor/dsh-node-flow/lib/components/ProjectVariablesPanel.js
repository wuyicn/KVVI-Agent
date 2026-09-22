import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { Braces, Clipboard, Eye, EyeOff, KeyRound, Loader2, LockKeyhole, Pencil, Plus, Trash2, X } from 'lucide-react';
const EMPTY_FORM = { name: '', kind: 'plain', description: '', value: '' };
function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}
function referenceLabel(references) {
    if (references.length === 0)
        return '未被工作流引用';
    const workflows = new Set(references.map((reference) => reference.workflowId)).size;
    return `${workflows} 个工作流 · ${references.length} 处引用`;
}
export function ProjectVariablesPanel() {
    const [variables, setVariables] = useState([]);
    const [loading, setLoading] = useState(true);
    const [form, setForm] = useState(null);
    const [showSecret, setShowSecret] = useState(false);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const actionLock = useRef(false);
    const load = useCallback(async (showLoading = true) => {
        if (showLoading)
            setLoading(true);
        try {
            const response = await fetch('/dsh-node-flow/project-variables', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error || `HTTP ${response.status}`);
            setVariables(Array.isArray(data.variables) ? data.variables : []);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            if (showLoading)
                setLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        if (!form)
            return;
        const close = (event) => {
            if (event.key === 'Escape' && !actionLock.current)
                setForm(null);
        };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
    }, [form]);
    const save = async () => {
        if (!form || actionLock.current)
            return;
        actionLock.current = true;
        setBusy('save');
        setError('');
        try {
            const response = await fetch('/dsh-node-flow/project-variables', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    action: 'save',
                    expectedUpdatedAt: form.updatedAt,
                    variable: { id: form.id, name: form.name, kind: form.kind, description: form.description, value: form.value || undefined },
                }),
            });
            const data = await response.json();
            if (!response.ok || !data.variable)
                throw new Error(data.error || `HTTP ${response.status}`);
            setForm(null);
            setShowSecret(false);
            await load(false);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            actionLock.current = false;
            setBusy('');
        }
    };
    const remove = async (variable) => {
        if (actionLock.current)
            return;
        const references = variable.references ?? [];
        if (references.length > 0) {
            setError(`变量 ${variable.name} 仍被 ${references.length} 个节点引用，先更新草稿和发布版本后再删除。`);
            return;
        }
        if (!window.confirm(`删除变量 ${variable.name}？此操作无法撤销。`))
            return;
        actionLock.current = true;
        setBusy(`delete:${variable.id}`);
        setError('');
        try {
            const response = await fetch('/dsh-node-flow/project-variables', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id: variable.id, expectedUpdatedAt: variable.updatedAt }),
            });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error || `HTTP ${response.status}`);
            await load(false);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            await load(false);
        }
        finally {
            actionLock.current = false;
            setBusy('');
        }
    };
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: "wf-page-header", children: [_jsxs("div", { children: [_jsx("h1", { children: "\u9879\u76EE\u53D8\u91CF" }), _jsxs("p", { children: ["\u96C6\u4E2D\u7BA1\u7406\u6D41\u7A0B\u914D\u7F6E\u4E0E Secret\uFF0C\u5DE5\u4F5C\u6D41\u53EA\u4FDD\u5B58 ", _jsx("code", { children: '{{vars.NAME}}' }), " \u5F15\u7528\u3002"] })] }), _jsx("div", { className: "wf-page-header__actions", children: _jsxs("button", { className: "wf-primary-command", onClick: () => { setError(''); setShowSecret(false); setForm({ ...EMPTY_FORM }); }, children: [_jsx(Plus, { size: 16 }), "\u65B0\u5EFA\u53D8\u91CF"] }) })] }), error && _jsx("div", { className: "wf-credential-error", role: "alert", children: error }), loading && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(Loader2, { className: "wf-spin", size: 24 }), _jsx("strong", { children: "\u6B63\u5728\u52A0\u8F7D\u9879\u76EE\u53D8\u91CF" })] }), !loading && variables.length === 0 && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(Braces, { size: 27 }), _jsx("strong", { children: "\u6682\u65E0\u9879\u76EE\u53D8\u91CF" }), _jsx("p", { children: "\u4FDD\u5B58\u73AF\u5883\u5730\u5740\u3001\u5F00\u5173\u6216 Secret\uFF0C\u5728\u8282\u70B9\u6A21\u677F\u4E2D\u901A\u8FC7 vars \u5F15\u7528\u3002" })] }), !loading && variables.length > 0 && _jsx("div", { className: "wf-variable-list", children: variables.map((variable) => {
                    const references = variable.references ?? [];
                    const token = `{{vars.${variable.name}}}`;
                    return _jsxs("article", { children: [_jsx("span", { className: `wf-variable-list__icon is-${variable.kind}`, children: variable.kind === 'secret' ? _jsx(LockKeyhole, { size: 17 }) : _jsx(Braces, { size: 17 }) }), _jsxs("div", { className: "wf-variable-list__main", children: [_jsx("strong", { children: variable.name }), _jsx("code", { children: token }), _jsx("small", { children: variable.description || (variable.kind === 'secret' ? '加密 Secret' : variable.value || '普通变量') })] }), _jsxs("span", { className: `wf-variable-kind is-${variable.kind}`, children: [variable.kind === 'secret' ? _jsx(KeyRound, { size: 12 }) : _jsx(Eye, { size: 12 }), variable.kind === 'secret' ? 'Secret' : '普通值'] }), _jsx("span", { className: "wf-variable-references", title: references.map((reference) => `${reference.workflowName} / ${reference.nodeLabel} / ${reference.scope === 'published' ? '发布版' : '草稿'}`).join('\n'), children: referenceLabel(references) }), _jsx("time", { children: formatDate(variable.updatedAt) }), _jsxs("div", { className: "wf-credential-actions", children: [_jsx("button", { className: "wf-icon-button", title: "\u590D\u5236\u5F15\u7528", "aria-label": `复制 ${variable.name} 引用`, onClick: () => void navigator.clipboard.writeText(token), children: _jsx(Clipboard, { size: 14 }) }), _jsx("button", { className: "wf-icon-button", title: "\u7F16\u8F91", "aria-label": `编辑 ${variable.name}`, onClick: () => { setError(''); setShowSecret(false); setForm({ id: variable.id, name: variable.name, kind: variable.kind, description: variable.description || '', value: variable.kind === 'plain' ? variable.value || '' : '', updatedAt: variable.updatedAt }); }, children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { className: "wf-icon-button is-danger", disabled: Boolean(busy) || references.length > 0, title: references.length ? '仍被工作流引用' : '删除', "aria-label": `删除 ${variable.name}`, onClick: () => void remove(variable), children: busy === `delete:${variable.id}` ? _jsx(Loader2, { className: "wf-spin", size: 14 }) : _jsx(Trash2, { size: 14 }) })] })] }, variable.id);
                }) }), form && _jsx("div", { className: "wf-dialog-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-credential-dialog", role: "dialog", "aria-modal": "true", "aria-label": form.id ? '编辑项目变量' : '新建项目变量', children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(Braces, { size: 17 }), _jsx("strong", { children: form.id ? '编辑项目变量' : '新建项目变量' })] }), _jsx("button", { className: "wf-icon-button", "aria-label": "\u5173\u95ED", onClick: () => setForm(null), children: _jsx(X, { size: 17 }) })] }), _jsxs("div", { className: "wf-credential-dialog__body", children: [_jsxs("label", { children: [_jsx("span", { children: "\u53D8\u91CF\u540D" }), _jsx("input", { autoFocus: !form.id, readOnly: Boolean(form.id), value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') }), placeholder: "API_HOST", maxLength: 64 }), _jsx("small", { children: "\u5927\u5199\u5B57\u6BCD\u5F00\u5934\uFF0C\u4EC5\u5141\u8BB8\u5927\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u4E0B\u5212\u7EBF\uFF1B\u4FDD\u5B58\u540E\u4E0D\u53EF\u91CD\u547D\u540D\u3002" })] }), _jsxs("label", { children: [_jsx("span", { children: "\u7C7B\u578B" }), _jsxs("select", { disabled: Boolean(form.id), value: form.kind, onChange: (event) => setForm({ ...form, kind: event.target.value, value: '' }), children: [_jsx("option", { value: "plain", children: "\u666E\u901A\u503C" }), _jsx("option", { value: "secret", children: "Secret" })] })] }), _jsxs("label", { children: [_jsx("span", { children: "\u8BF4\u660E" }), _jsx("input", { value: form.description, onChange: (event) => setForm({ ...form, description: event.target.value }), placeholder: "\u53EF\u9009\uFF0C\u8BF4\u660E\u53D8\u91CF\u7528\u9014", maxLength: 200 })] }), _jsxs("label", { children: [_jsx("span", { children: "\u503C" }), _jsxs("div", { className: "wf-variable-secret-input", children: [_jsx("input", { "aria-label": "\u53D8\u91CF\u503C", type: form.kind === 'secret' && !showSecret ? 'password' : 'text', autoComplete: "new-password", value: form.value, onChange: (event) => setForm({ ...form, value: event.target.value }), placeholder: form.id ? '留空则保持不变' : form.kind === 'secret' ? '至少 8 个字符' : '' }), form.kind === 'secret' && _jsx("button", { type: "button", "aria-label": showSecret ? '隐藏 Secret' : '显示 Secret', onClick: () => setShowSecret((value) => !value), children: showSecret ? _jsx(EyeOff, { size: 15 }) : _jsx(Eye, { size: 15 }) })] }), _jsx("small", { children: form.kind === 'secret' ? '值在 DSH 主机使用 AES-256-GCM 加密，列表和 API 永不回传。' : '普通值会显示在变量列表中。' })] }), form.name && _jsxs("label", { children: [_jsx("span", { children: "\u5F15\u7528\u8BED\u6CD5" }), _jsxs("div", { className: "wf-credential-copy", children: [_jsx("input", { readOnly: true, value: `{{vars.${form.name}}}` }), _jsx("button", { type: "button", onClick: () => void navigator.clipboard.writeText(`{{vars.${form.name}}}`), children: "\u590D\u5236" })] })] })] }), _jsxs("footer", { children: [_jsx("button", { disabled: Boolean(busy), onClick: () => setForm(null), children: "\u53D6\u6D88" }), _jsxs("button", { className: "wf-primary-command", disabled: Boolean(busy) || !form.name.trim() || (!form.id && !form.value), onClick: () => void save(), children: [busy === 'save' ? _jsx(Loader2, { className: "wf-spin", size: 15 }) : _jsx(Braces, { size: 15 }), busy === 'save' ? '保存中' : '保存变量'] })] })] }) })] }));
}

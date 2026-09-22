import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useRef, useState } from 'react';
import { Brackets, Play, X } from 'lucide-react';
import { normalizeWorkflowContract } from '../subworkflowProtocol.js';
import { parseWorkflowContractInput } from '../workflowInputProtocol.js';
function typeHint(field) {
    if (field.description)
        return field.description;
    if (field.type === 'number')
        return '输入数字。';
    if (field.type === 'boolean')
        return '选择是或否。';
    if (field.type === 'object' || field.type === 'array')
        return '输入合法 JSON。';
    if (field.type === 'any')
        return '可输入文本或 JSON。';
    return '输入文本。';
}
export function WorkflowRunInputDialog({ workflowName, fields: sourceFields, published = false, debug = false, onClose, onSubmit, }) {
    const fields = useMemo(() => normalizeWorkflowContract(sourceFields), [sourceFields]);
    const [values, setValues] = useState({});
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const submitRef = useRef(false);
    const submit = async () => {
        if (submitRef.current)
            return;
        submitRef.current = true;
        setSubmitting(true);
        setError('');
        try {
            await onSubmit(parseWorkflowContractInput(fields, values));
            onClose();
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
        finally {
            submitRef.current = false;
            setSubmitting(false);
        }
    };
    return (_jsx("div", { className: "wf-dialog-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-credential-dialog wf-run-input-dialog", role: "dialog", "aria-modal": "true", "aria-label": debug ? '调试工作流' : '运行工作流', children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(Brackets, { size: 17 }), _jsx("strong", { children: debug ? '调试工作流' : '运行工作流' })] }), _jsx("button", { className: "wf-icon-button", type: "button", disabled: submitting, onClick: onClose, "aria-label": "\u5173\u95ED", children: _jsx(X, { size: 17 }) })] }), _jsxs("div", { className: "wf-credential-dialog__body", children: [_jsxs("div", { className: "wf-run-input-dialog__summary", children: [_jsx("strong", { children: workflowName }), _jsx("span", { children: debug ? '使用当前草稿，在断点处暂停' : published ? '使用已发布版本的输入契约' : '使用当前草稿的输入契约' })] }), fields.map((field) => {
                            const label = field.label || field.name;
                            const value = values[field.name] ?? '';
                            const setValue = (next) => setValues((current) => ({ ...current, [field.name]: next }));
                            return (_jsxs("label", { className: "wf-run-input-field", children: [_jsxs("span", { children: [label, field.required && _jsx("b", { children: "\u5FC5\u586B" }), _jsx("code", { children: field.type })] }), field.type === 'boolean' ? (_jsxs("select", { "aria-label": `运行输入 ${label}`, value: value, onChange: (event) => setValue(event.target.value), disabled: submitting, children: [_jsx("option", { value: "", children: "\u672A\u8BBE\u7F6E" }), _jsx("option", { value: "true", children: "\u662F" }), _jsx("option", { value: "false", children: "\u5426" })] })) : field.type === 'object' || field.type === 'array' || field.type === 'any' ? (_jsx("textarea", { "aria-label": `运行输入 ${label}`, rows: field.type === 'any' ? 3 : 5, value: value, onChange: (event) => setValue(event.target.value), disabled: submitting, autoComplete: "off", spellCheck: false })) : (_jsx("input", { "aria-label": `运行输入 ${label}`, type: field.type === 'number' ? 'number' : 'text', inputMode: field.type === 'number' ? 'decimal' : undefined, value: value, onChange: (event) => setValue(event.target.value), disabled: submitting, autoComplete: "off" })), _jsx("small", { children: typeHint(field) })] }, field.name));
                        }), _jsx("p", { className: "wf-run-input-dialog__note", children: "\u8F93\u5165\u53EA\u7528\u4E8E\u672C\u6B21\u8FD0\u884C\u3002\u8BA4\u8BC1\u4FE1\u606F\u8BF7\u4F7F\u7528\u201C\u8FDE\u63A5\u201D\u6216\u9879\u76EE Secret\uFF0C\u4E0D\u8981\u4F5C\u4E3A\u8FD0\u884C\u8F93\u5165\u63D0\u4EA4\u3002" }), error && _jsx("p", { className: "wf-contract-error", role: "alert", children: error })] }), _jsxs("footer", { children: [_jsx("button", { type: "button", disabled: submitting, onClick: onClose, children: "\u53D6\u6D88" }), _jsxs("button", { type: "button", className: "wf-primary-command", disabled: submitting, onClick: () => { void submit(); }, children: [_jsx(Play, { size: 14, fill: "currentColor" }), submitting ? (debug ? '正在启动调试' : '正在运行') : (debug ? '开始调试' : '开始运行')] })] })] }) }));
}

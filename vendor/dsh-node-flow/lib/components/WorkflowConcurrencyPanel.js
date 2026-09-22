import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Gauge, Info, X } from 'lucide-react';
import { normalizeWorkflowConcurrency, validateWorkflowConcurrency } from '../workflowConcurrencyProtocol.js';
import { MAX_WORKFLOW_DURATION_SECONDS, MAX_WORKFLOW_STEPS, validateWorkflowExecutionLimits } from '../workflowExecutionLimits.js';
import { useCanvasStore } from '../store/canvas.js';
const MODES = [
    { value: 'parallel', label: '允许并行', description: '保持兼容行为：每次触发立即执行，不限制同时运行数量。' },
    { value: 'skip', label: '超过上限时跳过', description: '已有运行占满槽位时记录一次“已跳过”，不会重复执行外部副作用。' },
    { value: 'queue', label: '超过上限时排队', description: '按先到先服务持久排队；宿主重启后仍会继续，最多保留指定数量。' },
];
function numberText(value) {
    return String(value);
}
export function WorkflowConcurrencyPanel({ onClose }) {
    const current = useCanvasStore((state) => state.workflowConcurrency);
    const currentLimits = useCanvasStore((state) => state.workflowExecutionLimits);
    const setWorkflowConcurrency = useCanvasStore((state) => state.setWorkflowConcurrency);
    const setWorkflowExecutionLimits = useCanvasStore((state) => state.setWorkflowExecutionLimits);
    const initial = normalizeWorkflowConcurrency(current);
    const [mode, setMode] = useState(initial.mode);
    const [maxConcurrent, setMaxConcurrent] = useState(numberText(initial.maxConcurrent));
    const [maxQueue, setMaxQueue] = useState(numberText(initial.maxQueue));
    const [maxDurationSec, setMaxDurationSec] = useState(currentLimits?.maxDurationSec === undefined ? '' : String(currentLimits.maxDurationSec));
    const [maxSteps, setMaxSteps] = useState(currentLimits?.maxSteps === undefined ? '' : String(currentLimits.maxSteps));
    const [error, setError] = useState('');
    const optionalInteger = (value) => value.trim() ? Number(value) : undefined;
    const save = () => {
        const next = {
            mode,
            maxConcurrent: Number(maxConcurrent),
            maxQueue: Number(maxQueue),
        };
        const nextLimits = maxDurationSec.trim() || maxSteps.trim()
            ? { maxDurationSec: optionalInteger(maxDurationSec), maxSteps: optionalInteger(maxSteps) }
            : undefined;
        try {
            validateWorkflowConcurrency(next);
            validateWorkflowExecutionLimits(nextLimits);
            setWorkflowConcurrency(mode === 'parallel' ? { mode: 'parallel' } : next);
            setWorkflowExecutionLimits(nextLimits);
            onClose();
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    };
    return (_jsx("div", { className: "wf-dialog-backdrop", role: "presentation", onMouseDown: (event) => { if (event.target === event.currentTarget)
            onClose(); }, children: _jsxs("section", { className: "wf-contract-panel wf-concurrency-panel", role: "dialog", "aria-modal": "true", "aria-label": "\u5DE5\u4F5C\u6D41\u8FD0\u884C\u7B56\u7565\u8BBE\u7F6E", children: [_jsxs("header", { className: "wf-contract-panel__head", children: [_jsxs("div", { children: [_jsx("span", { children: _jsx(Gauge, { size: 18 }) }), _jsxs("div", { children: [_jsx("strong", { children: "\u8FD0\u884C\u7B56\u7565" }), _jsx("p", { children: "\u63A7\u5236\u5E76\u53D1\u69FD\u4F4D\uFF0C\u4EE5\u53CA\u5355\u6B21\u8FD0\u884C\u5141\u8BB8\u6D88\u8017\u7684\u65F6\u95F4\u548C\u6B65\u9AA4\u9884\u7B97\u3002" })] })] }), _jsx("button", { type: "button", className: "wf-icon-btn", onClick: onClose, "aria-label": "\u5173\u95ED\u8FD0\u884C\u7B56\u7565\u8BBE\u7F6E", children: _jsx(X, { size: 17 }) })] }), _jsxs("div", { className: "wf-concurrency-panel__body", children: [_jsxs("fieldset", { children: [_jsx("legend", { children: "\u8FBE\u5230\u8FD0\u884C\u4E0A\u9650\u65F6" }), _jsx("div", { className: "wf-concurrency-modes", children: MODES.map((option) => _jsxs("label", { className: mode === option.value ? 'is-selected' : '', children: [_jsx("input", { type: "radio", name: "workflow-concurrency-mode", value: option.value, checked: mode === option.value, onChange: () => setMode(option.value) }), _jsxs("span", { children: [_jsx("strong", { children: option.label }), _jsx("small", { children: option.description })] })] }, option.value)) })] }), mode !== 'parallel' && _jsxs("div", { className: "wf-concurrency-numbers", children: [_jsxs("label", { children: [_jsx("span", { children: "\u6700\u5927\u540C\u65F6\u8FD0\u884C" }), _jsx("input", { "aria-label": "\u6700\u5927\u540C\u65F6\u8FD0\u884C", type: "number", min: "1", max: "20", value: maxConcurrent, onChange: (event) => setMaxConcurrent(event.target.value) }), _jsx("small", { children: "1\u201320\uFF1BWaitpoint \u7B49\u5F85\u671F\u95F4\u4ECD\u5360\u4E00\u4E2A\u69FD\u4F4D\u3002" })] }), mode === 'queue' && _jsxs("label", { children: [_jsx("span", { children: "\u6700\u591A\u6392\u961F\u8FD0\u884C" }), _jsx("input", { "aria-label": "\u6700\u591A\u6392\u961F\u8FD0\u884C", type: "number", min: "0", max: "100", value: maxQueue, onChange: (event) => setMaxQueue(event.target.value) }), _jsx("small", { children: "0\u2013100\uFF1B\u8D85\u51FA\u65F6\u8BB0\u5F55\u201C\u5DF2\u8DF3\u8FC7\u201D\uFF0C\u4E0D\u4F1A\u9759\u9ED8\u4E22\u5F03\u3002" })] })] }), _jsxs("fieldset", { children: [_jsx("legend", { children: "\u5355\u6B21\u8FD0\u884C\u9884\u7B97\uFF08\u53EF\u9009\uFF09" }), _jsxs("div", { className: "wf-concurrency-numbers", children: [_jsxs("label", { children: [_jsx("span", { children: "\u6700\u957F\u8FD0\u884C\u65F6\u95F4\uFF08\u79D2\uFF09" }), _jsx("input", { "aria-label": "\u6700\u957F\u8FD0\u884C\u65F6\u95F4", type: "number", min: "1", max: MAX_WORKFLOW_DURATION_SECONDS, value: maxDurationSec, onChange: (event) => setMaxDurationSec(event.target.value), placeholder: "\u4E0D\u9650" }), _jsxs("small", { children: ["\u6700\u591A ", MAX_WORKFLOW_DURATION_SECONDS, " \u79D2\uFF1B\u8D85\u65F6\u4F1A\u4FDD\u7559\u6062\u590D\u70B9\u3002"] })] }), _jsxs("label", { children: [_jsx("span", { children: "\u6700\u5927\u6267\u884C\u6B65\u6570" }), _jsx("input", { "aria-label": "\u6700\u5927\u6267\u884C\u6B65\u6570", type: "number", min: "1", max: MAX_WORKFLOW_STEPS, value: maxSteps, onChange: (event) => setMaxSteps(event.target.value), placeholder: "\u9ED8\u8BA4\u4E0A\u9650" }), _jsxs("small", { children: ["\u6700\u591A ", MAX_WORKFLOW_STEPS, " \u6B21\u8282\u70B9\u8BBF\u95EE\uFF1B\u5305\u542B\u5FAA\u73AF\u8FED\u4EE3\u3002"] })] })] })] }), _jsxs("p", { className: "wf-concurrency-note", children: [_jsx(Info, { size: 14 }), " \u914D\u7F6E\u968F\u8349\u7A3F\u4FDD\u5B58\uFF1B\u5DF2\u542F\u7528\u7684\u5916\u90E8\u89E6\u53D1\u5668\u4F7F\u7528\u6700\u540E\u4E00\u6B21\u53D1\u5E03\u7684\u914D\u7F6E\u3002\u6392\u961F\u8FD0\u884C\u4FDD\u7559\u63D0\u4EA4\u65F6\u7684\u6D41\u7A0B\u5FEB\u7167\u548C\u9884\u7B97\uFF0C\u8D85\u9650\u540E\u4ECD\u53EF\u4ECE\u5B89\u5168 checkpoint \u6062\u590D\u3002"] }), error && _jsx("p", { className: "wf-concurrency-error", children: error })] }), _jsxs("footer", { className: "wf-contract-panel__foot", children: [_jsx("button", { type: "button", className: "wf-dialog-btn", onClick: onClose, children: "\u53D6\u6D88" }), _jsx("button", { type: "button", className: "wf-dialog-btn wf-dialog-btn--primary", onClick: save, children: "\u4FDD\u5B58\u8BBE\u7F6E" })] })] }) }));
}

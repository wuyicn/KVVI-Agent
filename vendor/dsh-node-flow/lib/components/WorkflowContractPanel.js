import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useRef, useState } from 'react';
import { Brackets, Plus, Trash2, X } from 'lucide-react';
import { normalizeWorkflowContract } from '../subworkflowProtocol.js';
import { useCanvasStore } from '../store/canvas.js';
const VALUE_TYPES = [
    { value: 'any', label: '任意' },
    { value: 'string', label: '文本' },
    { value: 'number', label: '数字' },
    { value: 'boolean', label: '布尔值' },
    { value: 'object', label: '对象' },
    { value: 'array', label: '数组' },
];
function emptyField() {
    return { name: '', type: 'string', required: false };
}
function ContractFields({ title, description, fields, onChange, }) {
    const update = (index, patch) => {
        onChange(fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field));
    };
    return (_jsxs("section", { className: "wf-contract-section", children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx("strong", { children: title }), _jsx("p", { children: description })] }), _jsxs("button", { type: "button", onClick: () => onChange([...fields, emptyField()]), children: [_jsx(Plus, { size: 14 }), "\u6DFB\u52A0\u5B57\u6BB5"] })] }), fields.length === 0 && _jsx("div", { className: "wf-contract-empty", children: "\u672A\u58F0\u660E\u5B57\u6BB5\u65F6\uFF0C\u5C06\u63A5\u53D7\u6216\u8FD4\u56DE\u4EFB\u610F\u503C\u3002" }), _jsx("div", { className: "wf-contract-fields", children: fields.map((field, index) => (_jsxs("article", { className: "wf-contract-field", children: [_jsxs("div", { className: "wf-contract-field__main", children: [_jsxs("label", { children: [_jsx("span", { children: "\u5B57\u6BB5\u540D" }), _jsx("input", { "aria-label": `${title}字段名 ${index + 1}`, value: field.name, placeholder: "\u4F8B\u5982 customerId", onChange: (event) => update(index, { name: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "\u663E\u793A\u540D\u79F0" }), _jsx("input", { "aria-label": `${title}显示名称 ${index + 1}`, value: field.label ?? '', placeholder: "\u53EF\u9009", onChange: (event) => update(index, { label: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "\u7C7B\u578B" }), _jsx("select", { "aria-label": `${title}字段类型 ${index + 1}`, value: field.type, onChange: (event) => update(index, { type: event.target.value }), children: VALUE_TYPES.map((item) => _jsx("option", { value: item.value, children: item.label }, item.value)) })] }), _jsxs("label", { className: "wf-contract-required", children: [_jsx("input", { type: "checkbox", checked: Boolean(field.required), onChange: (event) => update(index, { required: event.target.checked }) }), _jsx("span", { children: "\u5FC5\u586B" })] }), _jsx("button", { type: "button", className: "wf-contract-remove", onClick: () => onChange(fields.filter((_, fieldIndex) => fieldIndex !== index)), "aria-label": `删除${title}字段 ${index + 1}`, children: _jsx(Trash2, { size: 15 }) })] }), _jsx("input", { className: "wf-contract-description", "aria-label": `${title}字段说明 ${index + 1}`, value: field.description ?? '', placeholder: "\u5B57\u6BB5\u8BF4\u660E\uFF08\u53EF\u9009\uFF09", onChange: (event) => update(index, { description: event.target.value }) })] }, index))) })] }));
}
export function WorkflowContractPanel({ onClose }) {
    const workflowInputs = useCanvasStore((state) => state.workflowInputs);
    const workflowOutputs = useCanvasStore((state) => state.workflowOutputs);
    const setWorkflowContract = useCanvasStore((state) => state.setWorkflowContract);
    const actionRef = useRef(false);
    const [inputs, setInputs] = useState(() => structuredClone(workflowInputs));
    const [outputs, setOutputs] = useState(() => structuredClone(workflowOutputs));
    const [error, setError] = useState('');
    const duplicateNames = useMemo(() => {
        const duplicates = (fields) => {
            const names = fields.map((field) => field.name.trim()).filter(Boolean);
            return names.filter((name, index) => names.indexOf(name) !== index);
        };
        return [...duplicates(inputs), ...duplicates(outputs)];
    }, [inputs, outputs]);
    const save = () => {
        if (actionRef.current)
            return;
        actionRef.current = true;
        const invalid = [...inputs, ...outputs].find((field) => field.name.trim() && !/^[A-Za-z_$][\w$]*$/.test(field.name.trim()));
        if (invalid) {
            setError(`字段名“${invalid.name}”无效，只能使用字母、数字、下划线和 $，且不能以数字开头。`);
            actionRef.current = false;
            return;
        }
        if (duplicateNames.length > 0) {
            setError(`字段名“${duplicateNames[0]}”重复。`);
            actionRef.current = false;
            return;
        }
        setWorkflowContract(normalizeWorkflowContract(inputs), normalizeWorkflowContract(outputs));
        onClose();
    };
    return (_jsx("div", { className: "wf-dialog-backdrop", role: "presentation", children: _jsxs("section", { className: "wf-contract-dialog", role: "dialog", "aria-modal": "true", "aria-label": "\u5DE5\u4F5C\u6D41\u8F93\u5165\u8F93\u51FA\u5951\u7EA6", children: [_jsxs("header", { children: [_jsx("span", { children: _jsx(Brackets, { size: 18 }) }), _jsxs("div", { children: [_jsx("strong", { children: "\u8F93\u5165 / \u8F93\u51FA\u5951\u7EA6" }), _jsx("p", { children: "\u58F0\u660E\u4F9B\u201C\u8C03\u7528\u5DE5\u4F5C\u6D41\u201D\u8282\u70B9\u6821\u9A8C\u548C\u6620\u5C04\u7684\u7ED3\u6784\u5316\u5B57\u6BB5\u3002" })] }), _jsx("button", { className: "wf-icon-btn", onClick: onClose, "aria-label": "\u5173\u95ED\u8F93\u5165\u8F93\u51FA\u5951\u7EA6", children: _jsx(X, { size: 17 }) })] }), _jsxs("div", { className: "wf-contract-dialog__body", children: [_jsx(ContractFields, { title: "\u8F93\u5165", description: "\u7236\u5DE5\u4F5C\u6D41\u8C03\u7528\u65F6\u4F20\u5165\u7684 JSON \u5BF9\u8C61\u3002", fields: inputs, onChange: setInputs }), _jsx(ContractFields, { title: "\u8F93\u51FA", description: "\u672C\u5DE5\u4F5C\u6D41\u6700\u7EC8\u7ED3\u679C\u5E94\u6EE1\u8DB3\u7684 JSON \u5BF9\u8C61\u3002", fields: outputs, onChange: setOutputs }), error && _jsx("p", { className: "wf-contract-error", role: "alert", children: error })] }), _jsxs("footer", { children: [_jsx("button", { className: "wf-dialog-btn", onClick: onClose, children: "\u53D6\u6D88" }), _jsx("button", { className: "wf-dialog-btn wf-dialog-btn--primary", onClick: save, children: "\u4FDD\u5B58\u5951\u7EA6" })] })] }) }));
}

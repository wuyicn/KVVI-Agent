import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from 'react';
import { Braces, Search, X } from 'lucide-react';
import { parseResultValue, resultPathExpression } from '../resultExpression.js';
function valueType(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return `array(${value.length})`;
    return typeof value;
}
function previewValue(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'string')
        return value.length > 70 ? `${value.slice(0, 67)}…` : value;
    if (typeof value === 'object') {
        const text = JSON.stringify(value);
        return text.length > 70 ? `${text.slice(0, 67)}…` : text;
    }
    return String(value);
}
function pathExpression(namespace, path) {
    let expression = namespace;
    for (const key of path) {
        if (typeof key === 'number')
            expression += `[${key}]`;
        else if (/^[A-Za-z_$][\w$]*$/.test(key))
            expression += `.${key}`;
        else
            expression += `[${JSON.stringify(key)}]`;
    }
    return expression;
}
function flattenValue(value, namespace) {
    const parsed = parseResultValue(value);
    const entries = [];
    const seen = new WeakSet();
    const visit = (current, path, depth) => {
        if (entries.length >= 200 || depth > 6)
            return;
        if (namespace === 'result' || path.length > 0)
            entries.push({ path, expression: namespace === 'result' ? resultPathExpression(path) : pathExpression(namespace, path), type: valueType(current), preview: previewValue(current), depth });
        if (!current || typeof current !== 'object')
            return;
        if (seen.has(current))
            return;
        seen.add(current);
        const children = Array.isArray(current)
            ? current.slice(0, 20).map((child, index) => [index, child])
            : Object.entries(current).slice(0, 100);
        for (const [key, child] of children)
            visit(child, [...path, key], depth + 1);
    };
    visit(parsed, [], 0);
    return entries;
}
export function FieldMapper({ targetLabel, mode, sources, onInsert, onClose, }) {
    const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
    const [query, setQuery] = useState('');
    useEffect(() => {
        if (!sources.some((source) => source.id === sourceId))
            setSourceId(sources[0]?.id ?? '');
    }, [sourceId, sources]);
    const source = sources.find((candidate) => candidate.id === sourceId) ?? sources[0];
    const fields = useMemo(() => source ? flattenValue(source.value, source.namespace ?? 'result') : [], [source]);
    const normalizedQuery = query.trim().toLowerCase();
    const visibleFields = normalizedQuery
        ? fields.filter((field) => `${field.expression} ${field.type} ${field.preview}`.toLowerCase().includes(normalizedQuery))
        : fields;
    return (_jsxs("div", { className: "wf-mapper", "aria-label": "\u5B57\u6BB5\u6620\u5C04\u5668", children: [_jsxs("header", { className: "wf-mapper__head", children: [_jsxs("div", { children: [_jsx(Braces, { size: 17 }), _jsxs("span", { children: [_jsx("strong", { children: "\u5B57\u6BB5\u6620\u5C04" }), _jsxs("small", { children: ["\u63D2\u5165\u5230\u300C", targetLabel, "\u300D"] })] })] }), _jsx("button", { type: "button", className: "wf-icon-btn", onClick: onClose, "aria-label": "\u5173\u95ED\u5B57\u6BB5\u6620\u5C04\u5668", children: _jsx(X, { size: 16 }) })] }), _jsxs("div", { className: "wf-mapper__body", children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u6837\u672C\u6765\u6E90" }), _jsxs("select", { value: source?.id ?? '', onChange: (event) => setSourceId(event.target.value), disabled: sources.length === 0, children: [sources.length === 0 && _jsx("option", { value: "", children: "\u6682\u65E0\u6837\u672C" }), sources.map((candidate) => _jsx("option", { value: candidate.id, children: candidate.label }, candidate.id))] })] }), source && _jsx("p", { className: "wf-mapper__source-note", children: source.detail }), _jsxs("label", { className: "wf-mapper__search", children: [_jsx(Search, { size: 14 }), _jsx("input", { value: query, onChange: (event) => setQuery(event.target.value), placeholder: "\u641C\u7D22\u5B57\u6BB5\u540D\u6216\u503C" })] }), _jsx("p", { className: "wf-mapper__hint", children: source?.namespace === 'vars' ? _jsxs(_Fragment, { children: ["\u8FD0\u884C\u65F6\u4ECE\u4E3B\u673A\u53D8\u91CF\u5E93\u8BFB\u53D6 ", _jsx("code", { children: "vars" }), "\uFF1BSecret \u4EC5\u663E\u793A\u5360\u4F4D\u7B26\uFF0C\u4E0D\u4F1A\u53D1\u9001\u5230\u6D4F\u89C8\u5668\u3002"] }) : _jsxs(_Fragment, { children: ["\u8FD0\u884C\u65F6\u8BFB\u53D6\u5F53\u524D\u8282\u70B9\u6536\u5230\u7684 ", _jsx("code", { children: "result" }), "\uFF1B\u8FD9\u91CC\u7684\u5386\u53F2\u8F93\u51FA\u53EA\u7528\u4E8E\u9884\u89C8\u7ED3\u6784\u3002"] }) }), visibleFields.length > 0 ? (_jsx("div", { className: "wf-mapper__fields", children: visibleFields.map((field) => {
                            const text = mode === 'template' ? `{{${field.expression}}}` : field.expression;
                            return (_jsxs("button", { type: "button", className: "wf-mapper-field", draggable: true, onDragStart: (event) => { event.dataTransfer.setData('text/plain', text); event.dataTransfer.effectAllowed = 'copy'; }, onClick: () => onInsert(text), title: `点击或拖拽插入 ${text}`, children: [_jsx("span", { className: "wf-mapper-field__path", style: { paddingLeft: `${field.depth * 12}px` }, children: field.expression }), _jsx("small", { children: field.type }), _jsx("em", { children: field.preview })] }, field.expression));
                        }) })) : (_jsxs("div", { className: "wf-mapper__empty", children: [_jsx(Braces, { size: 22 }), _jsx("strong", { children: "\u8FD8\u6CA1\u6709\u7ED3\u6784\u5316\u6837\u672C" }), _jsx("span", { children: "\u5148\u6D4B\u8BD5\u4E0A\u6E38\u8282\u70B9\uFF0C\u8FD0\u884C\u4E00\u6B21\u5DE5\u4F5C\u6D41\uFF0C\u6216\u5728\u201C\u6D4B\u8BD5\u8F93\u5165\u201D\u4E2D\u7C98\u8D34 JSON\u3002" })] }))] })] }));
}

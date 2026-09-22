import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Inspector panel for the selected node — edits kind-specific fields.
 *
 * @module components/Inspector
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Braces, Check, Copy, Loader2, Play, RotateCw, Settings2, Trash2, X } from 'lucide-react';
import { useCanvasStore } from '../store/canvas.js';
import { CodeEditor } from './CodeEditor.js';
import { CodeEditorModal } from './CodeEditorModal.js';
import expandArrowsIcon from '../assets/icons/expand-arrows-alt.svg';
import { createWebhookToken } from '../model.js';
import { NodeGlyph } from './nodeCatalog.js';
import { FieldMapper } from './FieldMapper.js';
import { readWorkflowSamples, saveWorkflowNodeSample } from '../sampleStore.js';
import { listSavedWorkflows, listWorkflowRuns } from '../workflowRepository.js';
function formatPollingTime(value) {
    if (!value)
        return '暂无';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '暂无' : date.toLocaleString();
}
/** Short deterministic hash so one schedule node can host several cron times. */
function hashCron(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
}
const KIND_LABELS = {
    trigger: 'Trigger',
    webhook: 'Webhook',
    schedule: 'Schedule',
    'connector-trigger': 'App Trigger',
    agent: 'Sub-agent',
    'call-workflow': 'Call Workflow',
    connector: 'App Connector',
    'data-store': 'Data Store',
    wait: 'Wait',
    if: 'If',
    switch: 'Switch',
    loop: 'Loop',
    while: 'While',
    code: 'Code',
    http: 'HTTP Request',
    output: 'Output',
    note: 'Note',
};
function RetryFields({ data, onChange }) {
    return (_jsxs("fieldset", { className: "wf-retry-fields", children: [_jsx("legend", { children: "\u5931\u8D25\u91CD\u8BD5" }), _jsxs("div", { className: "wf-field-row", children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u91CD\u8BD5\u6B21\u6570" }), _jsx("input", { type: "number", min: "0", max: "10", value: data.retryCount ?? '0', onChange: (event) => onChange({ retryCount: event.target.value }) })] }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u95F4\u9694\uFF08\u79D2\uFF09" }), _jsx("input", { type: "number", min: "0", step: "0.5", value: data.retryDelay ?? '1', onChange: (event) => onChange({ retryDelay: event.target.value }) })] })] }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u9000\u907F\u7B56\u7565" }), _jsxs("select", { value: data.retryBackoff ?? 'fixed', onChange: (event) => onChange({ retryBackoff: event.target.value }), children: [_jsx("option", { value: "fixed", children: "\u56FA\u5B9A\u95F4\u9694" }), _jsx("option", { value: "exponential", children: "\u6307\u6570\u9000\u907F" })] })] }), _jsx("p", { className: "wf-field-note", children: "\u91CD\u8BD5\u6B21\u6570\u4E0D\u542B\u9996\u6B21\u6267\u884C\uFF1B\u6307\u6570\u9000\u907F\u4F1A\u6309 1\u00D7\u30012\u00D7\u30014\u00D7 \u589E\u52A0\u7B49\u5F85\u65F6\u95F4\u3002" })] }));
}
function FailureBehaviorField({ data, inactiveErrorEdges = false, missingErrorRoute = false, onChange }) {
    return (_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5931\u8D25\u65F6\u884C\u4E3A" }), _jsxs("select", { value: data.onError ?? 'stop', onChange: (event) => onChange({ onError: event.target.value }), children: [_jsx("option", { value: "stop", children: "\u505C\u6B62\u5206\u652F" }), _jsx("option", { value: "continue", children: "\u7EE7\u7EED\u7528\u7A7A\u503C" }), _jsx("option", { value: "route", children: "\u8DEF\u7531\u5230\u9519\u8BEF\u5206\u652F" })] }), data.onError === 'route' && _jsxs("small", { className: "wf-field-hint", children: ["\u4ECE\u8282\u70B9\u53F3\u4FA7\u7EA2\u8272 ", _jsx("code", { children: "error" }), " \u7AEF\u53E3\u8FDE\u5230\u5904\u7406\u8282\u70B9\u3002\u4E0B\u6E38\u6536\u5230\u8131\u654F\u7684\u9519\u8BEF\u4E8B\u4EF6\uFF0C\u4E0D\u5305\u542B\u8F93\u5165\u3001\u5BC6\u94A5\u6216\u54CD\u5E94\u4F53\u3002"] }), missingErrorRoute && _jsxs("small", { className: "wf-field-hint is-error", children: ["\u8FD8\u6CA1\u6709\u8FDE\u63A5\u7EA2\u8272 ", _jsx("code", { children: "error" }), " \u7AEF\u53E3\uFF1B\u8FD0\u884C\u6216\u53D1\u5E03\u4F1A\u88AB\u62D2\u7EDD\u3002"] }), inactiveErrorEdges && _jsx("small", { className: "wf-field-hint is-error", children: "\u8BE5\u8282\u70B9\u4FDD\u7559\u4E86 error \u8FDE\u7EBF\uFF0C\u4F46\u5F53\u524D\u7B56\u7565\u4E0D\u4F1A\u6267\u884C\u5B83\uFF1B\u5207\u6362\u56DE\u201C\u8DEF\u7531\u5230\u9519\u8BEF\u5206\u652F\u201D\u540E\u624D\u4F1A\u542F\u7528\u3002" })] }));
}
function MappedField({ label, value, onChange, onOpenMapper, mode, multiline = false, rows = 3, placeholder, required = false, list, }) {
    const fieldRef = useRef(null);
    const valueRef = useRef(value);
    const selectionRef = useRef({ start: value.length, end: value.length });
    valueRef.current = value;
    const rememberSelection = () => {
        const field = fieldRef.current;
        if (!field || document.activeElement !== field)
            return;
        selectionRef.current = {
            start: field.selectionStart ?? valueRef.current.length,
            end: field.selectionEnd ?? valueRef.current.length,
        };
    };
    const insert = (text) => {
        const current = valueRef.current;
        const start = Math.min(selectionRef.current.start, current.length);
        const end = Math.min(selectionRef.current.end, current.length);
        const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
        const caret = start + text.length;
        valueRef.current = next;
        selectionRef.current = { start: caret, end: caret };
        onChange(next);
        window.requestAnimationFrame(() => {
            fieldRef.current?.focus();
            fieldRef.current?.setSelectionRange(caret, caret);
        });
    };
    const shared = {
        'aria-label': label,
        value,
        placeholder,
        required,
        list,
        onChange: (event) => {
            valueRef.current = event.target.value;
            selectionRef.current = {
                start: event.target.selectionStart ?? event.target.value.length,
                end: event.target.selectionEnd ?? event.target.value.length,
            };
            onChange(event.target.value);
        },
        onSelect: rememberSelection,
        onKeyUp: rememberSelection,
        onClick: rememberSelection,
        onDragOver: (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; },
        onDrop: (event) => { event.preventDefault(); insert(event.dataTransfer.getData('text/plain')); },
    };
    return (_jsxs("div", { className: "wf-field wf-field--mapped", children: [_jsxs("span", { className: "wf-field__mapped-title", children: [_jsxs("span", { children: [label, required ? ' *' : ''] }), _jsxs("button", { type: "button", "aria-label": `映射${label}字段`, onClick: () => { rememberSelection(); onOpenMapper({ label, mode, insert }); }, title: "\u4ECE\u6837\u672C\u6570\u636E\u63D2\u5165\u5B57\u6BB5", children: [_jsx(Braces, { size: 13 }), " \u6620\u5C04"] })] }), multiline ? _jsx("textarea", { ref: (element) => { fieldRef.current = element; }, ...shared, rows: rows }) : _jsx("input", { ref: (element) => { fieldRef.current = element; }, ...shared })] }));
}
function ConnectorParameterField({ field, value, mapped, dynamic, dynamicKey, onChange, onLoadOptions, onOpenMapper, }) {
    if (field.type === 'boolean')
        return _jsxs("label", { className: "wf-field wf-field--checkbox", children: [_jsx("input", { "aria-label": field.label, type: "checkbox", checked: ['true', '1', 'yes', 'on'].includes(value.toLowerCase()), onChange: (event) => onChange(String(event.target.checked)) }), _jsx("span", { children: field.label })] });
    if (field.type === 'select' && !field.dynamicOptions)
        return _jsxs("label", { className: "wf-field", children: [_jsxs("span", { children: [field.label, field.required ? ' *' : ''] }), _jsx("select", { "aria-label": field.label, value: value, onChange: (event) => onChange(event.target.value), children: field.options?.map((option) => _jsx("option", { value: option.value, children: option.label }, option.value)) }), field.description && _jsx("small", { className: "wf-field-hint", children: field.description })] });
    const listId = field.dynamicOptions ? `wf-connector-options-${dynamicKey.replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined;
    return _jsxs("div", { className: "wf-connector-parameter", children: [mapped
                ? _jsx(MappedField, { label: field.label, required: field.required, multiline: field.type === 'textarea' || field.type === 'json', rows: field.type === 'json' ? 5 : 3, mode: "template", placeholder: field.placeholder, value: value, list: listId, onChange: onChange, onOpenMapper: onOpenMapper })
                : _jsxs("label", { className: "wf-field", children: [_jsxs("span", { children: [field.label, field.required ? ' *' : ''] }), field.type === 'textarea' || field.type === 'json' ? _jsx("textarea", { "aria-label": field.label, rows: field.type === 'json' ? 5 : 3, placeholder: field.placeholder, value: value, onChange: (event) => onChange(event.target.value) }) : _jsx("input", { "aria-label": field.label, list: listId, type: field.type === 'number' ? 'number' : 'text', min: field.min, max: field.max, placeholder: field.placeholder, value: value, onChange: (event) => onChange(event.target.value) })] }), listId && _jsx("datalist", { id: listId, children: dynamic?.options.map((option) => _jsx("option", { value: option.value, label: option.label }, option.value)) }), field.dynamicOptions && _jsxs("div", { className: "wf-connector-options", children: [_jsxs("button", { type: "button", "aria-label": `加载${field.label}选项`, disabled: dynamic?.loading, onClick: onLoadOptions, children: [dynamic?.loading ? _jsx(Loader2, { className: "wf-spin", size: 12 }) : _jsx(RotateCw, { size: 12 }), dynamic?.loading ? '加载中' : dynamic?.options.length ? '刷新选项' : '加载选项'] }), dynamic?.options.length ? _jsxs("small", { children: [dynamic.options.length, " \u4E2A\u53EF\u7528\u9009\u9879"] }) : null, dynamic?.error && _jsx("small", { className: "is-error", children: dynamic.error })] }), field.description && _jsx("small", { className: "wf-field-hint", children: field.description })] });
}
export function Inspector({ workflowId }) {
    const selectedId = useCanvasStore((s) => s.selectedId);
    const nodes = useCanvasStore((s) => s.nodes);
    const edges = useCanvasStore((s) => s.edges);
    const node = useCanvasStore((s) => s.nodes.find((n) => n.id === s.selectedId));
    const updateNodeData = useCanvasStore((s) => s.updateNodeData);
    const removeNode = useCanvasStore((s) => s.removeNode);
    const select = useCanvasStore((s) => s.select);
    const [codeExpanded, setCodeExpanded] = useState(false);
    const [agentModels, setAgentModels] = useState([]);
    const [credentials, setCredentials] = useState([]);
    const [projectVariables, setProjectVariables] = useState([]);
    const [connectors, setConnectors] = useState([]);
    const [activeTab, setActiveTab] = useState('config');
    const [testInput, setTestInput] = useState('');
    const [testing, setTesting] = useState(false);
    const [copied, setCopied] = useState(false);
    const [workflowRuns, setWorkflowRuns] = useState([]);
    const [availableWorkflows, setAvailableWorkflows] = useState([]);
    const [, setSampleRevision] = useState(0);
    const [mappingTarget, setMappingTarget] = useState(null);
    const [pollingTrigger, setPollingTrigger] = useState(null);
    const [pollingBusy, setPollingBusy] = useState(false);
    const [dynamicOptions, setDynamicOptions] = useState({});
    // Load the available model routes once (for the agent-node model dropdown).
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await fetch('/dsh-node-flow/models', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{}',
                });
                const data = (await res.json().catch(() => ({})));
                if (!cancelled)
                    setAgentModels(Array.isArray(data.models) ? data.models : []);
            }
            catch {
                if (!cancelled)
                    setAgentModels([]);
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, []);
    useEffect(() => {
        let cancelled = false;
        void fetch('/dsh-node-flow/connectors', { cache: 'no-store' })
            .then(async (response) => response.ok ? response.json() : { connectors: [] })
            .then((data) => { if (!cancelled)
            setConnectors(Array.isArray(data.connectors) ? data.connectors : []); })
            .catch(() => { if (!cancelled)
            setConnectors([]); });
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        let cancelled = false;
        void fetch('/dsh-node-flow/credentials', { cache: 'no-store' })
            .then(async (response) => response.ok ? response.json() : { credentials: [] })
            .then((data) => { if (!cancelled)
            setCredentials(Array.isArray(data.credentials) ? data.credentials : []); })
            .catch(() => { if (!cancelled)
            setCredentials([]); });
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        let cancelled = false;
        void fetch('/dsh-node-flow/project-variables', { cache: 'no-store' })
            .then(async (response) => response.ok ? response.json() : { variables: [] })
            .then((data) => { if (!cancelled)
            setProjectVariables(Array.isArray(data.variables) ? data.variables : []); })
            .catch(() => { if (!cancelled)
            setProjectVariables([]); });
        return () => { cancelled = true; };
    }, []);
    useLayoutEffect(() => {
        setActiveTab('config');
        setTestInput('');
        setCopied(false);
        setMappingTarget(null);
        setDynamicOptions({});
    }, [selectedId]);
    useEffect(() => {
        let cancelled = false;
        void Promise.all([listWorkflowRuns(), listSavedWorkflows()])
            .then(([runs, workflows]) => {
            if (cancelled)
                return;
            setWorkflowRuns(runs);
            setAvailableWorkflows(workflows);
        })
            .catch(() => {
            if (cancelled)
                return;
            setWorkflowRuns([]);
            setAvailableWorkflows([]);
        });
        return () => { cancelled = true; };
    }, [workflowId]);
    const pollingId = workflowId && node?.data.kind === 'connector-trigger' ? `workflow:${workflowId}:${node.id}` : undefined;
    useEffect(() => {
        setPollingTrigger(null);
        if (!pollingId)
            return;
        let cancelled = false;
        const load = () => {
            void fetch('/dsh-node-flow/polling-triggers', { cache: 'no-store' })
                .then(async (response) => response.ok ? response.json() : { triggers: [] })
                .then((data) => {
                if (!cancelled)
                    setPollingTrigger((data.triggers ?? []).find((trigger) => trigger.id === pollingId) ?? null);
            })
                .catch(() => { if (!cancelled)
                setPollingTrigger(null); });
        };
        load();
        const timer = window.setInterval(load, 5000);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [pollingId]);
    if (!node) {
        return (_jsx("aside", { className: "wf-inspector wf-inspector--empty", children: _jsx("p", { children: "Select a node to configure it." }) }));
    }
    const d = node.data;
    const errorEdges = edges.filter((edge) => edge.source === node.id && edge.sourceHandle === 'error');
    const inactiveErrorEdges = d.onError !== 'route' && errorEdges.length > 0;
    const missingErrorRoute = d.onError === 'route' && errorEdges.length === 0;
    const connectorVersions = connectors.filter((connector) => connector.id === d.connectorId).sort((left, right) => right.version - left.version);
    const selectedConnector = d.connectorVersion === undefined ? connectorVersions[0] : connectorVersions.find((connector) => connector.version === d.connectorVersion);
    const latestConnector = connectorVersions[0];
    const latestConnectors = connectors.filter((connector, index, values) => !values.some((candidate, candidateIndex) => candidateIndex !== index && candidate.id === connector.id && candidate.version > connector.version));
    const selectedConnectorAction = selectedConnector?.actions.find((action) => action.id === d.connectorAction);
    const selectedConnectorTrigger = selectedConnector?.triggers?.find((trigger) => trigger.id === d.connectorTrigger);
    const connectorCredentialCompatible = (connector, credential) => connector.credentialKinds.includes(credential.kind)
        && (credential.kind !== 'api-key' || !connector.credentialHeaderName || credential.headerName?.toLowerCase() === connector.credentialHeaderName.toLowerCase());
    const defaultConnectorParams = (fields) => Object.fromEntries(fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue]));
    const compatibleConnectorParams = (fields) => Object.fromEntries(fields.flatMap((field) => Object.prototype.hasOwnProperty.call(d.connectorParams ?? {}, field.id) ? [[field.id, d.connectorParams?.[field.id] ?? '']] : field.defaultValue !== undefined ? [[field.id, field.defaultValue]] : []));
    const setConnectorParam = (fieldId, value) => updateNodeData(node.id, { connectorParams: { ...(d.connectorParams ?? {}), [fieldId]: value }, lastRun: undefined });
    const dynamicOptionsKey = (field) => `${node.id}:${d.connectorId ?? ''}@${d.connectorVersion ?? 'latest'}:${d.connectorAction ?? d.connectorTrigger ?? ''}:${d.credentialId ?? ''}:${field.id}:${JSON.stringify((field.dynamicOptions?.dependsOn ?? []).map((id) => d.connectorParams?.[id] ?? ''))}`;
    const loadDynamicOptions = async (fieldId, stateKey) => {
        const current = useCanvasStore.getState().nodes.find((candidate) => candidate.id === node.id);
        if (!current || dynamicOptions[stateKey]?.loading)
            return;
        setDynamicOptions((state) => ({ ...state, [stateKey]: { options: state[stateKey]?.options ?? [], loading: true } }));
        try {
            const response = await fetch('/dsh-node-flow/connectors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node: { ...current, data: { ...current.data, lastRun: undefined } }, fieldId }) });
            const data = await response.json().catch(() => ({}));
            if (!response.ok)
                throw new Error(data.error || `HTTP ${response.status}`);
            setDynamicOptions((state) => ({ ...state, [stateKey]: { options: Array.isArray(data.options) ? data.options : [] } }));
        }
        catch (error) {
            setDynamicOptions((state) => ({ ...state, [stateKey]: { options: state[stateKey]?.options ?? [], error: error instanceof Error ? error.message : String(error) } }));
        }
    };
    const pollNow = async () => {
        if (!pollingId || pollingBusy)
            return;
        setPollingBusy(true);
        try {
            const response = await fetch('/dsh-node-flow/polling-triggers', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'poll', id: pollingId }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok)
                throw new Error(data.error || `HTTP ${response.status}`);
            setPollingTrigger(data.trigger ?? null);
        }
        catch (error) {
            alert(error instanceof Error ? error.message : String(error));
        }
        finally {
            setPollingBusy(false);
        }
    };
    const upstreamNodeIds = (() => {
        const ordered = [];
        const seen = new Set([node.id]);
        let frontier = edges.filter((edge) => edge.target === node.id).map((edge) => edge.source);
        while (frontier.length > 0) {
            const next = [];
            for (const id of frontier) {
                if (seen.has(id))
                    continue;
                seen.add(id);
                ordered.push(id);
                for (const edge of edges)
                    if (edge.target === id)
                        next.push(edge.source);
            }
            frontier = next;
        }
        return ordered;
    })();
    const mappingSources = (() => {
        const sources = [];
        if (projectVariables.length > 0) {
            sources.push({
                id: 'project-variables',
                label: '项目变量',
                detail: '普通变量显示当前值；Secret 只显示名称和占位符，实际值仅在 DSH 主机运行时解析。',
                namespace: 'vars',
                value: Object.fromEntries(projectVariables.map((variable) => [variable.name, variable.kind === 'secret' ? '[secret]' : variable.value ?? ''])),
            });
        }
        const samples = readWorkflowSamples(workflowId ?? 'standalone');
        if (testInput.trim())
            sources.push({ id: 'test-input', label: '当前测试输入', detail: '正在编辑的测试输入，适合先粘贴一份 JSON 样本再映射。', value: testInput });
        if (d.lastRun?.input !== undefined && d.lastRun.input !== '') {
            sources.push({ id: 'latest-input', label: '当前节点最近输入', detail: `当前节点最近一次执行收到的输入 · ${d.lastRun.at}`, value: d.lastRun.input });
        }
        const currentSample = samples[node.id];
        if (currentSample?.input !== undefined && currentSample.input !== '') {
            sources.push({ id: `sample-input:${node.id}`, label: '当前节点 · 已保存输入', detail: `保存在本机的节点测试输入 · ${new Date(currentSample.at).toLocaleString()}`, value: currentSample.input });
        }
        const currentHistory = workflowRuns
            .filter((run) => !workflowId || run.workflowId === workflowId)
            .flatMap((run) => run.nodes.filter((runNode) => runNode.id === node.id && runNode.input !== undefined).map((runNode) => ({ run, runNode })))
            .slice(0, 3);
        for (const { run, runNode } of currentHistory) {
            sources.push({ id: `run-input:${run.id}:${node.id}`, label: `${d.label} · 历史输入`, detail: `${new Date(run.startedAt).toLocaleString()} · ${run.status}`, value: runNode.input });
        }
        for (const upstreamId of upstreamNodeIds) {
            const upstream = nodes.find((candidate) => candidate.id === upstreamId);
            if (!upstream)
                continue;
            if (upstream.data.lastRun?.value !== undefined) {
                sources.push({ id: `live:${upstreamId}`, label: `${upstream.data.label} · 当前会话`, detail: `画布中最近一次运行输出 · ${upstream.data.lastRun.at}`, value: upstream.data.lastRun.value });
            }
            const cached = samples[upstreamId];
            if (cached?.output !== undefined) {
                sources.push({ id: `sample:${upstreamId}`, label: `${upstream.data.label} · 测试样本`, detail: `保存在本机的节点测试输出 · ${new Date(cached.at).toLocaleString()}`, value: cached.output });
            }
            const historical = workflowRuns
                .filter((run) => !workflowId || run.workflowId === workflowId)
                .flatMap((run) => run.nodes.filter((runNode) => runNode.id === upstreamId && runNode.output !== undefined).map((runNode) => ({ run, runNode })))
                .slice(0, 3);
            for (const { run, runNode } of historical) {
                sources.push({ id: `run:${run.id}:${upstreamId}`, label: `${upstream.data.label} · 历史运行`, detail: `${new Date(run.startedAt).toLocaleString()} · ${run.status}`, value: runNode.output });
            }
        }
        return sources;
    })();
    const testNode = async () => {
        if (testing)
            return;
        setTesting(true);
        const startedAt = performance.now();
        updateNodeData(node.id, { lastRun: { input: testInput, logs: [], at: new Date().toLocaleTimeString(), running: true } });
        try {
            const current = useCanvasStore.getState().nodes.find((candidate) => candidate.id === node.id);
            if (!current)
                throw new Error('节点不存在');
            const response = await fetch('/dsh-node-flow/node-test', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ node: { ...current, data: { ...current.data, lastRun: undefined } }, input: testInput, workflowId }),
            });
            const data = await response.json();
            const result = data.node;
            updateNodeData(node.id, {
                lastRun: {
                    input: testInput,
                    logs: result?.logs ?? [],
                    value: result?.output,
                    error: result?.error || (!response.ok ? data.error || `HTTP ${response.status}` : undefined),
                    attempts: result?.attempts,
                    childRunId: result?.childRunId,
                    at: new Date().toLocaleTimeString(),
                    duration: result?.ms ?? Math.round(performance.now() - startedAt),
                },
            });
            saveWorkflowNodeSample(workflowId ?? 'standalone', node.id, { input: testInput, output: result?.output, at: new Date().toISOString() });
            setSampleRevision((revision) => revision + 1);
        }
        catch (error) {
            updateNodeData(node.id, { lastRun: { input: testInput, logs: [], error: error instanceof Error ? error.message : String(error), at: new Date().toLocaleTimeString(), duration: Math.round(performance.now() - startedAt) } });
        }
        finally {
            setTesting(false);
            setActiveTab('output');
        }
    };
    const webhookUrl = d.kind === 'webhook' && d.webhookToken
        ? `${window.location.origin}/dsh-node-flow/webhook?token=${encodeURIComponent(d.webhookToken)}`
        : '';
    const copyWebhookUrl = async () => {
        let success = false;
        try {
            await navigator.clipboard.writeText(webhookUrl);
            success = true;
        }
        catch {
            const field = document.createElement('textarea');
            field.value = webhookUrl;
            field.style.position = 'fixed';
            field.style.opacity = '0';
            document.body.appendChild(field);
            field.select();
            success = document.execCommand('copy');
            field.remove();
        }
        if (success) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        }
    };
    const saveSchedule = async () => {
        if (!d.cron?.trim()) {
            alert('请先填写 Cron 表达式（例如 30 7 * * *）');
            return;
        }
        try {
            const store = useCanvasStore.getState();
            const steps = store.toSteps();
            const doc = store.exportDocument();
            const res = await fetch('/dsh-node-flow/schedule', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    id: workflowId ? `workflow:${workflowId}:${node.id}` : `wf-${node.id}-${hashCron(d.cron)}`,
                    workflowId,
                    name: doc.name || 'scheduled workflow',
                    cron: d.cron,
                    timezone: d.timezone?.trim() || undefined,
                    input: d.text ?? '',
                    steps,
                    doc,
                }),
            });
            const data = (await res.json().catch(() => ({})));
            if (!res.ok)
                alert(data.error ?? '保存计划失败');
        }
        catch (err) {
            alert(err instanceof Error ? err.message : String(err));
        }
    };
    return (_jsxs("aside", { className: "wf-inspector", children: [_jsxs("header", { className: "wf-inspector__head", children: [_jsx(NodeGlyph, { kind: d.kind, size: 34, iconSize: 17 }), _jsxs("div", { children: [_jsx("strong", { children: d.label }), _jsx("span", { children: KIND_LABELS[d.kind] })] }), _jsx("button", { className: "wf-icon-btn wf-icon-btn--danger", onClick: () => removeNode(node.id), title: "\u5220\u9664\u8282\u70B9", "aria-label": "\u5220\u9664\u8282\u70B9", children: _jsx(Trash2, { size: 16 }) }), _jsx("button", { className: "wf-icon-btn", onClick: () => select(null), title: "\u5173\u95ED\u68C0\u67E5\u5668", "aria-label": "\u5173\u95ED\u68C0\u67E5\u5668", children: _jsx(X, { size: 17 }) })] }), _jsxs("div", { className: "wf-inspector__tabs", role: "tablist", "aria-label": "\u8282\u70B9\u8BE6\u60C5", children: [_jsxs("button", { className: activeTab === 'config' ? 'is-active' : '', onClick: () => setActiveTab('config'), role: "tab", "aria-selected": activeTab === 'config', children: [_jsx(Settings2, { size: 15 }), " \u914D\u7F6E"] }), _jsxs("button", { className: activeTab === 'output' ? 'is-active' : '', onClick: () => setActiveTab('output'), role: "tab", "aria-selected": activeTab === 'output', children: [_jsx(Activity, { size: 15 }), " \u8F93\u51FA", d.lastRun && _jsx("span", { className: `wf-tab-dot${d.lastRun.error ? ' is-error' : ''}` })] })] }), activeTab === 'config' && _jsxs("div", { className: "wf-inspector__pane", children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8282\u70B9\u540D\u79F0" }), _jsx("input", { value: d.label, onChange: (e) => updateNodeData(node.id, { label: e.target.value }) })] }), ['agent', 'call-workflow', 'connector', 'data-store', 'code', 'http', 'output'].includes(d.kind) && (_jsxs("label", { className: "wf-field wf-field--checkbox", children: [_jsx("input", { "aria-label": "\u8C03\u8BD5\u65AD\u70B9", type: "checkbox", checked: Boolean(d.breakpoint), onChange: (event) => updateNodeData(node.id, { breakpoint: event.target.checked, lastRun: undefined }) }), _jsx("span", { children: "\u8C03\u8BD5\u65AD\u70B9" }), _jsx("small", { className: "wf-field-hint", children: "\u624B\u52A8\u8C03\u8BD5\u65F6\u5728\u6B64\u8282\u70B9\u6267\u884C\u524D\u6682\u505C\u3002\u8C03\u8BD5 v1 \u53EA\u652F\u6301\u5355\u5165\u53E3\u3001\u7EBF\u6027\u8DEF\u5F84\u3002" })] })), d.kind === 'note' && (_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5907\u6CE8" }), _jsx("textarea", { rows: 5, placeholder: "\u8FD9\u4E2A\u5907\u6CE8\u4E0D\u4F1A\u53C2\u4E0E\u6267\u884C\uFF0C\u53EA\u505A\u8BF4\u660E", value: d.text ?? '', onChange: (e) => updateNodeData(node.id, { text: e.target.value }) })] })), d.kind === 'trigger' && (_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "Trigger text" }), _jsx("textarea", { rows: 4, placeholder: "\u8F93\u5165\u8981\u4EA4\u7ED9 agent \u7684\u4EFB\u52A1\u6587\u5B57\uFF08\u4F1A\u4F20\u5230\u4E0B\u6E38 agent\uFF09", value: d.text ?? '', onChange: (e) => updateNodeData(node.id, { text: e.target.value }) })] })), d.kind === 'webhook' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5141\u8BB8\u7684\u65B9\u6CD5" }), _jsx("select", { value: d.httpMethod ?? 'ANY', onChange: (event) => updateNodeData(node.id, { httpMethod: event.target.value }), children: ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => _jsx("option", { children: method }, method)) })] }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u751F\u4EA7 URL" }), _jsxs("div", { className: "wf-copy-field wf-copy-field--webhook", children: [_jsx("input", { readOnly: true, value: webhookUrl }), _jsx("button", { type: "button", onClick: () => void copyWebhookUrl(), "aria-label": "\u590D\u5236 Webhook URL", title: "\u590D\u5236 URL", children: copied ? _jsx(Check, { size: 15 }) : _jsx(Copy, { size: 15 }) }), _jsx("button", { type: "button", onClick: () => { if (window.confirm('重新生成后，旧 Webhook URL 将在下次发布时失效。确定继续吗？'))
                                                    updateNodeData(node.id, { webhookToken: createWebhookToken() }); }, "aria-label": "\u91CD\u65B0\u751F\u6210 Webhook token", title: "\u91CD\u65B0\u751F\u6210 token", children: _jsx(RotateCw, { size: 15 }) })] })] }), _jsxs("fieldset", { className: "wf-webhook-settings", children: [_jsx("legend", { children: "\u7B7E\u540D\u9A8C\u8BC1" }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "Webhook Secret" }), _jsxs("select", { value: d.credentialId ?? '', onChange: (event) => updateNodeData(node.id, { credentialId: event.target.value || undefined }), children: [_jsx("option", { value: "", children: "\u4E0D\u6821\u9A8C\u7B7E\u540D" }), credentials.filter((credential) => credential.kind === 'webhook-secret').map((credential) => _jsx("option", { value: credential.id, children: credential.name }, credential.id))] })] }), d.credentialId && _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u7B7E\u540D Header" }), _jsx("input", { value: d.webhookSignatureHeader ?? 'x-dsh-signature-256', onChange: (event) => updateNodeData(node.id, { webhookSignatureHeader: event.target.value }) }), _jsxs("small", { className: "wf-field-hint", children: ["\u652F\u6301 ", _jsx("code", { children: "sha256=<hex>" }), "\u3001\u7EAF hex \u6216 base64 \u7B7E\u540D\u3002"] })] })] }), _jsxs("fieldset", { className: "wf-webhook-settings", children: [_jsx("legend", { children: "\u6210\u529F\u54CD\u5E94" }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u54CD\u5E94\u6A21\u5F0F" }), _jsxs("select", { value: d.webhookResponseMode ?? 'summary', onChange: (event) => updateNodeData(node.id, { webhookResponseMode: event.target.value }), children: [_jsx("option", { value: "summary", children: "\u8FD0\u884C\u6458\u8981 JSON" }), _jsx("option", { value: "output", children: "\u76F4\u63A5\u8FD4\u56DE\u5DE5\u4F5C\u6D41\u8F93\u51FA" }), _jsx("option", { value: "custom", children: "\u81EA\u5B9A\u4E49\u54CD\u5E94" })] })] }), d.webhookResponseMode === 'custom' && _jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u72B6\u6001\u7801" }), _jsx("input", { type: "number", min: "200", max: "599", value: d.webhookResponseStatus ?? '200', onChange: (event) => updateNodeData(node.id, { webhookResponseStatus: event.target.value }) })] }), _jsx(MappedField, { label: "\u54CD\u5E94 Headers JSON", multiline: true, rows: 3, mode: "template", placeholder: '{"content-type":"application/json","x-item-id":"{{result.id}}"}', value: d.webhookResponseHeaders ?? '', onChange: (value) => updateNodeData(node.id, { webhookResponseHeaders: value }), onOpenMapper: setMappingTarget }), _jsx(MappedField, { label: "\u54CD\u5E94 Body", multiline: true, rows: 4, mode: "template", placeholder: '{"ok":true,"value":{{result}}}', value: d.webhookResponseBody ?? '{{result}}', onChange: (value) => updateNodeData(node.id, { webhookResponseBody: value }), onOpenMapper: setMappingTarget })] })] }), _jsxs("fieldset", { className: "wf-webhook-settings", children: [_jsx("legend", { children: "\u91CD\u590D\u6295\u9012" }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5E42\u7B49\u952E Header\uFF08\u53EF\u9009\uFF09" }), _jsx("input", { "aria-label": "\u5E42\u7B49\u952E Header", value: d.webhookIdempotencyHeader ?? '', placeholder: "\u4F8B\u5982 Idempotency-Key", onChange: (event) => updateNodeData(node.id, { webhookIdempotencyHeader: event.target.value || undefined }) }), _jsx("small", { className: "wf-field-hint", children: "\u53D1\u9001\u65B9\u91CD\u8BD5\u65F6\u4F7F\u7528\u540C\u4E00\u4E2A\u503C\uFF1B\u76F8\u540C\u8BF7\u6C42\u4F1A\u76F4\u63A5\u590D\u7528\u7B2C\u4E00\u6B21\u54CD\u5E94\u3002" })] }), d.webhookIdempotencyHeader && _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5E42\u7B49\u8BB0\u5F55\u4FDD\u7559\uFF08\u79D2\uFF09" }), _jsx("input", { "aria-label": "\u5E42\u7B49\u8BB0\u5F55\u4FDD\u7559", type: "number", min: "60", max: 7 * 24 * 60 * 60, value: d.webhookIdempotencyTtl ?? '86400', onChange: (event) => updateNodeData(node.id, { webhookIdempotencyTtl: event.target.value }) }), _jsx("small", { className: "wf-field-hint", children: "\u8303\u56F4 60 \u79D2\u5230 7 \u5929\uFF1B\u5B8C\u6210\u54CD\u5E94\u4F1A\u52A0\u5BC6\u4FDD\u5B58\u5728\u4E3B\u673A\u3002" })] })] }), _jsx("p", { className: "wf-field-note", children: "\u4EC5\u5DF2\u542F\u7528\u5DE5\u4F5C\u6D41\u63A5\u6536\u8BF7\u6C42\uFF1B\u7B7E\u540D\u548C\u54CD\u5E94\u914D\u7F6E\u4F7F\u7528\u6700\u540E\u4E00\u6B21\u53D1\u5E03\u7684\u5FEB\u7167\u3002" })] })), d.kind === 'schedule' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u4EFB\u52A1\u6587\u5B57\uFF08\u53EF\u9009\uFF09" }), _jsx("textarea", { rows: 2, placeholder: "\u8FD9\u6761\u5B9A\u65F6\u4EFB\u52A1\u7684\u89E6\u53D1\u5185\u5BB9\uFF08\u53EF\u9009\uFF09", value: d.text ?? '', onChange: (e) => updateNodeData(node.id, { text: e.target.value }) })] }), _jsxs("div", { className: "wf-trigger-schedule", children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5B9A\u65F6 Cron (5\u6BB5)" }), _jsx("input", { placeholder: "30 7 * * *  (\u5206 \u65F6 \u65E5 \u6708 \u5468)", value: d.cron ?? '', onChange: (e) => updateNodeData(node.id, { cron: e.target.value }) })] }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u65F6\u533A" }), _jsx("input", { placeholder: "Asia/Shanghai\uFF08\u7559\u7A7A=\u7CFB\u7EDF\u65F6\u533A\uFF09", value: d.timezone ?? '', onChange: (e) => updateNodeData(node.id, { timezone: e.target.value }), spellCheck: false })] }), _jsx("p", { className: "wf-field-note", children: "\u4EC5\u63A5\u53D7 5 \u6BB5 Cron \u548C IANA \u65F6\u533A\u3002\u590F\u4EE4\u65F6\u56DE\u62E8\u65F6\uFF0C\u540C\u4E00\u4E2A\u672C\u5730\u5206\u949F\u53EA\u4F1A\u89E6\u53D1\u4E00\u6B21\u3002" }), _jsx("div", { className: "wf-trigger-schedule__actions", children: _jsx("button", { className: "wf-btn wf-btn--primary", onClick: () => void saveSchedule(), children: "\u4FDD\u5B58\u5B9A\u65F6" }) })] })] })), d.kind === 'wait' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u7B49\u5F85\u65B9\u5F0F" }), _jsxs("select", { value: d.waitMode ?? 'delay', onChange: (event) => updateNodeData(node.id, { waitMode: event.target.value, lastRun: undefined }), children: [_jsx("option", { value: "delay", children: "\u5EF6\u8FDF\u4E00\u6BB5\u65F6\u95F4" }), _jsx("option", { value: "callback", children: "\u7B49\u5F85\u5916\u90E8\u56DE\u8C03" }), _jsx("option", { value: "approval", children: "\u7B49\u5F85\u4EBA\u5DE5\u5BA1\u6279" })] })] }), (d.waitMode ?? 'delay') === 'delay' ? (_jsxs("div", { className: "wf-field-row", children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u7B49\u5F85\u65F6\u957F" }), _jsx("input", { type: "number", min: "0.001", step: "0.1", value: d.waitAmount ?? '5', onChange: (event) => updateNodeData(node.id, { waitAmount: event.target.value, lastRun: undefined }) })] }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5355\u4F4D" }), _jsxs("select", { value: d.waitUnit ?? 'minutes', onChange: (event) => updateNodeData(node.id, { waitUnit: event.target.value, lastRun: undefined }), children: [_jsx("option", { value: "seconds", children: "\u79D2" }), _jsx("option", { value: "minutes", children: "\u5206\u949F" }), _jsx("option", { value: "hours", children: "\u5C0F\u65F6" }), _jsx("option", { value: "days", children: "\u5929" })] })] })] })) : (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8D85\u65F6\uFF08\u5C0F\u65F6\uFF0C\u53EF\u9009\uFF09" }), _jsx("input", { type: "number", min: "0.001", max: "8760", step: "0.1", value: d.waitTimeout ?? '', onChange: (event) => updateNodeData(node.id, { waitTimeout: event.target.value, lastRun: undefined }) })] }), d.waitTimeout?.trim() && _jsx(MappedField, { label: "\u8D85\u65F6\u8F93\u51FA", multiline: true, rows: 3, mode: "template", placeholder: '{"timedOut":true}', value: d.waitTimeoutValue ?? '{"timedOut":true}', onChange: (value) => updateNodeData(node.id, { waitTimeoutValue: value, lastRun: undefined }), onOpenMapper: setMappingTarget })] })), _jsx("p", { className: "wf-field-note", children: "\u7B49\u5F85\u4F1A\u6301\u4E45\u4FDD\u5B58\u8FD0\u884C\u5FEB\u7167\u5E76\u91CA\u653E\u6267\u884C\u8D44\u6E90\uFF1B\u6062\u590D\u540E\u4ECE\u6B64\u8282\u70B9\u7684\u4E0B\u6E38\u7EE7\u7EED\u3002" })] })), d.kind === 'agent' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u6A21\u578B" }), _jsxs("select", { value: d.model ?? '', onChange: (e) => updateNodeData(node.id, { model: e.target.value }), children: [_jsx("option", { value: "", children: "\u5B98\u65B9\u9ED8\u8BA4\uFF08\u7EE7\u627F\uFF09" }), agentModels.map((m) => (_jsxs("option", { value: `${m.provider}|${m.id}`, children: [m.name, "\uFF08", m.provider, "\uFF09"] }, `${m.provider}|${m.id}`)))] })] }), _jsx(MappedField, { label: "system prompt", multiline: true, rows: 3, mode: "template", value: d.prompt ?? '', onChange: (value) => updateNodeData(node.id, { prompt: value }), onOpenMapper: setMappingTarget }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8FD0\u884C\u8D85\u65F6\uFF08\u79D2\uFF0C\u7559\u7A7A=\u4E0D\u9650\u5236\uFF09" }), _jsx("input", { placeholder: "\u4F8B\u5982 60", value: d.timeout ?? '', onChange: (e) => updateNodeData(node.id, { timeout: e.target.value }) })] }), _jsx(FailureBehaviorField, { data: d, inactiveErrorEdges: inactiveErrorEdges, missingErrorRoute: missingErrorRoute, onChange: (patch) => updateNodeData(node.id, patch) }), _jsx(RetryFields, { data: d, onChange: (patch) => updateNodeData(node.id, patch) })] })), d.kind === 'call-workflow' && (() => {
                        const target = availableWorkflows.find((workflow) => workflow.id === d.workflowId);
                        const choices = availableWorkflows.filter((workflow) => workflow.id !== workflowId && workflow.status === 'enabled' && workflow.publishedDoc);
                        return (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u76EE\u6807\u5DE5\u4F5C\u6D41" }), _jsxs("select", { value: d.workflowId ?? '', onChange: (event) => updateNodeData(node.id, { workflowId: event.target.value || undefined, lastRun: undefined }), children: [_jsx("option", { value: "", children: "\u9009\u62E9\u5DF2\u53D1\u5E03\u5DE5\u4F5C\u6D41" }), choices.map((workflow) => _jsxs("option", { value: workflow.id, children: [workflow.name, " \u00B7 \u53D1\u5E03 v", workflow.publishedRevision] }, workflow.id))] }), d.workflowId && !target && _jsx("small", { className: "wf-field-hint is-error", children: "\u76EE\u6807\u5DE5\u4F5C\u6D41\u4E0D\u5B58\u5728\u3002" }), target && (target.status !== 'enabled' || !target.publishedDoc) && _jsx("small", { className: "wf-field-hint is-error", children: "\u76EE\u6807\u5DE5\u4F5C\u6D41\u672A\u542F\u7528\u6216\u6CA1\u6709\u53D1\u5E03\u5FEB\u7167\u3002" })] }), target?.publishedDoc?.inputs && target.publishedDoc.inputs.length > 0 && _jsxs("div", { className: "wf-subworkflow-contract", children: [_jsx("strong", { children: "\u76EE\u6807\u8F93\u5165" }), target.publishedDoc.inputs.map((field) => _jsxs("span", { children: [_jsx("code", { children: field.name }), field.label ? ` · ${field.label}` : '', _jsxs("small", { children: [field.type, field.required ? ' · 必填' : ''] })] }, field.name))] }), _jsx(MappedField, { label: "\u8F93\u5165\u6620\u5C04", multiline: true, rows: 5, mode: "template", placeholder: '{"customerId":{{result.id}}}', value: d.inputTemplate ?? '{{result}}', onChange: (value) => updateNodeData(node.id, { inputTemplate: value, lastRun: undefined }), onOpenMapper: setMappingTarget }), target?.publishedDoc?.outputs && target.publishedDoc.outputs.length > 0 && _jsxs("div", { className: "wf-subworkflow-contract", children: [_jsx("strong", { children: "\u76EE\u6807\u8F93\u51FA" }), target.publishedDoc.outputs.map((field) => _jsxs("span", { children: [_jsx("code", { children: field.name }), field.label ? ` · ${field.label}` : '', _jsxs("small", { children: [field.type, field.required ? ' · 必填' : ''] })] }, field.name))] }), _jsx(FailureBehaviorField, { data: d, inactiveErrorEdges: inactiveErrorEdges, missingErrorRoute: missingErrorRoute, onChange: (patch) => updateNodeData(node.id, patch) }), _jsx(RetryFields, { data: d, onChange: (patch) => updateNodeData(node.id, patch) })] }));
                    })(), d.kind === 'if' && (_jsx(MappedField, { label: "Condition", mode: "expression", placeholder: "\u6BD4\u5982 result.ok === true\uFF1Btrue \u8D70\u4E0A\u8F93\u51FA\u3001false \u8D70\u4E0B\u8F93\u51FA", value: d.condition ?? '', onChange: (value) => updateNodeData(node.id, { condition: value }), onOpenMapper: setMappingTarget })), d.kind === 'switch' && (_jsxs(_Fragment, { children: [_jsx(MappedField, { label: "\u5224\u65AD\u8868\u8FBE\u5F0F\uFF08\u503C\uFF09", mode: "expression", placeholder: "\u6BD4\u5982 result.kind", value: d.condition ?? '', onChange: (value) => updateNodeData(node.id, { condition: value }), onOpenMapper: setMappingTarget }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "Case\uFF08\u9017\u53F7\u5206\u9694\uFF0C\u5BF9\u5E94\u53F3\u4FA7\u8F93\u51FA\u53E3\uFF09" }), _jsx("input", { placeholder: "a, b, c\uFF08default \u53E3\u515C\u5E95\uFF09", value: d.cases ?? '', onChange: (e) => updateNodeData(node.id, { cases: e.target.value }) })] })] })), d.kind === 'output' && (_jsx(MappedField, { label: "Template", multiline: true, rows: 3, mode: "template", placeholder: "\u7559\u7A7A=\u76F4\u63A5\u663E\u793A\u4E0A\u4E00\u8282\u70B9\u7ED3\u679C\uFF1B\u6216\u586B \u7ED3\u679C: {{result}}", value: d.template ?? '', onChange: (value) => updateNodeData(node.id, { template: value }), onOpenMapper: setMappingTarget })), d.kind === 'loop' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5FAA\u73AF\u65B9\u5F0F" }), _jsxs("select", { value: d.mode ?? 'items', onChange: (e) => updateNodeData(node.id, { mode: e.target.value }), children: [_jsx("option", { value: "items", children: "\u904D\u5386\u6570\u7EC4 (items)" }), _jsx("option", { value: "count", children: "\u56FA\u5B9A\u6B21\u6570 (count)" })] })] }), d.mode === 'count' ? (_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u6B21\u6570" }), _jsx("input", { placeholder: "\u4F8B\u5982 5", value: d.count ?? '', onChange: (e) => updateNodeData(node.id, { count: e.target.value }) })] })) : (_jsx(MappedField, { label: "\u6570\u7EC4\u8868\u8FBE\u5F0F\uFF08\u7528 result \u8868\u793A\u4E0A\u6E38\u7ED3\u679C\uFF09", mode: "expression", placeholder: "\u4F8B\u5982 result.items", value: d.itemsExpr ?? '', onChange: (value) => updateNodeData(node.id, { itemsExpr: value }), onOpenMapper: setMappingTarget })), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u6B21\u6570\u4E0A\u9650 maxIters" }), _jsx("input", { placeholder: "100", value: d.maxIters ?? '', onChange: (e) => updateNodeData(node.id, { maxIters: e.target.value }) })] }), _jsxs("label", { className: "wf-field wf-field--checkbox", children: [_jsx("input", { type: "checkbox", checked: d.collect ?? false, onChange: (e) => updateNodeData(node.id, { collect: e.target.checked }) }), _jsx("span", { children: "\u6536\u96C6\u6BCF\u8F6E\u7ED3\u679C\u6210\u6570\u7EC4" })] })] })), d.kind === 'while' && (_jsxs(_Fragment, { children: [_jsx(MappedField, { label: "\u7EE7\u7EED\u6761\u4EF6\uFF08\u7528 result \u8868\u793A\u5F53\u524D\u503C\uFF09", mode: "expression", placeholder: "\u4F8B\u5982 result.count < 5", value: d.condition ?? '', onChange: (value) => updateNodeData(node.id, { condition: value }), onOpenMapper: setMappingTarget }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u6B21\u6570\u4E0A\u9650 maxIters" }), _jsx("input", { placeholder: "100", value: d.maxIters ?? '', onChange: (e) => updateNodeData(node.id, { maxIters: e.target.value }) })] }), _jsxs("label", { className: "wf-field wf-field--checkbox", children: [_jsx("input", { type: "checkbox", checked: d.collect ?? false, onChange: (e) => updateNodeData(node.id, { collect: e.target.checked }) }), _jsx("span", { children: "\u6536\u96C6\u6BCF\u8F6E\u7ED3\u679C\u6210\u6570\u7EC4" })] })] })), d.kind === 'code' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8FD0\u884C\u8D85\u65F6\uFF08\u79D2\uFF0C\u7559\u7A7A=\u4E0D\u9650\u5236\uFF09" }), _jsx("input", { placeholder: "\u4F8B\u5982 30", value: d.timeout ?? '', onChange: (e) => updateNodeData(node.id, { timeout: e.target.value }) })] }), _jsx(FailureBehaviorField, { data: d, inactiveErrorEdges: inactiveErrorEdges, missingErrorRoute: missingErrorRoute, onChange: (patch) => updateNodeData(node.id, patch) }), _jsx(RetryFields, { data: d, onChange: (patch) => updateNodeData(node.id, patch) }), _jsxs("div", { className: "wf-codecard", children: [_jsxs("div", { className: "wf-codecard__head", children: [_jsx("span", { className: "wf-codecard__title", children: "Code" }), _jsxs("select", { className: "wf-codecard__lang", value: d.language ?? 'typescript', onChange: (e) => updateNodeData(node.id, { language: e.target.value, lastRun: undefined }), children: [_jsx("option", { value: "typescript", children: "TypeScript" }), _jsx("option", { value: "python", children: "Python" })] })] }), _jsxs("div", { className: "wf-codecard__editor", children: [_jsx(CodeEditor, { value: d.code ?? '', onChange: (v) => updateNodeData(node.id, { code: v, lastRun: undefined }), language: d.language ?? 'typescript' }), _jsx("button", { type: "button", className: "wf-ed-expand", onClick: () => setCodeExpanded(true), title: "\u5168\u5C4F\u7F16\u8F91", "aria-label": "\u5168\u5C4F\u7F16\u8F91\u4EE3\u7801", children: _jsx("img", { className: "wf-icon-image", src: expandArrowsIcon, alt: "", "aria-hidden": "true" }) })] })] })] })), d.kind === 'http' && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "wf-field-row", children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u65B9\u6CD5" }), _jsx("select", { value: d.httpMethod ?? 'GET', onChange: (event) => updateNodeData(node.id, { httpMethod: event.target.value }), children: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => _jsx("option", { children: method }, method)) })] }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8D85\u65F6\uFF08\u79D2\uFF09" }), _jsx("input", { value: d.timeout ?? '30', onChange: (event) => updateNodeData(node.id, { timeout: event.target.value }) })] })] }), _jsx(MappedField, { label: "URL", mode: "template", placeholder: "https://api.example.com/items/{{result.id}}", value: d.url ?? '', onChange: (value) => updateNodeData(node.id, { url: value, lastRun: undefined }), onOpenMapper: setMappingTarget }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8FDE\u63A5" }), _jsxs("select", { "aria-label": "\u8FDE\u63A5", value: d.credentialId ?? '', onChange: (event) => updateNodeData(node.id, { credentialId: event.target.value || undefined }), children: [_jsx("option", { value: "", children: "\u65E0\u8BA4\u8BC1" }), credentials.filter((credential) => credential.kind !== 'webhook-secret').map((credential) => _jsxs("option", { value: credential.id, children: [credential.name, credential.kind === 'oauth2' ? ` · ${credential.status === 'connected' ? '已连接' : credential.status === 'expiring' ? '即将过期' : credential.status === 'authorizing' ? '等待授权' : '需检查'}` : ''] }, credential.id))] }), d.credentialId && credentials.find((credential) => credential.id === d.credentialId)?.status === 'error' && _jsx("small", { className: "wf-field-hint is-error", children: "\u6240\u9009\u8FDE\u63A5\u5F02\u5E38\uFF0C\u8BF7\u5230\u4E3B\u9875\u201C\u8FDE\u63A5\u201D\u4E2D\u68C0\u67E5\u3002" }), d.credentialId && credentials.find((credential) => credential.id === d.credentialId)?.status === 'expired' && _jsx("small", { className: "wf-field-hint is-error", children: "OAuth2 Token \u5DF2\u8FC7\u671F\uFF0C\u4E0B\u6B21\u8FD0\u884C\u4F1A\u5C1D\u8BD5\u81EA\u52A8\u5237\u65B0\u3002" })] }), _jsx(MappedField, { label: "\u8BF7\u6C42\u5934 JSON", multiline: true, rows: 3, mode: "template", placeholder: '{"Content-Type":"application/json"}', value: d.headers ?? '', onChange: (value) => updateNodeData(node.id, { headers: value }), onOpenMapper: setMappingTarget }), !['GET', 'HEAD'].includes(d.httpMethod ?? 'GET') && _jsx(MappedField, { label: "\u8BF7\u6C42\u4F53", multiline: true, rows: 4, mode: "template", placeholder: '{"input":"{{result.text}}"}', value: d.body ?? '', onChange: (value) => updateNodeData(node.id, { body: value }), onOpenMapper: setMappingTarget }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u54CD\u5E94\u683C\u5F0F" }), _jsxs("select", { value: d.responseMode ?? 'auto', onChange: (event) => updateNodeData(node.id, { responseMode: event.target.value }), children: [_jsx("option", { value: "auto", children: "\u81EA\u52A8\u8BC6\u522B" }), _jsx("option", { value: "json", children: "JSON" }), _jsx("option", { value: "text", children: "\u6587\u672C" })] })] }), _jsxs("label", { className: "wf-field wf-field--checkbox", children: [_jsx("input", { type: "checkbox", checked: d.failOnHttpError !== false, onChange: (event) => updateNodeData(node.id, { failOnHttpError: event.target.checked }) }), _jsx("span", { children: "\u975E 2xx \u54CD\u5E94\u89C6\u4E3A\u5931\u8D25" })] }), _jsx(FailureBehaviorField, { data: d, inactiveErrorEdges: inactiveErrorEdges, missingErrorRoute: missingErrorRoute, onChange: (patch) => updateNodeData(node.id, patch) }), _jsx(RetryFields, { data: d, onChange: (patch) => updateNodeData(node.id, patch) })] })), d.kind === 'connector-trigger' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5E94\u7528" }), _jsxs("select", { "aria-label": "\u5E94\u7528", value: d.connectorId ?? '', onChange: (event) => {
                                            const connector = latestConnectors.find((candidate) => candidate.id === event.target.value && candidate.triggers?.length);
                                            const trigger = connector?.triggers?.[0];
                                            const credentialId = connector && credentials.some((credential) => credential.id === d.credentialId && connectorCredentialCompatible(connector, credential)) ? d.credentialId : undefined;
                                            updateNodeData(node.id, { connectorId: connector?.id, connectorVersion: connector?.version, connectorTrigger: trigger?.id, connectorAction: undefined, connectorParams: trigger ? defaultConnectorParams(trigger.fields) : {}, credentialId, pollInterval: d.pollInterval ?? '60', lastRun: undefined });
                                        }, children: [_jsx("option", { value: "", children: "\u9009\u62E9\u5E94\u7528" }), latestConnectors.filter((connector) => connector.triggers?.length).map((connector) => _jsxs("option", { value: connector.id, children: [connector.name, " \u00B7 ", connector.category] }, connector.id))] })] }), selectedConnector && _jsxs("div", { className: "wf-connector-summary", children: [_jsx("span", { className: "wf-connector-dot", style: { background: selectedConnector.color } }), _jsxs("div", { children: [_jsxs("strong", { children: [selectedConnector.name, " \u00B7 v", selectedConnector.version] }), _jsx("span", { children: selectedConnector.description })] }), latestConnector && latestConnector.version > selectedConnector.version && _jsxs("button", { type: "button", onClick: () => { const trigger = latestConnector.triggers?.find((candidate) => candidate.id === d.connectorTrigger) ?? latestConnector.triggers?.[0]; updateNodeData(node.id, { connectorVersion: latestConnector.version, connectorTrigger: trigger?.id, connectorParams: trigger ? compatibleConnectorParams(trigger.fields) : {}, lastRun: undefined }); }, children: ["\u5347\u7EA7\u5230 v", latestConnector.version] })] }), d.connectorId && d.connectorVersion !== undefined && !selectedConnector && _jsxs("div", { className: "wf-inline-error", children: [_jsxs("span", { children: ["\u8FDE\u63A5\u5668 ", d.connectorId, " v", d.connectorVersion, " \u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u8BF7\u6062\u590D\u5BF9\u5E94\u7248\u672C\u6216\u5207\u6362\u5230\u6700\u65B0\u7248\u3002"] }), latestConnector && _jsxs("button", { type: "button", onClick: () => { const trigger = latestConnector.triggers?.find((candidate) => candidate.id === d.connectorTrigger) ?? latestConnector.triggers?.[0]; updateNodeData(node.id, { connectorVersion: latestConnector.version, connectorTrigger: trigger?.id, connectorParams: trigger ? compatibleConnectorParams(trigger.fields) : {}, lastRun: undefined }); }, children: ["\u5207\u6362\u5230 v", latestConnector.version] })] }), selectedConnector && _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u4E8B\u4EF6" }), _jsxs("select", { "aria-label": "\u4E8B\u4EF6", value: d.connectorTrigger ?? '', onChange: (event) => { const trigger = selectedConnector.triggers?.find((candidate) => candidate.id === event.target.value); updateNodeData(node.id, { connectorTrigger: trigger?.id, connectorParams: trigger ? defaultConnectorParams(trigger.fields) : {}, lastRun: undefined }); }, children: [_jsx("option", { value: "", children: "\u9009\u62E9\u4E8B\u4EF6" }), selectedConnector.triggers?.map((trigger) => _jsx("option", { value: trigger.id, children: trigger.label }, trigger.id))] }), selectedConnectorTrigger && _jsx("small", { className: "wf-field-hint", children: selectedConnectorTrigger.description })] }), selectedConnector && _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8FDE\u63A5" }), _jsxs("select", { "aria-label": "\u8FDE\u63A5", value: d.credentialId ?? '', onChange: (event) => updateNodeData(node.id, { credentialId: event.target.value || undefined, lastRun: undefined }), children: [_jsx("option", { value: "", children: "\u9009\u62E9\u8FDE\u63A5" }), credentials.filter((credential) => connectorCredentialCompatible(selectedConnector, credential)).map((credential) => _jsxs("option", { value: credential.id, children: [credential.name, credential.kind === 'oauth2' ? ` · ${credential.status === 'connected' ? '已连接' : credential.status === 'expiring' ? '即将过期' : '需检查'}` : ''] }, credential.id))] }), _jsx("small", { className: "wf-field-hint", children: selectedConnector.authHint }), d.credentialId && credentials.find((credential) => credential.id === d.credentialId)?.status === 'error' && _jsx("small", { className: "wf-field-hint is-error", children: "\u6240\u9009\u8FDE\u63A5\u5F02\u5E38\uFF0C\u8BF7\u5230\u4E3B\u9875\u201C\u8FDE\u63A5\u201D\u4E2D\u68C0\u67E5\u3002" })] }), selectedConnectorTrigger && _jsx("div", { className: "wf-connector-fields", children: selectedConnectorTrigger.fields.map((field) => {
                                    const value = d.connectorParams?.[field.id] ?? field.defaultValue ?? '';
                                    const stateKey = dynamicOptionsKey(field);
                                    return _jsx(ConnectorParameterField, { field: field, value: value, mapped: false, dynamic: dynamicOptions[stateKey], dynamicKey: stateKey, onChange: (next) => setConnectorParam(field.id, next), onLoadOptions: () => void loadDynamicOptions(field.id, stateKey), onOpenMapper: setMappingTarget }, field.id);
                                }) }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8F6E\u8BE2\u95F4\u9694\uFF08\u79D2\uFF09" }), _jsx("input", { type: "number", min: "15", max: "86400", step: "1", value: d.pollInterval ?? '60', onChange: (event) => updateNodeData(node.id, { pollInterval: event.target.value, lastRun: undefined }) })] }), _jsxs("div", { className: `wf-polling-status${pollingTrigger?.lastError ? ' is-error' : pollingTrigger?.active ? ' is-active' : ''}`, children: [_jsxs("div", { className: "wf-polling-status__head", children: [_jsxs("div", { children: [_jsx("strong", { children: pollingTrigger ? pollingTrigger.active ? '正在轮询' : pollingTrigger.initialized ? '监听中' : '等待建立基线' : '尚未发布' }), _jsx("span", { children: pollingTrigger?.lastError || (pollingTrigger ? `下次轮询 ${formatPollingTime(pollingTrigger.nextPollAt)}` : '发布并启用后开始轮询') })] }), pollingTrigger && _jsxs("button", { type: "button", className: "wf-btn", onClick: () => void pollNow(), disabled: pollingBusy || pollingTrigger.active, children: [pollingBusy || pollingTrigger.active ? _jsx(Loader2, { className: "wf-spin", size: 14 }) : _jsx(RotateCw, { size: 14 }), "\u7ACB\u5373\u8F6E\u8BE2"] })] }), pollingTrigger && _jsxs("dl", { children: [_jsxs("div", { children: [_jsx("dt", { children: "\u6700\u8FD1\u8F6E\u8BE2" }), _jsx("dd", { children: formatPollingTime(pollingTrigger.lastPolledAt) })] }), _jsxs("div", { children: [_jsx("dt", { children: "\u6700\u8FD1\u4E8B\u4EF6" }), _jsx("dd", { children: formatPollingTime(pollingTrigger.lastEventAt) })] })] })] })] })), d.kind === 'connector' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5E94\u7528" }), _jsxs("select", { value: d.connectorId ?? '', onChange: (event) => {
                                            const connector = latestConnectors.find((candidate) => candidate.id === event.target.value);
                                            const action = connector?.actions[0];
                                            const credentialId = connector && credentials.some((credential) => credential.id === d.credentialId && connectorCredentialCompatible(connector, credential)) ? d.credentialId : undefined;
                                            updateNodeData(node.id, { connectorId: connector?.id, connectorVersion: connector?.version, connectorAction: action?.id, connectorParams: action ? defaultConnectorParams(action.fields) : {}, credentialId, lastRun: undefined });
                                        }, children: [_jsx("option", { value: "", children: "\u9009\u62E9\u5E94\u7528" }), latestConnectors.map((connector) => _jsxs("option", { value: connector.id, children: [connector.name, " \u00B7 ", connector.category] }, connector.id))] })] }), selectedConnector && _jsxs("div", { className: "wf-connector-summary", children: [_jsx("span", { className: "wf-connector-dot", style: { background: selectedConnector.color } }), _jsxs("div", { children: [_jsxs("strong", { children: [selectedConnector.name, " \u00B7 v", selectedConnector.version] }), _jsx("span", { children: selectedConnector.description })] }), latestConnector && latestConnector.version > selectedConnector.version && _jsxs("button", { type: "button", onClick: () => { const action = latestConnector.actions.find((candidate) => candidate.id === d.connectorAction) ?? latestConnector.actions[0]; updateNodeData(node.id, { connectorVersion: latestConnector.version, connectorAction: action?.id, connectorParams: action ? compatibleConnectorParams(action.fields) : {}, lastRun: undefined }); }, children: ["\u5347\u7EA7\u5230 v", latestConnector.version] })] }), d.connectorId && d.connectorVersion !== undefined && !selectedConnector && _jsxs("div", { className: "wf-inline-error", children: [_jsxs("span", { children: ["\u8FDE\u63A5\u5668 ", d.connectorId, " v", d.connectorVersion, " \u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u8BF7\u6062\u590D\u5BF9\u5E94\u7248\u672C\u6216\u5207\u6362\u5230\u6700\u65B0\u7248\u3002"] }), latestConnector && _jsxs("button", { type: "button", onClick: () => { const action = latestConnector.actions.find((candidate) => candidate.id === d.connectorAction) ?? latestConnector.actions[0]; updateNodeData(node.id, { connectorVersion: latestConnector.version, connectorAction: action?.id, connectorParams: action ? compatibleConnectorParams(action.fields) : {}, lastRun: undefined }); }, children: ["\u5207\u6362\u5230 v", latestConnector.version] })] }), selectedConnector && _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u52A8\u4F5C" }), _jsxs("select", { value: d.connectorAction ?? '', onChange: (event) => { const action = selectedConnector.actions.find((candidate) => candidate.id === event.target.value); updateNodeData(node.id, { connectorAction: action?.id, connectorParams: action ? defaultConnectorParams(action.fields) : {}, lastRun: undefined }); }, children: [_jsx("option", { value: "", children: "\u9009\u62E9\u52A8\u4F5C" }), selectedConnector.actions.map((action) => _jsx("option", { value: action.id, children: action.label }, action.id))] }), selectedConnectorAction && _jsx("small", { className: "wf-field-hint", children: selectedConnectorAction.description })] }), selectedConnector && _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8FDE\u63A5" }), _jsxs("select", { "aria-label": "\u8FDE\u63A5", value: d.credentialId ?? '', onChange: (event) => updateNodeData(node.id, { credentialId: event.target.value || undefined, lastRun: undefined }), children: [_jsx("option", { value: "", children: "\u9009\u62E9\u8FDE\u63A5" }), credentials.filter((credential) => connectorCredentialCompatible(selectedConnector, credential)).map((credential) => _jsxs("option", { value: credential.id, children: [credential.name, credential.kind === 'oauth2' ? ` · ${credential.status === 'connected' ? '已连接' : credential.status === 'expiring' ? '即将过期' : '需检查'}` : ''] }, credential.id))] }), _jsx("small", { className: "wf-field-hint", children: selectedConnector.authHint }), d.credentialId && credentials.find((credential) => credential.id === d.credentialId)?.status === 'error' && _jsx("small", { className: "wf-field-hint is-error", children: "\u6240\u9009\u8FDE\u63A5\u5F02\u5E38\uFF0C\u8BF7\u5230\u4E3B\u9875\u201C\u8FDE\u63A5\u201D\u4E2D\u68C0\u67E5\u3002" })] }), selectedConnectorAction && _jsx("div", { className: "wf-connector-fields", children: selectedConnectorAction.fields.map((field) => {
                                    const value = d.connectorParams?.[field.id] ?? field.defaultValue ?? '';
                                    const stateKey = dynamicOptionsKey(field);
                                    return _jsx(ConnectorParameterField, { field: field, value: value, mapped: true, dynamic: dynamicOptions[stateKey], dynamicKey: stateKey, onChange: (next) => setConnectorParam(field.id, next), onLoadOptions: () => void loadDynamicOptions(field.id, stateKey), onOpenMapper: setMappingTarget }, field.id);
                                }) }), _jsxs("div", { className: "wf-field-row", children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8D85\u65F6\uFF08\u79D2\uFF09" }), _jsx("input", { type: "number", min: "1", max: "3600", value: d.timeout ?? '30', onChange: (event) => updateNodeData(node.id, { timeout: event.target.value }) })] }), _jsx(FailureBehaviorField, { data: d, inactiveErrorEdges: inactiveErrorEdges, missingErrorRoute: missingErrorRoute, onChange: (patch) => updateNodeData(node.id, patch) })] }), _jsx(RetryFields, { data: d, onChange: (patch) => updateNodeData(node.id, patch) })] })), d.kind === 'data-store' && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u547D\u540D\u7A7A\u95F4" }), _jsx("input", { "aria-label": "Data Store \u547D\u540D\u7A7A\u95F4", value: d.storeNamespace ?? 'default', onChange: (event) => updateNodeData(node.id, { storeNamespace: event.target.value, lastRun: undefined }), placeholder: "default" }), _jsx("small", { className: "wf-field-hint", children: "\u540C\u4E00\u5DE5\u4F5C\u6D41\u5185\u9694\u79BB\uFF1B\u53EA\u5141\u8BB8\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u3001\u5192\u53F7\u548C\u77ED\u6A2A\u7EBF\u3002" })] }), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u64CD\u4F5C" }), _jsxs("select", { "aria-label": "Data Store \u64CD\u4F5C", value: d.storeOperation ?? 'get', onChange: (event) => updateNodeData(node.id, { storeOperation: event.target.value, lastRun: undefined }), children: [_jsx("option", { value: "get", children: "\u8BFB\u53D6\u952E" }), _jsx("option", { value: "set", children: "\u5199\u5165\u952E" }), _jsx("option", { value: "delete", children: "\u5220\u9664\u952E" }), _jsx("option", { value: "list", children: "\u5217\u51FA\u952E" })] })] }), (d.storeOperation ?? 'get') !== 'list' ? (_jsx(MappedField, { label: "\u952E", mode: "template", value: d.storeKey ?? '', onChange: (value) => updateNodeData(node.id, { storeKey: value, lastRun: undefined }), onOpenMapper: setMappingTarget, placeholder: "\u4F8B\u5982 customer:{{result.id}}" })) : (_jsx(MappedField, { label: "\u952E\u524D\u7F00\uFF08\u53EF\u9009\uFF09", mode: "template", value: d.storePrefix ?? '', onChange: (value) => updateNodeData(node.id, { storePrefix: value, lastRun: undefined }), onOpenMapper: setMappingTarget, placeholder: "\u4F8B\u5982 customer:" })), (d.storeOperation ?? 'get') === 'set' && _jsx(MappedField, { label: "\u503C", multiline: true, rows: 5, mode: "template", value: d.storeValue ?? '{{result}}', onChange: (value) => updateNodeData(node.id, { storeValue: value, lastRun: undefined }), onOpenMapper: setMappingTarget, placeholder: '{"status":"ready","value":{{result}}}' }), _jsx("p", { className: "wf-field-note", children: "\u503C\u5728 DSH \u4E3B\u673A\u4E0A\u4F7F\u7528 AES-256-GCM \u52A0\u5BC6\u4FDD\u5B58\uFF1B\u8FD0\u884C\u5386\u53F2\u53EA\u663E\u793A\u8131\u654F\u7ED3\u679C\u3002Data Store \u6309\u5DE5\u4F5C\u6D41\u548C\u547D\u540D\u7A7A\u95F4\u9694\u79BB\u3002" }), _jsx(FailureBehaviorField, { data: d, inactiveErrorEdges: inactiveErrorEdges, missingErrorRoute: missingErrorRoute, onChange: (patch) => updateNodeData(node.id, patch) })] })), codeExpanded && (_jsx(CodeEditorModal, { value: d.code ?? '', onChange: (v) => updateNodeData(node.id, { code: v, lastRun: undefined }), language: d.language ?? 'typescript', onClose: () => setCodeExpanded(false) })), _jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u5907\u6CE8" }), _jsx("input", { value: d.notes ?? '', onChange: (e) => updateNodeData(node.id, { notes: e.target.value }) })] }), d.kind !== 'note' && d.kind !== 'wait' && d.kind !== 'connector-trigger' && _jsxs("div", { className: "wf-node-test", children: [_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u6D4B\u8BD5\u8F93\u5165" }), _jsx("textarea", { rows: 3, placeholder: "\u4F5C\u4E3A\u5F53\u524D\u8282\u70B9\u7684\u4E0A\u6E38\u8F93\u5165", value: testInput, onChange: (event) => setTestInput(event.target.value) })] }), _jsxs("button", { className: "wf-btn wf-btn--primary", onClick: () => void testNode(), disabled: testing, children: [testing ? _jsx(Loader2, { className: "wf-spin", size: 15 }) : _jsx(Play, { size: 15 }), testing ? '测试中' : '测试此节点'] })] })] }), activeTab === 'output' && d.lastRun && (_jsxs("div", { className: "wf-run", children: [(d.lastRun.attempts ?? 1) > 1 && _jsxs("p", { className: "wf-run-attempts", children: ["\u6267\u884C\u4E86 ", d.lastRun.attempts, " \u6B21\u540E\u5B8C\u6210"] }), d.kind !== 'output' && d.kind !== 'trigger' && d.kind !== 'connector-trigger' && d.lastRun.input !== undefined && d.lastRun.input !== '' && (_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8F93\u5165 Input" }), _jsx("textarea", { className: "wf-run__box", readOnly: true, rows: 3, value: d.lastRun.input })] })), d.kind !== 'trigger' && d.kind !== 'schedule' && d.lastRun.value !== undefined && (_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u8F93\u51FA Output" }), _jsx("textarea", { className: "wf-run__box", readOnly: true, rows: 5, value: typeof d.lastRun.value === 'string'
                                    ? d.lastRun.value
                                    : JSON.stringify(d.lastRun.value) })] })), d.lastRun.logs && d.lastRun.logs.length > 0 && (_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u65E5\u5FD7 Logs" }), _jsx("pre", { className: "wf-result__logs", children: d.lastRun.logs.join('\n') })] })), d.lastRun.error && (_jsxs("label", { className: "wf-field", children: [_jsx("span", { children: "\u9519\u8BEF Error" }), _jsx("pre", { className: "wf-result__error", children: d.lastRun.error })] }))] })), activeTab === 'output' && !d.lastRun && (_jsxs("div", { className: "wf-inspector__empty-state", children: [_jsx(Activity, { size: 22 }), _jsx("strong", { children: "\u8FD8\u6CA1\u6709\u8FD0\u884C\u6570\u636E" }), _jsx("span", { children: "\u8FD0\u884C\u5DE5\u4F5C\u6D41\u540E\u53EF\u67E5\u770B\u8FD9\u4E2A\u8282\u70B9\u7684\u8F93\u5165\u3001\u8F93\u51FA\u3001\u65E5\u5FD7\u548C\u9519\u8BEF\u3002" })] })), mappingTarget && _jsx(FieldMapper, { targetLabel: mappingTarget.label, mode: mappingTarget.mode, sources: mappingSources, onInsert: mappingTarget.insert, onClose: () => setMappingTarget(null) })] }));
}

import { evaluateResultExpression, parseResultValue, renderResultJsonTemplate, renderResultTemplate } from './resultExpression.js';
export const MAX_SUBWORKFLOW_DEPTH = 8;
const FIELD_NAME = /^[A-Za-z_$][\w$]*$/;
const EXACT_RESULT_TOKEN = /^\{\{\s*((?:result|vars)(?:\s*(?:\.[A-Za-z_$][\w$]*|\[(?:\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]))*)\s*\}\}$/;
const VALUE_TYPES = new Set(['any', 'string', 'number', 'boolean', 'object', 'array']);
export function normalizeWorkflowContract(fields) {
    if (!Array.isArray(fields))
        return [];
    const names = new Set();
    return fields.slice(0, 50).flatMap((field) => {
        const name = String(field?.name ?? '').trim();
        if (!FIELD_NAME.test(name) || names.has(name))
            return [];
        names.add(name);
        return [{
                name,
                label: String(field.label ?? '').trim() || undefined,
                type: VALUE_TYPES.has(field.type) ? field.type : 'any',
                required: Boolean(field.required),
                description: String(field.description ?? '').trim() || undefined,
            }];
    });
}
export function renderSubworkflowInput(template, result, variables = {}) {
    const source = template?.trim() || '{{result}}';
    const exact = source.match(EXACT_RESULT_TOKEN);
    if (exact)
        return evaluateResultExpression(exact[1], result, variables);
    const renderedJson = renderResultJsonTemplate(source, result, variables);
    try {
        return JSON.parse(renderedJson);
    }
    catch {
        return renderResultTemplate(source, result, variables);
    }
}
function valueType(value) {
    if (Array.isArray(value))
        return 'array';
    if (value === null)
        return 'object';
    const type = typeof value;
    return type === 'string' || type === 'number' || type === 'boolean' || type === 'object' ? type : 'any';
}
export function validateWorkflowContract(value, fields, label) {
    const contract = normalizeWorkflowContract(fields);
    if (contract.length === 0)
        return value;
    const parsed = parseResultValue(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`${label}必须是 JSON 对象`);
    const record = parsed;
    for (const field of contract) {
        const fieldValue = record[field.name];
        if (field.required && (fieldValue === undefined || fieldValue === null || fieldValue === '')) {
            throw new Error(`${label}缺少必填字段“${field.label || field.name}”`);
        }
        if (fieldValue === undefined || fieldValue === null || field.type === 'any')
            continue;
        const actual = valueType(fieldValue);
        if (actual !== field.type)
            throw new Error(`${label}字段“${field.label || field.name}”应为 ${field.type}，实际为 ${actual}`);
    }
    return parsed;
}
function referencedWorkflowIds(document) {
    return document.nodes
        .filter((node) => node.data.kind === 'call-workflow')
        .map((node) => node.data.workflowId?.trim() ?? '');
}
export function capturePublishedSubworkflows(rootWorkflowId, rootDocument, workflows, maximumDepth = MAX_SUBWORKFLOW_DEPTH) {
    const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const snapshots = {};
    const rootKey = rootWorkflowId?.trim() || '__root__';
    const visit = (document, path) => {
        for (const targetId of referencedWorkflowIds(document)) {
            if (!targetId)
                throw new Error('调用工作流节点尚未选择目标工作流');
            if (path.includes(targetId))
                throw new Error(`检测到子工作流递归调用：${[...path, targetId].join(' → ')}`);
            if (path.length >= maximumDepth)
                throw new Error(`子工作流最多嵌套 ${maximumDepth} 层`);
            const target = byId.get(targetId);
            if (!target)
                throw new Error(`目标工作流不存在：${targetId}`);
            if (target.status !== 'enabled' || !target.publishedDoc)
                throw new Error(`目标工作流“${target.name}”尚未发布或已停用`);
            if (!snapshots[targetId]) {
                snapshots[targetId] = {
                    workflowId: target.id,
                    name: target.name,
                    publishedRevision: target.publishedRevision,
                    doc: structuredClone(target.publishedDoc),
                };
                visit(target.publishedDoc, [...path, targetId]);
            }
        }
    };
    visit(rootDocument, [rootKey]);
    return snapshots;
}
export function validateSubworkflowRuntimeCall(stack, targetWorkflowId, maximumDepth = MAX_SUBWORKFLOW_DEPTH) {
    if (!targetWorkflowId)
        throw new Error('调用工作流节点尚未选择目标工作流');
    if (stack.includes(targetWorkflowId))
        throw new Error(`检测到子工作流递归调用：${[...stack, targetWorkflowId].join(' → ')}`);
    if (stack.length >= maximumDepth)
        throw new Error(`子工作流最多嵌套 ${maximumDepth} 层`);
}

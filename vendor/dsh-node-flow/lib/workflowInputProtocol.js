import { normalizeWorkflowContract, validateWorkflowContract } from './subworkflowProtocol.js';
function fieldLabel(field) {
    return field.label || field.name;
}
export function parseWorkflowContractField(field, source, label = '运行输入') {
    const text = source.trim();
    if (!text)
        return undefined;
    const name = fieldLabel(field);
    if (field.type === 'string')
        return source;
    if (field.type === 'number') {
        const value = Number(text);
        if (!Number.isFinite(value))
            throw new Error(`${label}字段“${name}”必须是数字`);
        return value;
    }
    if (field.type === 'boolean') {
        if (text === 'true')
            return true;
        if (text === 'false')
            return false;
        throw new Error(`${label}字段“${name}”必须是布尔值`);
    }
    if (field.type === 'object' || field.type === 'array') {
        try {
            return JSON.parse(text);
        }
        catch {
            throw new Error(`${label}字段“${name}”必须是合法 JSON`);
        }
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return source;
    }
}
export function parseWorkflowContractInput(fields, values, label = '运行输入') {
    const contract = normalizeWorkflowContract(fields);
    const input = {};
    for (const field of contract) {
        const value = parseWorkflowContractField(field, values[field.name] ?? '', label);
        if (value !== undefined)
            input[field.name] = value;
    }
    return validateWorkflowContract(input, contract, label);
}

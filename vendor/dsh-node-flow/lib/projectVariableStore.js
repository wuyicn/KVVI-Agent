import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const VARIABLE_REFERENCE = /\bvars(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g;
const MAX_VARIABLES = 100;
const MAX_VALUE_BYTES = 64 * 1024;
function keyFile(dataDirectory) {
    return join(dataDirectory, 'variables.key');
}
function variablesFile(dataDirectory) {
    return join(dataDirectory, 'variables.json');
}
function ensureDirectory(dataDirectory) {
    mkdirSync(dataDirectory, { recursive: true });
}
function loadKey(dataDirectory) {
    ensureDirectory(dataDirectory);
    const file = keyFile(dataDirectory);
    if (!existsSync(file)) {
        writeFileSync(file, randomBytes(32), { mode: 0o600 });
        try {
            chmodSync(file, 0o600);
        }
        catch { /* Windows ACLs are managed by the user profile. */ }
    }
    const key = readFileSync(file);
    if (key.byteLength !== 32)
        throw new Error('变量密钥文件无效');
    return key;
}
function readVariables(dataDirectory) {
    try {
        const parsed = JSON.parse(readFileSync(variablesFile(dataDirectory), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw new Error('无法读取项目变量存储');
    }
}
function writeVariables(dataDirectory, variables) {
    ensureDirectory(dataDirectory);
    const file = variablesFile(dataDirectory);
    const temporary = `${file}.tmp-${process.pid}`;
    const contents = JSON.stringify(variables, null, 2);
    writeFileSync(temporary, contents, { mode: 0o600 });
    try {
        renameSync(temporary, file);
    }
    catch {
        writeFileSync(file, contents, { mode: 0o600 });
        try {
            unlinkSync(temporary);
        }
        catch { /* Temporary file already moved or unavailable. */ }
    }
    try {
        chmodSync(file, 0o600);
    }
    catch { /* Windows ACLs are managed by the user profile. */ }
}
function encryptValue(dataDirectory, value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', loadKey(dataDirectory), iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decryptValue(dataDirectory, encrypted) {
    try {
        const decipher = createDecipheriv('aes-256-gcm', loadKey(dataDirectory), Buffer.from(encrypted.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8');
    }
    catch {
        throw new Error('项目变量无法解密');
    }
}
function normalizeName(value) {
    const name = value.trim().toUpperCase();
    if (!VARIABLE_NAME.test(name))
        throw new Error('变量名必须以大写字母开头，且只能包含大写字母、数字和下划线');
    return name;
}
function validateValue(value, kind) {
    if (!value)
        throw new Error('变量值不能为空');
    if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES)
        throw new Error('变量值不能超过 64 KB');
    if (kind === 'secret' && value.length < 8)
        throw new Error('Secret 变量至少需要 8 个字符');
}
function nextUpdatedAt(previous) {
    const now = Date.now();
    const previousTime = previous ? Date.parse(previous) : Number.NaN;
    return new Date(Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now).toISOString();
}
function summary(dataDirectory, variable) {
    return {
        id: variable.id,
        name: variable.name,
        kind: variable.kind,
        description: variable.description,
        value: variable.kind === 'plain' ? decryptValue(dataDirectory, variable.value) : undefined,
        createdAt: variable.createdAt,
        updatedAt: variable.updatedAt,
    };
}
export function listProjectVariableSummaries(dataDirectory) {
    return readVariables(dataDirectory).map((variable) => summary(dataDirectory, variable)).sort((left, right) => left.name.localeCompare(right.name));
}
export function resolveProjectVariables(dataDirectory) {
    return Object.fromEntries(readVariables(dataDirectory).map((variable) => [variable.name, decryptValue(dataDirectory, variable.value)]));
}
export function resolvePublicProjectVariables(dataDirectory) {
    return Object.fromEntries(readVariables(dataDirectory)
        .filter((variable) => variable.kind === 'plain')
        .map((variable) => [variable.name, decryptValue(dataDirectory, variable.value)]));
}
export function listProjectSecretValues(dataDirectory) {
    return readVariables(dataDirectory)
        .filter((variable) => variable.kind === 'secret')
        .map((variable) => decryptValue(dataDirectory, variable.value))
        .filter(Boolean)
        .sort((left, right) => right.length - left.length);
}
export function saveProjectVariable(dataDirectory, input) {
    const variables = readVariables(dataDirectory);
    const existing = input.id ? variables.find((variable) => variable.id === input.id) : undefined;
    if (input.id && !existing)
        throw new Error('项目变量不存在');
    const name = normalizeName(input.name);
    const kind = input.kind === 'secret' ? 'secret' : 'plain';
    if (existing && existing.name !== name)
        throw new Error('变量名不可修改，请新建变量并更新工作流引用');
    if (variables.some((variable) => variable.id !== existing?.id && variable.name === name))
        throw new Error(`变量 ${name} 已存在`);
    if (!existing && variables.length >= MAX_VARIABLES)
        throw new Error(`项目变量最多保存 ${MAX_VARIABLES} 个`);
    const description = input.description?.trim().slice(0, 200) || undefined;
    const nextValue = input.value === undefined || input.value === '' ? undefined : input.value;
    if (!existing && nextValue === undefined)
        throw new Error('变量值不能为空');
    if (existing && existing.kind !== kind)
        throw new Error('变量类型不可修改，请新建变量并更新工作流引用');
    if (nextValue !== undefined)
        validateValue(nextValue, kind);
    const now = nextUpdatedAt(existing?.updatedAt);
    const stored = {
        id: existing?.id ?? randomUUID(),
        name,
        kind,
        description,
        value: nextValue === undefined ? existing.value : encryptValue(dataDirectory, nextValue),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    writeVariables(dataDirectory, [...variables.filter((variable) => variable.id !== stored.id), stored]);
    return summary(dataDirectory, stored);
}
export function deleteProjectVariable(dataDirectory, id) {
    const variables = readVariables(dataDirectory);
    const next = variables.filter((variable) => variable.id !== id);
    if (next.length === variables.length)
        return false;
    writeVariables(dataDirectory, next);
    return true;
}
export function extractProjectVariableReferences(value) {
    const names = new Set();
    const visit = (candidate) => {
        if (typeof candidate === 'string') {
            for (const match of candidate.matchAll(VARIABLE_REFERENCE))
                names.add(match[1] || match[2]);
            return;
        }
        if (Array.isArray(candidate)) {
            for (const item of candidate)
                visit(item);
            return;
        }
        if (candidate && typeof candidate === 'object')
            for (const item of Object.values(candidate))
                visit(item);
    };
    visit(value);
    return [...names].sort();
}
export function extractNodeProjectVariableReferences(data) {
    return extractProjectVariableReferences({
        text: data.text,
        prompt: data.prompt,
        inputTemplate: data.inputTemplate,
        connectorParams: data.connectorParams,
        storeKey: data.storeKey,
        storeValue: data.storeValue,
        storePrefix: data.storePrefix,
        waitTimeoutValue: data.waitTimeoutValue,
        condition: data.condition,
        itemsExpr: data.itemsExpr,
        url: data.url,
        headers: data.headers,
        body: data.body,
        template: data.template,
        webhookResponseHeaders: data.webhookResponseHeaders,
        webhookResponseBody: data.webhookResponseBody,
    });
}
export function extractUnsafeProjectSecretReferences(data) {
    if (data.kind === 'trigger' || data.kind === 'schedule')
        return extractProjectVariableReferences(data.text);
    if (data.kind === 'agent')
        return extractProjectVariableReferences(data.prompt);
    if (data.kind === 'call-workflow')
        return extractProjectVariableReferences(data.inputTemplate);
    if (data.kind === 'wait')
        return extractProjectVariableReferences(data.waitTimeoutValue);
    if (data.kind === 'output')
        return extractProjectVariableReferences(data.template);
    if (data.kind === 'webhook')
        return extractProjectVariableReferences({ headers: data.webhookResponseHeaders, body: data.webhookResponseBody });
    return [];
}
function redactText(value, secrets) {
    let result = value;
    for (const secret of secrets)
        if (secret)
            result = result.split(secret).join('[secret]');
    return result;
}
export function redactProjectSecrets(value, secrets) {
    if (secrets.length === 0)
        return value;
    const visit = (candidate) => {
        if (typeof candidate === 'string')
            return redactText(candidate, secrets);
        if (Array.isArray(candidate))
            return candidate.map(visit);
        if (candidate && typeof candidate === 'object')
            return Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, visit(item)]));
        return candidate;
    };
    return visit(value);
}

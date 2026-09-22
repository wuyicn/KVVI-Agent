import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_RECORDS = 10000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
function keyFile(dataDirectory) {
    return join(dataDirectory, 'data-store.key');
}
function recordsFile(dataDirectory) {
    return join(dataDirectory, 'data-store.json');
}
function ensureDirectory(dataDirectory) {
    mkdirSync(dataDirectory, { recursive: true });
}
function loadKey(dataDirectory) {
    ensureDirectory(dataDirectory);
    const file = keyFile(dataDirectory);
    if (!existsSync(file))
        writeFileSync(file, randomBytes(32), { mode: 0o600 });
    const key = readFileSync(file);
    if (key.byteLength !== 32)
        throw new Error('Data Store 密钥文件无效');
    try {
        chmodSync(file, 0o600);
    }
    catch { /* Windows ACLs are managed by the user profile. */ }
    return key;
}
function loadRecords(dataDirectory) {
    try {
        const file = recordsFile(dataDirectory);
        if (!existsSync(file))
            return [];
        const bytes = readFileSync(file);
        if (bytes.byteLength > MAX_FILE_BYTES)
            throw new Error('Data Store 文件超过大小限制');
        const parsed = JSON.parse(bytes.toString('utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch (error) {
        if (error instanceof Error && error.message.includes('超过大小限制'))
            throw error;
        throw new Error('无法读取 Data Store 存储');
    }
}
function saveRecords(dataDirectory, records) {
    if (records.length > MAX_RECORDS)
        throw new Error(`Data Store 最多保存 ${MAX_RECORDS} 个键`);
    ensureDirectory(dataDirectory);
    const file = recordsFile(dataDirectory);
    const contents = JSON.stringify(records, null, 2);
    if (new TextEncoder().encode(contents).byteLength > MAX_FILE_BYTES)
        throw new Error('Data Store 文件超过大小限制');
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, contents, { mode: 0o600 });
    try {
        renameSync(temporary, file);
    }
    catch {
        writeFileSync(file, contents, { mode: 0o600 });
        try {
            unlinkSync(temporary);
        }
        catch { /* best-effort cleanup */ }
    }
    try {
        chmodSync(file, 0o600);
    }
    catch { /* Windows ACLs are managed by the user profile. */ }
}
function encryptValue(dataDirectory, value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
        throw new Error('Data Store 值必须是 JSON 可序列化数据');
    if (new TextEncoder().encode(serialized).byteLength > MAX_VALUE_BYTES)
        throw new Error('Data Store 单个值不能超过 256 KB');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', loadKey(dataDirectory), iv);
    const data = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decryptValue(dataDirectory, value) {
    try {
        const decipher = createDecipheriv('aes-256-gcm', loadKey(dataDirectory), Buffer.from(value.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
        const serialized = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
        return JSON.parse(serialized);
    }
    catch {
        throw new Error('Data Store 值无法解密');
    }
}
export function normalizeDataStoreNamespace(value) {
    const namespace = value?.trim() || 'default';
    if (!NAMESPACE_PATTERN.test(namespace))
        throw new Error('Data Store 命名空间只能包含字母、数字、点、下划线、冒号和短横线，最长 64 个字符');
    return namespace;
}
export function normalizeDataStoreKey(value, label = '键') {
    const key = value.trim();
    if (!key)
        throw new Error(`Data Store ${label}不能为空`);
    if (key.length > MAX_KEY_LENGTH || /[\u0000-\u001f]/.test(key))
        throw new Error(`Data Store ${label}最长 256 个字符且不能包含控制字符`);
    return key;
}
export function normalizeDataStoreOperation(value) {
    if (value === 'get' || value === 'set' || value === 'delete' || value === 'list')
        return value;
    throw new Error('Data Store 操作必须是 get、set、delete 或 list');
}
export function validateDataStoreNodeConfiguration(data) {
    if (data.kind !== 'data-store')
        return;
    const operation = normalizeDataStoreOperation(data.storeOperation);
    normalizeDataStoreNamespace(data.storeNamespace);
    if (operation === 'get' || operation === 'set' || operation === 'delete')
        normalizeDataStoreKey(data.storeKey ?? '');
    if (operation === 'set' && (data.storeValue ?? '').length > MAX_VALUE_BYTES)
        throw new Error('Data Store 值模板不能超过 256 KB');
    if (operation === 'list' && (data.storePrefix ?? '').length > MAX_KEY_LENGTH)
        throw new Error('Data Store 前缀最长 256 个字符');
}
function scopeMatches(record, workflowId, namespace) {
    return record.workflowId === workflowId && record.namespace === namespace;
}
export function readDataStoreValue(dataDirectory, workflowId, namespaceValue, keyValue) {
    const namespace = normalizeDataStoreNamespace(namespaceValue);
    const key = normalizeDataStoreKey(keyValue);
    const record = loadRecords(dataDirectory).find((candidate) => scopeMatches(candidate, workflowId, namespace) && candidate.key === key);
    return record ? { key: record.key, value: decryptValue(dataDirectory, record.value), updatedAt: record.updatedAt } : undefined;
}
export function writeDataStoreValue(dataDirectory, workflowId, namespaceValue, keyValue, value) {
    const namespace = normalizeDataStoreNamespace(namespaceValue);
    const key = normalizeDataStoreKey(keyValue);
    const records = loadRecords(dataDirectory);
    const next = { workflowId, namespace, key, value: encryptValue(dataDirectory, value), updatedAt: new Date().toISOString() };
    saveRecords(dataDirectory, [...records.filter((candidate) => !(scopeMatches(candidate, workflowId, namespace) && candidate.key === key)), next]);
    return { key, value, updatedAt: next.updatedAt };
}
export function deleteDataStoreValue(dataDirectory, workflowId, namespaceValue, keyValue) {
    const namespace = normalizeDataStoreNamespace(namespaceValue);
    const key = normalizeDataStoreKey(keyValue);
    const records = loadRecords(dataDirectory);
    const next = records.filter((candidate) => !(scopeMatches(candidate, workflowId, namespace) && candidate.key === key));
    if (next.length === records.length)
        return false;
    saveRecords(dataDirectory, next);
    return true;
}
export function deleteDataStoreWorkflow(dataDirectory, workflowId) {
    const records = loadRecords(dataDirectory);
    const next = records.filter((record) => record.workflowId !== workflowId);
    if (next.length !== records.length)
        saveRecords(dataDirectory, next);
    return records.length - next.length;
}
export function listDataStoreValues(dataDirectory, workflowId, namespaceValue, prefixValue = '') {
    const namespace = normalizeDataStoreNamespace(namespaceValue);
    if (prefixValue.length > MAX_KEY_LENGTH)
        throw new Error('Data Store 前缀最长 256 个字符');
    return loadRecords(dataDirectory)
        .filter((candidate) => scopeMatches(candidate, workflowId, namespace) && candidate.key.startsWith(prefixValue))
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((record) => ({ key: record.key, value: decryptValue(dataDirectory, record.value), updatedAt: record.updatedAt }));
}

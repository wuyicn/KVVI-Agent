import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { renderResultJsonTemplate, renderResultTemplate } from './resultExpression.js';
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_RESPONSE_HEADERS = new Set([
    'connection',
    'cache-control',
    'content-length',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-dsh-run-id',
]);
const FORBIDDEN_IDEMPOTENCY_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'content-length']);
export function normalizeWebhookSignatureHeader(value) {
    const header = value?.trim().toLowerCase() || 'x-dsh-signature-256';
    if (!HEADER_NAME.test(header))
        throw new Error('Webhook 签名 Header 名称无效');
    return header;
}
export function normalizeWebhookIdempotencyHeader(value) {
    const header = value?.trim().toLowerCase();
    if (!header)
        return undefined;
    if (!HEADER_NAME.test(header) || FORBIDDEN_IDEMPOTENCY_HEADERS.has(header))
        throw new Error('Webhook 幂等键 Header 名称无效');
    return header;
}
export function normalizeWebhookIdempotencyTtl(value) {
    const ttl = value?.trim() ? Number(value) : 24 * 60 * 60;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 7 * 24 * 60 * 60)
        throw new Error('Webhook 幂等键保留时间必须是 60 秒到 7 天之间的整数');
    return ttl;
}
export function normalizeWebhookIdempotencyKey(value) {
    const key = value?.trim() ?? '';
    if (!key || key.length > 200 || /[\r\n]/.test(key))
        throw new Error('Webhook 幂等键必须是 1–200 个不含换行的字符');
    return key;
}
export function webhookIdempotencyId(workflowId, nodeId, method, key) {
    return createHash('sha256').update(`${workflowId}\n${nodeId}\n${method}\n${key}`, 'utf8').digest('base64url');
}
export function webhookRequestFingerprint(workflowId, nodeId, method, rawBody, query = '') {
    return createHash('sha256').update(`${workflowId}\n${nodeId}\n${method}\n${query}\n`, 'utf8').update(rawBody).digest('base64url');
}
function decodeSignature(value) {
    const source = value.trim().replace(/^sha256=/i, '');
    if (/^[0-9a-f]{64}$/i.test(source))
        return Buffer.from(source, 'hex');
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(source))
        return undefined;
    const decoded = Buffer.from(source.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    return decoded.byteLength === 32 ? decoded : undefined;
}
export function verifyWebhookSignature(body, secret, signature) {
    if (!secret || !signature)
        return false;
    const supplied = decodeSignature(signature);
    if (!supplied)
        return false;
    const expected = createHmac('sha256', secret).update(body).digest();
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}
export function parseWebhookResponseHeaders(source) {
    if (!source?.trim())
        return {};
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch {
        throw new Error('Webhook 响应 Headers 必须是 JSON 对象');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Webhook 响应 Headers 必须是 JSON 对象');
    const headers = {};
    for (const [rawName, rawValue] of Object.entries(parsed)) {
        const name = rawName.trim().toLowerCase();
        if (!HEADER_NAME.test(name) || FORBIDDEN_RESPONSE_HEADERS.has(name))
            throw new Error(`Webhook 响应 Header 不允许使用：${rawName}`);
        if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean')
            throw new Error(`Webhook 响应 Header ${rawName} 必须是标量值`);
        const value = String(rawValue);
        if (/\r|\n/.test(value))
            throw new Error(`Webhook 响应 Header ${rawName} 包含非法换行`);
        headers[name] = value;
    }
    return headers;
}
export function normalizeWebhookResponseStatus(value) {
    const status = value?.trim() ? Number(value) : 200;
    if (!Number.isInteger(status) || status < 200 || status > 599)
        throw new Error('Webhook 响应状态码必须是 200–599 的整数');
    return status;
}
export function buildWebhookSuccessResponse(data, resultValue, runId, variables = {}) {
    const mode = data.webhookResponseMode === 'output' || data.webhookResponseMode === 'custom'
        ? data.webhookResponseMode
        : 'summary';
    if (mode === 'summary') {
        return {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: true, runId, value: resultValue, status: 'ok' }),
        };
    }
    if (mode === 'output') {
        return typeof resultValue === 'string'
            ? { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: resultValue }
            : { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(resultValue ?? null) };
    }
    const status = normalizeWebhookResponseStatus(data.webhookResponseStatus);
    const headers = Object.fromEntries(Object.entries(parseWebhookResponseHeaders(data.webhookResponseHeaders)).map(([name, template]) => {
        const value = renderResultTemplate(template, resultValue, variables);
        if (/\r|\n/.test(value))
            throw new Error(`Webhook 响应 Header ${name} 解析后包含非法换行`);
        return [name, value];
    }));
    if (!headers['content-type'])
        headers['content-type'] = 'text/plain; charset=utf-8';
    const bodyTemplate = data.webhookResponseBody ?? '{{result}}';
    const contentType = headers['content-type'].toLowerCase();
    const body = status === 204 || status === 304
        ? ''
        : contentType.includes('/json') || contentType.includes('+json')
            ? renderResultJsonTemplate(bodyTemplate, resultValue, variables)
            : renderResultTemplate(bodyTemplate, resultValue, variables);
    if (body && (contentType.includes('/json') || contentType.includes('+json'))) {
        try {
            JSON.parse(body);
        }
        catch {
            throw new Error('Webhook 响应 Body 解析后不是有效 JSON');
        }
    }
    return { status, headers, body };
}
export function validateWebhookConfiguration(data) {
    if (data.credentialId)
        normalizeWebhookSignatureHeader(data.webhookSignatureHeader);
    const signatureHeader = data.credentialId ? normalizeWebhookSignatureHeader(data.webhookSignatureHeader) : undefined;
    const idempotencyHeader = normalizeWebhookIdempotencyHeader(data.webhookIdempotencyHeader);
    if (signatureHeader && idempotencyHeader && signatureHeader === idempotencyHeader)
        throw new Error('Webhook 签名 Header 不能同时作为幂等键 Header');
    if (idempotencyHeader)
        normalizeWebhookIdempotencyTtl(data.webhookIdempotencyTtl);
    if (data.webhookResponseMode === 'custom') {
        normalizeWebhookResponseStatus(data.webhookResponseStatus);
        parseWebhookResponseHeaders(data.webhookResponseHeaders);
    }
}

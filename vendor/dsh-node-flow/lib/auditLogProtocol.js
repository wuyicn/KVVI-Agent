export const MAX_WORKFLOW_AUDIT_EVENTS = 1000;
const ACTIONS = new Set([
    'workflow.created',
    'workflow.moved',
    'workflow.published',
    'workflow.disabled',
    'workflow.deleted',
    'workflow.restored',
    'credential.created',
    'credential.updated',
    'credential.tested',
    'credential.authorization-started',
    'credential.authorized',
    'credential.authorization-cancelled',
    'credential.deleted',
    'variable.created',
    'variable.updated',
    'variable.deleted',
    'folder.created',
    'folder.renamed',
    'folder.deleted',
    'run.manual-started',
    'run.debug-started',
    'run.debug-stepped',
    'run.debug-continued',
    'run.debug-cancelled',
    'run.cancelled',
    'run.resumed',
    'run.replayed',
    'waitpoint.approved',
    'waitpoint.rejected',
]);
const TARGET_TYPES = new Set(['workflow', 'credential', 'variable', 'folder', 'run', 'waitpoint']);
const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|input|body|headers?|prompt|code|document|snapshot|response|output|logs?|stack|note)/i;
const SENSITIVE_VALUE = /(?:^|\s)(?:bearer|basic)\s+\S+|\b(?:ghp_|github_pat_|xox[abprs]-|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.)|(?:password|secret|token|api[-_]?key)\s*[:=]/i;
function cleanText(value, maxLength = 180) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim().replace(/\s+/g, ' ');
    if (!text)
        return undefined;
    if (SENSITIVE_VALUE.test(text))
        return '[redacted]';
    return text.slice(0, maxLength);
}
function cleanTimestamp(value) {
    if (typeof value !== 'string')
        return undefined;
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}
export function sanitizeWorkflowAuditDetails(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const details = {};
    for (const [rawKey, rawValue] of Object.entries(value).slice(0, 16)) {
        const key = rawKey.trim().slice(0, 48);
        if (!key || SENSITIVE_KEY.test(key))
            continue;
        if (typeof rawValue === 'boolean')
            details[key] = rawValue;
        else if (typeof rawValue === 'number' && Number.isFinite(rawValue))
            details[key] = rawValue;
        else if (typeof rawValue === 'string') {
            const text = cleanText(rawValue, 160);
            if (text !== undefined)
                details[key] = text;
        }
    }
    return Object.keys(details).length ? details : undefined;
}
/** Normalize persisted entries before returning them to the browser. */
export function normalizeWorkflowAuditEvent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const input = value;
    const id = cleanText(input.id, 120);
    const at = cleanTimestamp(input.at);
    const action = input.action && ACTIONS.has(input.action) ? input.action : undefined;
    const targetType = input.target?.type && TARGET_TYPES.has(input.target.type) ? input.target.type : undefined;
    const targetId = cleanText(input.target?.id, 120);
    if (!id || !at || !action || !targetType || !targetId)
        return undefined;
    const name = cleanText(input.target?.name, 180);
    const details = sanitizeWorkflowAuditDetails(input.details);
    return {
        id,
        at,
        actor: input.actor === 'system' ? 'system' : 'local-user',
        action,
        target: { type: targetType, id: targetId, ...(name ? { name } : {}) },
        ...(details ? { details } : {}),
    };
}
export function createWorkflowAuditEvent(input) {
    const event = normalizeWorkflowAuditEvent(input);
    if (!event)
        throw new Error('invalid workflow audit event');
    return event;
}
/** Prepend one event, remove duplicate IDs, and enforce bounded retention. */
export function appendWorkflowAuditEvent(existing, event, retention = MAX_WORKFLOW_AUDIT_EVENTS) {
    const limit = Math.max(1, Math.min(MAX_WORKFLOW_AUDIT_EVENTS, Math.floor(retention) || MAX_WORKFLOW_AUDIT_EVENTS));
    const prior = (Array.isArray(existing) ? existing : [])
        .map(normalizeWorkflowAuditEvent)
        .filter((entry) => Boolean(entry && entry.id !== event.id))
        .sort((left, right) => right.at.localeCompare(left.at));
    return [event, ...prior].slice(0, limit);
}

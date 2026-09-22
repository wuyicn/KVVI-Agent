export const MAX_WORKFLOW_FOLDERS = 100;
export const MAX_WORKFLOW_FOLDER_NAME_LENGTH = 80;
const FOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
function positiveInteger(value, fallback) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
function normalizedTimestamp(value, fallback) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
        return fallback;
    return new Date(value).toISOString();
}
function nextUpdatedAt(previous, now) {
    const current = Date.parse(now);
    const prior = previous ? Date.parse(previous) : Number.NaN;
    return new Date(Number.isFinite(prior) ? Math.max(current, prior + 1) : current).toISOString();
}
/** Returns undefined for an empty or malformed optional folder assignment. */
export function normalizeWorkflowFolderId(value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string')
        return undefined;
    const id = value.trim();
    return FOLDER_ID.test(id) ? id : undefined;
}
export function requireWorkflowFolderId(value) {
    const id = normalizeWorkflowFolderId(value);
    if (!id)
        throw new Error('文件夹 ID 无效');
    return id;
}
export function normalizeWorkflowFolderName(value) {
    if (typeof value !== 'string')
        throw new Error('文件夹名称不能为空');
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name)
        throw new Error('文件夹名称不能为空');
    if (name.length > MAX_WORKFLOW_FOLDER_NAME_LENGTH)
        throw new Error(`文件夹名称不能超过 ${MAX_WORKFLOW_FOLDER_NAME_LENGTH} 个字符`);
    if (CONTROL_CHARACTER.test(name))
        throw new Error('文件夹名称包含无效字符');
    return name;
}
/** Drops malformed persisted records rather than exposing them to the browser. */
export function normalizeWorkflowFolder(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const input = value;
    const id = normalizeWorkflowFolderId(input.id);
    if (!id)
        return undefined;
    let name;
    try {
        name = normalizeWorkflowFolderName(input.name);
    }
    catch {
        return undefined;
    }
    const createdAt = normalizedTimestamp(input.createdAt, new Date(0).toISOString());
    const updatedAt = normalizedTimestamp(input.updatedAt, createdAt);
    return {
        id,
        name,
        revision: positiveInteger(input.revision, 1),
        createdAt,
        updatedAt: updatedAt < createdAt ? createdAt : updatedAt,
    };
}
export function createWorkflowFolder(input, now) {
    const id = requireWorkflowFolderId(input.id);
    const name = normalizeWorkflowFolderName(input.name);
    const at = normalizedTimestamp(now, new Date().toISOString());
    return { id, name, revision: 1, createdAt: at, updatedAt: at };
}
export function renameWorkflowFolder(existing, name, now) {
    const current = normalizeWorkflowFolder(existing);
    if (!current)
        throw new Error('文件夹记录无效');
    const nextName = normalizeWorkflowFolderName(name);
    if (nextName === current.name)
        return current;
    return {
        ...current,
        name: nextName,
        revision: current.revision + 1,
        updatedAt: nextUpdatedAt(current.updatedAt, now),
    };
}
export function workflowFolderRevisionMatches(existing, expectedRevision) {
    return Boolean(existing && existing.revision === Number(expectedRevision));
}
/** Move metadata only: execution snapshots and editable graph revisions remain intact. */
export function moveWorkflowToFolder(workflow, folderId, now) {
    const currentFolderId = normalizeWorkflowFolderId(workflow.folderId);
    const nextFolderId = normalizeWorkflowFolderId(folderId);
    if (currentFolderId === nextFolderId)
        return { ...workflow, folderId: nextFolderId };
    return {
        ...workflow,
        folderId: nextFolderId,
        revision: positiveInteger(workflow.revision, 1) + 1,
        updatedAt: nextUpdatedAt(workflow.updatedAt, now),
    };
}

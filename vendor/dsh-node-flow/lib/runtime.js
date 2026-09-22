/**
 * DSH plugin entry for dsh-node-flow.
 *
 * Registers same-origin HTTP routes so canvas nodes can really execute on the
 * host, plus a scheduled-task engine (cron → host graph walker).
 *
 * - `/dsh-node-flow/run` — execute a code node via `ctx.codeRuntime`.
 * - `/dsh-node-flow/run-agent` — delegate an agent node to a DSH
 *   subagent via `ctx.subagents`, parented on a live root agent.
 * - `/dsh-node-flow/{schedule,schedules,runs,models}` — schedule/list/runs
 *   management and the agent model dropdown.
 *
 * The host half waits for `webServer` (the standard `inject` property) so the
 * routes always mount on the live server. Optional services are re-read at
 * call time, so a late provider still works; without a service a route returns
 * a clear JSON error instead of failing the canvas.
 *
 * @module dsh-node-flow
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSavedWorkflow, executionDocument, normalizeSavedWorkflow, publishWorkflow, updateWorkflowDraft, workflowRevisionMatches } from './workflowProtocol.js';
import { MAX_WORKFLOW_FOLDERS, createWorkflowFolder, moveWorkflowToFolder, normalizeWorkflowFolder, normalizeWorkflowFolderName, renameWorkflowFolder, requireWorkflowFolderId, workflowFolderRevisionMatches } from './workflowFolderProtocol.js';
import { createWorkflowVersion, restoreWorkflowVersion, upsertWorkflowVersion } from './workflowVersionProtocol.js';
import { appendWorkflowAuditEvent, createWorkflowAuditEvent, normalizeWorkflowAuditEvent } from './auditLogProtocol.js';
import { cancelCredentialAuthorization, deleteCredential, exchangeOAuthAuthorizationCode, getOAuthAuthorizationConfig, listCredentialSummaries, markCredentialAuthorizationFailed, markCredentialAuthorizing, resolveCredentialHeaders, resolveWebhookSecret, saveCredential, testCredentialConnection } from './credentialStore.js';
import { buildAuthorizationUrl, createPkceVerifier, hashOAuthState } from './oauth2.js';
import { executeHttpNode, executePreparedHttpRequest, HttpNodeError } from './httpNode.js';
import { executeWithRetry, RetryExhaustedError } from './retryPolicy.js';
import { canResumeRun, recoverInterruptedRuns, upsertRunRecord } from './runProtocol.js';
import { evaluateResultExpression, renderResultTemplate } from './resultExpression.js';
import { deleteProjectVariable, extractNodeProjectVariableReferences, extractUnsafeProjectSecretReferences, listProjectSecretValues, listProjectVariableSummaries, redactProjectSecrets, resolveProjectVariables, resolvePublicProjectVariables, saveProjectVariable } from './projectVariableStore.js';
import { capturePublishedSubworkflows, renderSubworkflowInput, validateSubworkflowRuntimeCall, validateWorkflowContract } from './subworkflowProtocol.js';
import { connectorRegistry } from './connectorRegistry.js';
import { buildConnectorDynamicOptionsRequest, buildConnectorTriggerRequest, connectorDefinitionVersion, sanitizeConnectorDynamicOptions, validateConnectorNodeConfiguration } from './connectorSdk.js';
import { buildWebhookSuccessResponse, normalizeWebhookIdempotencyHeader, normalizeWebhookIdempotencyKey, normalizeWebhookIdempotencyTtl, normalizeWebhookSignatureHeader, validateWebhookConfiguration, verifyWebhookSignature, webhookRequestFingerprint } from './webhookProtocol.js';
import { claimWebhookIdempotency, completeWebhookIdempotency, releaseWebhookIdempotency, removeWebhookIdempotencyWorkflow } from './webhookIdempotencyStore.js';
import { canResolveWaitpoint, createDebugWaitpoint, createWorkflowWaitpoint, releaseOrphanedWaitpointClaims, sanitizeWaitpointRun, validateWorkflowDebugDocument, validateWorkflowWaitpoints, waitpointTimedOut, waitpointTokenHash, waitpointTokenMatches, WorkflowWaitSignal } from './waitpointProtocol.js';
import { claimDuePollingTriggers, completePollingTrigger, failPollingTrigger, pollingIntervalMs, releaseOrphanedPollingClaims, syncPollingTriggerStates, validatePollingTriggerGraph } from './pollingTriggerProtocol.js';
import { canStartQueuedWorkflowRun, decideWorkflowConcurrency, validateWorkflowConcurrency } from './workflowConcurrencyProtocol.js';
import { normalizeWorkflowExecutionLimits, validateWorkflowExecutionLimits } from './workflowExecutionLimits.js';
import { cronMatchesSchedule, formatScheduleTime, formatScheduleTimezone, nextScheduleFire, scheduleInstantMinuteKey, scheduleWallClockKey, validateScheduleConfiguration } from './scheduleProtocol.js';
import { deleteDataStoreValue, deleteDataStoreWorkflow, listDataStoreValues, normalizeDataStoreKey, normalizeDataStoreNamespace, normalizeDataStoreOperation, readDataStoreValue, validateDataStoreNodeConfiguration, writeDataStoreValue } from './dataStore.js';
export const name = 'dsh-node-flow';
export const inject = ['webServer'];
const pendingOAuthAuthorizations = new Map();
/** True when the request Origin matches its Host (same-origin gate for POST). */
function sameOrigin(request) {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (!origin || !host)
        return false;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}
/** Read a JSON request body with a size cap; rejects oversized payloads. */
async function readJsonBody(request, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buf = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
        size += buf.byteLength;
        if (size > maxBytes)
            throw new Error('request body too large');
        chunks.push(buf);
    }
    if (chunks.length === 0)
        return undefined;
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(merged));
}
async function readBodyBytes(request, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
        size += buffer.byteLength;
        if (size > maxBytes)
            throw new Error('request body too large');
        chunks.push(buffer);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}
function sendJson(response, status, payload) {
    response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}
function sendOAuthResult(response, ok, message) {
    const inlineJson = (value) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
    const safeMessage = inlineJson(message);
    const safePayload = inlineJson({ source: 'dsh-node-flow-oauth2', ok, message });
    response.writeHead(ok ? 200 : 400, {
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
    });
    response.end(`<!doctype html><meta charset="utf-8"><title>DSH OAuth2</title><style>body{font:15px system-ui;background:#111827;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:480px;padding:28px;border:1px solid #374151;border-radius:14px;background:#1f2937;text-align:center}button{margin-top:16px;padding:9px 16px;border:0;border-radius:8px;background:#2563eb;color:white}</style><div class="card"><h1>${ok ? '授权成功' : '授权失败'}</h1><p id="message"></p><button onclick="window.close()">关闭窗口</button></div><script>document.getElementById('message').textContent=${safeMessage};if(window.opener){window.opener.postMessage(${safePayload},window.location.origin)}if(${ok})setTimeout(()=>window.close(),900)</script>`);
}
/** Map a subagent stop reason to an error message; `undefined` means completed cleanly. */
function stopReasonError(result) {
    switch (result.stopReason) {
        case 'completed':
            return undefined;
        case 'aborted':
            return 'subagent run was cancelled';
        case 'error':
            return 'subagent run failed';
        case 'max-tokens':
            return 'subagent run hit its token limit before finishing';
        case 'refusal':
            return 'subagent declined the task';
        default:
            return `subagent run ended abnormally (${String(result.stopReason)})`;
    }
}
/** Join the text blocks of a subagent result output. */
function outputText(result) {
    return result.output
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
}
/** Pick a subagent provider: prefer known in-process names, else the first registered. */
function pickSubagentProvider(subagents) {
    for (const name of ['spawn', 'fork', 'acp']) {
        if (subagents.getProvider(name) !== undefined)
            return name;
    }
    const list = subagents.list();
    return list.length > 0 ? list[0] : undefined;
}
/**
 * Host bindings exposed to a code node program. The program runs as an async
 * function body and accesses these under one global `dsh` object:
 *
 * - `await dsh.fetch({ url, method?, headers?, body?, timeout? })` → HTTP via
 *   the host's global `fetch`; resolves to `{ status, ok, text, json }`.
 * - `await dsh.input(null)` → the previous node's output (the flow input).
 *   Note: the code-runtime requires every binding call to be passed a
 *   lossless-JSON argument, so `dsh.input()` with no args is rejected; pass
 *   `null` (the value is ignored, the flow input is returned).
 * - `await dsh.now(null)` → `{ iso, ts, local }`.
 */
function buildCodeBindings(input, variables = {}) {
    return [
        {
            global: 'dsh',
            functions: {
                fetch: async (args) => {
                    const a = (args ?? {});
                    if (typeof a.url !== 'string' || a.url.length === 0) {
                        throw new Error('dsh.fetch requires { url: string }');
                    }
                    const method = typeof a.method === 'string' ? a.method : 'GET';
                    const headers = a.headers !== null && typeof a.headers === 'object'
                        ? a.headers
                        : {};
                    const rawBody = a.body;
                    const body = rawBody === undefined
                        ? undefined
                        : typeof rawBody === 'string'
                            ? rawBody
                            : JSON.stringify(rawBody);
                    const controller = new AbortController();
                    const timeout = typeof a.timeout === 'number' ? a.timeout : 20_000;
                    const timer = setTimeout(() => controller.abort(new Error('dsh.fetch timed out')), timeout);
                    try {
                        const res = await fetch(a.url, { method, headers, body, signal: controller.signal });
                        const text = await res.text();
                        let json = null;
                        if (text.length > 0) {
                            try {
                                json = JSON.parse(text);
                            }
                            catch {
                                json = null;
                            }
                        }
                        return { status: res.status, ok: res.ok, text, json };
                    }
                    finally {
                        clearTimeout(timer);
                    }
                },
                input: async () => input ?? null,
                vars: async () => ({ ...variables }),
                now: async () => ({
                    iso: new Date().toISOString(),
                    ts: Date.now(),
                    local: new Date().toLocaleString(),
                }),
            },
        },
    ];
}
/**
 * Execute a Python code node via a host subprocess (DSH's `ctx.codeRuntime`
 * only ships a TypeScript backend). The program gets the flow input through
 * the `DSH_INPUT` env var and prints its result to stdout (captured as the
 * value); `urllib` is available for networking. A non-zero exit or stderr
 * becomes the node's error.
 */
function runPythonCode(code, input, signal, variables = {}) {
    const inputStr = typeof input === 'string'
        ? input
        : input === undefined || input === null
            ? ''
            : JSON.stringify(input);
    return new Promise((resolve) => {
        // PYTHONIOENCODING forces UTF-8 stdout, so Chinese/° survive the pipe
        // (Windows Python defaults to the console code page, which Node mis-decodes).
        const env = { ...process.env, DSH_INPUT: inputStr, DSH_VARS: JSON.stringify(variables), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
        // Prefer a conventional interpreter name; fall back to a couple of aliases.
        const candidates = ['python', 'python3', 'py'];
        const tryRun = (i) => {
            if (i >= candidates.length) {
                resolve({ logs: [], error: { kind: 'exception', message: 'no Python interpreter found (tried python, python3, py)' } });
                return;
            }
            const cmd = candidates[i];
            execFile(cmd, ['-u', '-c', code], { env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024, signal }, (error, stdout, stderr) => {
                // A "command not found" spawn error is indistinguishable from a broken
                // program for the first candidate suffix; fall through to the next.
                if (error && error.code === 'ENOENT') {
                    tryRun(i + 1);
                    return;
                }
                if (error) {
                    const aborted = error.name === 'AbortError';
                    const detail = aborted ? '运行超时' : (stderr || error.message || '').trim();
                    resolve({ logs: stdout ? [stdout.trim()] : [], error: { kind: aborted ? 'abort' : 'exception', message: detail || `python exited with code ${error.code ?? '?'}` } });
                    return;
                }
                const out = stdout.trim();
                resolve({ value: out, logs: out ? out.split('\n').filter((l) => l.trim().length > 0) : [] });
            });
        };
        tryRun(0);
    });
}
/** Guard `request.method !== 'POST'` with a 405 and a boolean signal to skip. */
function rejectNonPost(request, response) {
    if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return true;
    }
    return false;
}
/**
 * Create a run signal that aborts after `timeoutSec` seconds (0 / NaN / empty =
 * no timeout). `isTimeout()` distinguishes a timeout abort from a caller
 * disconnect, so handlers can report "运行超时" specifically.
 */
function makeTimeoutSignal(timeoutSec, parentSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const sec = Math.max(0, Math.floor(Number(timeoutSec)) || 0);
    const timer = sec > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, sec * 1000) : undefined;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted)
        abortFromParent();
    else
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    return {
        signal: controller.signal,
        seconds: sec,
        isTimeout: () => timedOut,
        clear: () => {
            if (timer)
                clearTimeout(timer);
            parentSignal?.removeEventListener('abort', abortFromParent);
        },
    };
}
class WorkflowExecutionLimitError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'WorkflowExecutionLimitError';
    }
}
function dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}
function dataDir() {
    return join(dshHome(), 'workflow-canvas');
}
function schedulesFile() {
    return join(dataDir(), 'schedules.json');
}
function runsFile() {
    return join(dataDir(), 'runs.json');
}
function workflowsFile() {
    return join(dataDir(), 'workflows.json');
}
function workflowVersionsFile() {
    return join(dataDir(), 'workflow-versions.json');
}
function workflowFoldersFile() {
    return join(dataDir(), 'workflow-folders.json');
}
function auditLogFile() {
    return join(dataDir(), 'audit-log.json');
}
function pollingTriggersFile() {
    return join(dataDir(), 'polling-triggers.json');
}
function webhookIdempotencyDataDir() {
    return dataDir();
}
function credentialDataDir() {
    return dataDir();
}
function projectVariableDataDir() {
    return dataDir();
}
function readJson(file, fallback) {
    try {
        if (!existsSync(file))
            return fallback;
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
function writeJson(file, data) {
    try {
        mkdirSync(dataDir(), { recursive: true });
        const temporary = `${file}.tmp-${process.pid}`;
        const json = JSON.stringify(data, null, 2);
        writeFileSync(temporary, json);
        try {
            renameSync(temporary, file);
        }
        catch {
            writeFileSync(file, json);
            try {
                unlinkSync(temporary);
            }
            catch { /* best-effort cleanup */ }
        }
    }
    catch {
        /* persistence is best-effort */
    }
}
function loadSchedules() {
    return readJson(schedulesFile(), []);
}
function saveSchedules(list) {
    writeJson(schedulesFile(), list);
}
function scheduleResponseRecord(schedule, now = new Date()) {
    try {
        const configuration = validateScheduleConfiguration(schedule.cron, schedule.timezone);
        const next = nextScheduleFire(configuration.cron, now, configuration.timezone, schedule.lastFiredWallClock);
        return {
            id: schedule.id,
            workflowId: schedule.workflowId,
            name: schedule.name,
            cron: configuration.cron,
            timezone: configuration.timezone,
            timezoneLabel: formatScheduleTimezone(configuration.timezone),
            input: schedule.input,
            lastFired: formatScheduleTime(schedule.lastFired, configuration.timezone),
            lastFiredAt: schedule.lastFired,
            nextFire: next ? formatScheduleTime(next, configuration.timezone) : undefined,
            nextFireAt: next?.toISOString(),
            doc: schedule.doc,
        };
    }
    catch (error) {
        return {
            id: schedule.id,
            workflowId: schedule.workflowId,
            name: schedule.name,
            cron: schedule.cron,
            timezone: schedule.timezone,
            timezoneLabel: schedule.timezone ? `无效时区（${schedule.timezone}）` : formatScheduleTimezone(),
            input: schedule.input,
            lastFired: schedule.lastFired,
            lastFiredAt: schedule.lastFired,
            doc: schedule.doc,
            configurationError: error instanceof Error ? error.message : String(error),
        };
    }
}
function loadWorkflowAuditLog() {
    return readJson(auditLogFile(), [])
        .map(normalizeWorkflowAuditEvent)
        .filter((event) => Boolean(event));
}
function saveWorkflowAuditLog(events) {
    writeJson(auditLogFile(), events);
}
function loadRuns() {
    return readJson(runsFile(), []);
}
function saveRuns(runs) {
    const secrets = listProjectSecretValues(projectVariableDataDir());
    const sanitized = runs.map((run) => redactRunPayload(redactProjectSecrets(run, secrets)));
    const active = sanitized.filter((run) => run.status === 'queued' || run.status === 'running' || (run.status === 'waiting' && !run.resumedByRunId));
    const history = sanitized.filter((run) => run.status !== 'queued' && run.status !== 'running' && (run.status !== 'waiting' || Boolean(run.resumedByRunId))).slice(0, 200);
    writeJson(runsFile(), [...active, ...history].sort((left, right) => right.startedAt.localeCompare(left.startedAt)));
}
function saveRun(run) {
    const secrets = listProjectSecretValues(projectVariableDataDir());
    saveRuns(upsertRunRecord(loadRuns(), redactProjectSecrets(run, secrets)));
}
function sanitizeRun(run) {
    const redacted = redactRunPayload(redactProjectSecrets(sanitizeWaitpointRun(run), listProjectSecretValues(projectVariableDataDir())));
    const { replayInput: _replayInput, webhookIdempotencyId: _webhookIdempotencyId, ...visible } = redacted;
    return {
        ...visible,
        waitpoint: visible.waitpoint
            ? { ...visible.waitpoint, input: '[redacted]' }
            : undefined,
    };
}
const REPLAY_INPUT_LIMIT_BYTES = 64 * 1024;
const SENSITIVE_REPLAY_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential)/i;
const SENSITIVE_REPLAY_VALUE = /(?:^|\s)(?:bearer|basic)\s+\S+|\b(?:ghp_|github_pat_|xox[abprs]-|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.)/i;
function hasSensitiveReplayValue(value) {
    if (typeof value === 'string')
        return SENSITIVE_REPLAY_VALUE.test(value);
    if (Array.isArray(value))
        return value.some(hasSensitiveReplayValue);
    if (!value || typeof value !== 'object')
        return false;
    return Object.entries(value).some(([key, item]) => SENSITIVE_REPLAY_KEY.test(key) || hasSensitiveReplayValue(item));
}
function containsProjectSecret(value, secrets) {
    if (typeof value === 'string')
        return secrets.some((secret) => secret.length > 0 && value.includes(secret));
    if (Array.isArray(value))
        return value.some((item) => containsProjectSecret(item, secrets));
    if (!value || typeof value !== 'object')
        return false;
    return Object.values(value).some((item) => containsProjectSecret(item, secrets));
}
function captureReplayInput(input) {
    try {
        const serialized = JSON.stringify(input);
        if (serialized === undefined)
            return { available: true };
        if (Buffer.byteLength(serialized, 'utf8') > REPLAY_INPUT_LIMIT_BYTES)
            return { available: false };
        const clone = JSON.parse(serialized);
        const projectSecrets = listProjectSecretValues(projectVariableDataDir());
        return hasSensitiveReplayValue(clone) || containsProjectSecret(clone, projectSecrets)
            ? { available: false }
            : { available: true, input: clone };
    }
    catch {
        return { available: false };
    }
}
function hasUnsafePersistentInput(input) {
    return hasSensitiveReplayValue(input)
        || containsProjectSecret(input, listProjectSecretValues(projectVariableDataDir()));
}
function redactSensitiveRunValue(value) {
    const visit = (candidate) => {
        if (typeof candidate === 'string') {
            if (SENSITIVE_REPLAY_VALUE.test(candidate))
                return '[redacted]';
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object')
                    return JSON.stringify(visit(parsed));
            }
            catch {
                // Plain text values do not need structural redaction.
            }
            return candidate;
        }
        if (Array.isArray(candidate))
            return candidate.map(visit);
        if (!candidate || typeof candidate !== 'object')
            return candidate;
        return Object.fromEntries(Object.entries(candidate).map(([key, item]) => [key, SENSITIVE_REPLAY_KEY.test(key) ? '[redacted]' : visit(item)]));
    };
    return visit(value);
}
function errorRouteMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    const httpStatus = /\bHTTP\s+([1-5]\d{2})\b/i.exec(message)?.[1];
    return httpStatus ? `HTTP ${httpStatus} 请求失败` : '节点执行失败';
}
function redactRunPayload(run) {
    return {
        ...run,
        value: redactSensitiveRunValue(run.value),
        nodes: run.nodes.map((node) => ({
            ...node,
            input: redactSensitiveRunValue(node.input),
            output: redactSensitiveRunValue(node.output),
            logs: redactSensitiveRunValue(node.logs),
            error: redactSensitiveRunValue(node.error),
        })),
        checkpoint: run.checkpoint
            ? { ...run.checkpoint, input: redactSensitiveRunValue(run.checkpoint.input) }
            : undefined,
        waitpoint: run.waitpoint
            ? {
                ...run.waitpoint,
                input: redactSensitiveRunValue(run.waitpoint.input),
                timeoutValue: redactSensitiveRunValue(run.waitpoint.timeoutValue),
            }
            : undefined,
    };
}
function sanitizeRunDetail(run) {
    const visible = sanitizeRun(run);
    const { snapshot: _snapshot, subworkflowSnapshots: _subworkflowSnapshots, queue: _queue, checkpoint: _checkpoint, replayInput: _replayInput, ...detail } = visible;
    const waitpoint = detail.waitpoint;
    return redactSensitiveRunValue({
        ...detail,
        waitpoint: waitpoint ? {
            nodeId: waitpoint.nodeId,
            mode: waitpoint.mode,
            createdAt: waitpoint.createdAt,
            input: '[redacted]',
            resumeAt: waitpoint.resumeAt,
            expiresAt: waitpoint.expiresAt,
            debugReason: waitpoint.debugReason,
            previousNodeId: waitpoint.previousNodeId,
            childRunId: waitpoint.childRunId,
            parentRunId: waitpoint.parentRunId,
            parentNodeId: waitpoint.parentNodeId,
        } : undefined,
    });
}
function canReplayPersistedRun(run) {
    return Boolean(run.workflowId
        && run.snapshot
        && run.replayInputAvailable
        && !run.parentRunId
        && !run.resumedFromRunId
        && (run.trigger === 'manual' || run.trigger === 'replay')
        && ['ok', 'handled', 'error', 'cancelled', 'interrupted'].includes(run.status));
}
function summarizeRun(run) {
    const waitpoint = run.waitpoint;
    return {
        id: run.id,
        workflowId: run.workflowId,
        scheduleId: run.scheduleId,
        name: run.name,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        nodeCount: run.nodeCount,
        status: run.status,
        trigger: run.trigger,
        failed: run.failed,
        timedOut: run.timedOut,
        limitReason: run.limitReason,
        handledErrors: run.handledErrors ?? 0,
        resumable: run.resumable,
        resumedFromRunId: run.resumedFromRunId,
        resumedByRunId: run.resumedByRunId,
        replayedFromRunId: run.replayedFromRunId,
        parentRunId: run.parentRunId,
        parentNodeId: run.parentNodeId,
        rootRunId: run.rootRunId,
        depth: run.depth,
        skipReason: run.skipReason,
        waitpoint: waitpoint ? {
            nodeId: waitpoint.nodeId,
            mode: waitpoint.mode,
            createdAt: waitpoint.createdAt,
            resumeAt: waitpoint.resumeAt,
            expiresAt: waitpoint.expiresAt,
            debugReason: waitpoint.debugReason,
            previousNodeId: waitpoint.previousNodeId,
            childRunId: waitpoint.childRunId,
            parentRunId: waitpoint.parentRunId,
            parentNodeId: waitpoint.parentNodeId,
        } : undefined,
        replayable: canReplayPersistedRun(run),
    };
}
function projectVariableReferences(name) {
    const references = [];
    for (const workflow of loadWorkflows()) {
        for (const [scope, document] of [['draft', workflow.doc], ['published', workflow.publishedDoc]]) {
            if (!document)
                continue;
            for (const node of document.nodes) {
                if (!extractNodeProjectVariableReferences(node.data).includes(name))
                    continue;
                references.push({ workflowId: workflow.id, workflowName: workflow.name, nodeId: node.id, nodeLabel: node.data.label, scope });
            }
        }
    }
    return references;
}
function sortWorkflowFolders(folders) {
    return [...folders].sort((left, right) => {
        const name = left.name.localeCompare(right.name, 'zh-CN');
        return name !== 0 ? name : left.id.localeCompare(right.id);
    });
}
function loadWorkflowFolders() {
    const folders = new Map();
    const stored = readJson(workflowFoldersFile(), []);
    for (const raw of Array.isArray(stored) ? stored : []) {
        const folder = normalizeWorkflowFolder(raw);
        if (folder && !folders.has(folder.id))
            folders.set(folder.id, folder);
    }
    return sortWorkflowFolders([...folders.values()]);
}
function saveWorkflowFolders(folders) {
    writeJson(workflowFoldersFile(), sortWorkflowFolders(folders));
}
function existingFolderForId(folders, value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    const folderId = requireWorkflowFolderId(value);
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder)
        throw new Error('目标文件夹不存在');
    return folder;
}
function loadWorkflows() {
    const folderIds = new Set(loadWorkflowFolders().map((folder) => folder.id));
    const stored = readJson(workflowsFile(), []);
    return (Array.isArray(stored) ? stored : []).map((workflow) => normalizeSavedWorkflow(workflow)).map((workflow) => {
        if (!workflow.folderId || folderIds.has(workflow.folderId))
            return workflow;
        return { ...workflow, folderId: undefined };
    });
}
function saveWorkflows(workflows) {
    writeJson(workflowsFile(), workflows);
}
function loadWorkflowVersions() {
    return readJson(workflowVersionsFile(), []);
}
function saveWorkflowVersions(versions) {
    writeJson(workflowVersionsFile(), versions);
}
function pinDocumentConnectorVersions(document) {
    let changed = false;
    const nodes = document.nodes.map((node) => {
        if (!['connector', 'connector-trigger'].includes(node.data.kind) || !node.data.connectorId || node.data.connectorVersion !== undefined)
            return node;
        const definition = connectorRegistry.get(node.data.connectorId);
        if (!definition)
            return node;
        changed = true;
        return { ...node, data: { ...node.data, connectorVersion: connectorDefinitionVersion(definition) } };
    });
    return changed ? { ...document, nodes } : document;
}
function pinWorkflowConnectorVersions(workflow) {
    const doc = pinDocumentConnectorVersions(workflow.doc);
    const publishedDoc = workflow.publishedDoc ? pinDocumentConnectorVersions(workflow.publishedDoc) : undefined;
    return doc === workflow.doc && publishedDoc === workflow.publishedDoc ? workflow : { ...workflow, doc, publishedDoc };
}
function migratePersistedConnectorVersions() {
    const workflows = readJson(workflowsFile(), []);
    const pinnedWorkflows = workflows.map(pinWorkflowConnectorVersions);
    if (pinnedWorkflows.some((workflow, index) => workflow !== workflows[index]))
        writeJson(workflowsFile(), pinnedWorkflows);
    const schedules = readJson(schedulesFile(), []);
    const pinnedSchedules = schedules.map((schedule) => schedule.doc ? { ...schedule, doc: pinDocumentConnectorVersions(schedule.doc) } : schedule);
    if (pinnedSchedules.some((schedule, index) => schedule.doc !== schedules[index]?.doc))
        writeJson(schedulesFile(), pinnedSchedules);
    const versions = readJson(workflowVersionsFile(), []);
    const pinnedVersions = versions.map((version) => {
        const doc = pinDocumentConnectorVersions(version.doc);
        const publishedDoc = version.publishedDoc ? pinDocumentConnectorVersions(version.publishedDoc) : undefined;
        return doc === version.doc && publishedDoc === version.publishedDoc ? version : { ...version, doc, publishedDoc };
    });
    if (pinnedVersions.some((version, index) => version !== versions[index]))
        writeJson(workflowVersionsFile(), pinnedVersions);
    const runs = readJson(runsFile(), []);
    const pinnedRuns = runs.map((run) => {
        const snapshot = run.snapshot ? pinDocumentConnectorVersions(run.snapshot) : undefined;
        const subworkflowSnapshots = run.subworkflowSnapshots && Object.fromEntries(Object.entries(run.subworkflowSnapshots).map(([id, value]) => [id, { ...value, doc: pinDocumentConnectorVersions(value.doc) }]));
        return snapshot === run.snapshot && JSON.stringify(subworkflowSnapshots) === JSON.stringify(run.subworkflowSnapshots) ? run : { ...run, snapshot, subworkflowSnapshots };
    });
    if (pinnedRuns.some((run, index) => run !== runs[index]))
        writeJson(runsFile(), pinnedRuns);
}
function loadPollingTriggers() {
    return readJson(pollingTriggersFile(), []);
}
function savePollingTriggers(states) {
    writeJson(pollingTriggersFile(), states);
}
function pollingTriggerSummary(state) {
    return {
        id: state.id,
        workflowId: state.workflowId,
        nodeId: state.nodeId,
        connectorId: state.connectorId,
        triggerId: state.triggerId,
        initialized: state.initialized,
        nextPollAt: state.nextPollAt,
        lastPolledAt: state.lastPolledAt,
        lastEventAt: state.lastEventAt,
        lastError: state.lastError,
        active: Boolean(state.claimedAt),
    };
}
function saveWorkflowVersion(workflow, kind, sourceVersionId) {
    const version = createWorkflowVersion(workflow, kind, workflow.updatedAt, sourceVersionId);
    saveWorkflowVersions(upsertWorkflowVersion(loadWorkflowVersions(), version));
    return version;
}
function ensureWorkflowVersions(workflows) {
    let versions = loadWorkflowVersions();
    let changed = false;
    for (const workflow of workflows) {
        // Folder-only moves update the record revision so stale editors conflict,
        // but do not create a document version or change a published snapshot.
        if (versions.some((version) => version.workflowId === workflow.id
            && version.draftRevision === workflow.draftRevision
            && version.publishedRevision === workflow.publishedRevision
            && version.status === workflow.status))
            continue;
        versions = upsertWorkflowVersion(versions, createWorkflowVersion(workflow, 'imported', workflow.updatedAt));
        changed = true;
    }
    if (changed)
        saveWorkflowVersions(versions);
    return versions;
}
function syncWorkflowSchedules(workflow) {
    const prefix = `workflow:${workflow.id}:`;
    const current = loadSchedules();
    const previous = new Map(current.filter((schedule) => schedule.id.startsWith(prefix)).map((schedule) => [schedule.id, schedule]));
    const schedules = current.filter((schedule) => !schedule.id.startsWith(prefix));
    if (workflow.status === 'enabled') {
        const document = executionDocument(workflow);
        for (const node of document.nodes) {
            if (node.data.kind !== 'schedule' || !node.data.cron?.trim())
                continue;
            const scheduleId = `${prefix}${node.id}`;
            const configuration = validateScheduleConfiguration(node.data.cron, node.data.timezone);
            const prior = previous.get(scheduleId);
            const preserveFireState = prior?.cron === configuration.cron && prior.timezone === configuration.timezone;
            schedules.push({
                id: scheduleId,
                workflowId: workflow.id,
                name: `${workflow.name} · ${node.data.label}`,
                cron: configuration.cron,
                ...(configuration.timezone ? { timezone: configuration.timezone } : {}),
                input: node.data.text ?? '',
                steps: [],
                doc: document,
                ...(preserveFireState && prior?.lastFired ? { lastFired: prior.lastFired } : {}),
                ...(preserveFireState && prior?.lastFiredWallClock ? { lastFiredWallClock: prior.lastFiredWallClock } : {}),
            });
        }
    }
    saveSchedules(schedules);
}
async function syncWorkflowPollingTriggers(workflow) {
    const document = workflow.status === 'enabled' ? executionDocument(workflow) : undefined;
    const variables = resolveProjectVariables(projectVariableDataDir());
    await withPollingTriggerMutation(() => {
        const current = loadPollingTriggers();
        const next = syncPollingTriggerStates(current, workflow.id, document, Date.now(), variables);
        const nextById = new Map(next.map((state) => [state.id, state]));
        for (const state of current.filter((candidate) => candidate.workflowId === workflow.id)) {
            const replacement = nextById.get(state.id);
            if (!replacement || replacement.configurationHash !== state.configurationHash)
                activePollingTriggers.get(state.id)?.controller.abort(new Error('轮询触发器配置已更新'));
        }
        savePollingTriggers(next);
    });
}
function removeWorkflowSchedules(workflowId) {
    const prefix = `workflow:${workflowId}:`;
    saveSchedules(loadSchedules().filter((schedule) => !schedule.id.startsWith(prefix)));
}
async function removeWorkflowPollingTriggers(workflowId) {
    await withPollingTriggerMutation(() => {
        for (const [id, active] of activePollingTriggers)
            if (id.startsWith(`workflow:${workflowId}:`))
                active.controller.abort(new Error('工作流已停用'));
        savePollingTriggers(loadPollingTriggers().filter((state) => state.workflowId !== workflowId));
    });
}
function removeWorkflowVersions(workflowId) {
    saveWorkflowVersions(loadWorkflowVersions().filter((version) => version.workflowId !== workflowId));
}
function validateWebhookPublish(workflow, workflows) {
    const webhookNodes = workflow.doc.nodes.filter((node) => node.data.kind === 'webhook');
    const tokens = webhookNodes.map((node) => node.data.webhookToken || '');
    if (tokens.some((token) => token.length < 24))
        return 'Webhook 节点缺少有效 token，请删除后重新添加该节点';
    if (new Set(tokens).size !== tokens.length)
        return '当前工作流中存在重复的 Webhook token';
    const activeTokens = new Set(workflows
        .filter((candidate) => candidate.id !== workflow.id && candidate.status === 'enabled')
        .flatMap((candidate) => candidate.publishedDoc?.nodes.filter((node) => node.data.kind === 'webhook').map((node) => node.data.webhookToken || '') ?? []));
    if (tokens.some((token) => activeTokens.has(token)))
        return 'Webhook URL 已被另一个已启用工作流占用';
    try {
        const credentialIds = new Set(listCredentialSummaries(credentialDataDir()).filter((credential) => credential.kind === 'webhook-secret').map((credential) => credential.id));
        for (const node of webhookNodes) {
            validateWebhookConfiguration(node.data);
            if (node.data.credentialId && !credentialIds.has(node.data.credentialId))
                return `Webhook 节点“${node.data.label}”引用的 Webhook Secret 不存在`;
        }
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return undefined;
}
function validateWorkflowErrorRoutes(document) {
    const nodeIds = new Set(document.nodes.map((node) => node.id));
    const executableKinds = new Set(['agent', 'code', 'http', 'connector', 'data-store', 'call-workflow']);
    for (const node of document.nodes) {
        const behavior = node.data.onError ?? 'stop';
        if (!['stop', 'continue', 'route'].includes(behavior))
            throw new Error(`节点“${node.data.label}”的失败行为无效`);
        const errorEdges = document.edges.filter((edge) => edge.source === node.id && edge.sourceHandle === 'error');
        if (errorEdges.length > 0 && !executableKinds.has(node.data.kind))
            throw new Error(`节点“${node.data.label}”不支持错误分支`);
        if (behavior === 'route') {
            if (!executableKinds.has(node.data.kind))
                throw new Error(`节点“${node.data.label}”不支持错误分支`);
            if (errorEdges.length === 0)
                throw new Error(`节点“${node.data.label}”已选择“路由到错误分支”，但未连接 error 端口`);
            if (errorEdges.some((edge) => !nodeIds.has(edge.target) || edge.target === node.id))
                throw new Error(`节点“${node.data.label}”的错误分支无效`);
        }
    }
}
function validateWorkflowSchedules(document) {
    for (const node of document.nodes) {
        if (node.data.kind !== 'schedule')
            continue;
        try {
            validateScheduleConfiguration(node.data.cron, node.data.timezone);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Schedule 节点“${node.data.label}”配置无效：${detail}`);
        }
    }
}
function validateWorkflowDataStores(document) {
    for (const node of document.nodes) {
        if (node.data.kind !== 'data-store')
            continue;
        try {
            validateDataStoreNodeConfiguration(node.data);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Data Store 节点“${node.data.label}”配置无效：${detail}`);
        }
    }
}
function validateWorkflowPublish(workflow, workflows) {
    const webhookError = validateWebhookPublish(workflow, workflows);
    if (webhookError)
        return webhookError;
    try {
        validateWorkflowConcurrency(workflow.doc.concurrency);
        validateWorkflowExecutionLimits(workflow.doc.executionLimits);
        validateWorkflowErrorRoutes(workflow.doc);
        validateWorkflowSchedules(workflow.doc);
        validateWorkflowDataStores(workflow.doc);
        validateWorkflowWaitpoints(workflow.doc);
        validatePollingTriggerGraph(workflow.doc);
        const credentials = listCredentialSummaries(credentialDataDir());
        const variableSummaries = listProjectVariableSummaries(projectVariableDataDir());
        const variables = new Set(variableSummaries.map((variable) => variable.name));
        const secretVariables = new Set(variableSummaries.filter((variable) => variable.kind === 'secret').map((variable) => variable.name));
        const missingVariables = [...new Set(workflow.doc.nodes.flatMap((node) => extractNodeProjectVariableReferences(node.data)))].filter((name) => !variables.has(name));
        if (missingVariables.length > 0)
            return `工作流引用了不存在的项目变量：${missingVariables.join('、')}`;
        for (const node of workflow.doc.nodes) {
            const unsafeSecrets = extractUnsafeProjectSecretReferences(node.data).filter((name) => secretVariables.has(name));
            if (unsafeSecrets.length > 0)
                return `节点“${node.data.label}”会将 Secret 变量暴露到输出、Agent 或外部响应：${unsafeSecrets.join('、')}`;
        }
        for (const node of workflow.doc.nodes) {
            if (node.data.kind !== 'connector' && node.data.kind !== 'connector-trigger')
                continue;
            const credential = credentials.find((candidate) => candidate.id === node.data.credentialId);
            validateConnectorNodeConfiguration(connectorRegistry.list(), node.data, credential);
            if (node.data.kind === 'connector-trigger')
                buildConnectorTriggerRequest(connectorRegistry.list(), node.data, credential);
        }
        const snapshots = capturePublishedSubworkflows(workflow.id, workflow.doc, workflows);
        return undefined;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
function activeWorkflowReferences(workflowId, workflows) {
    return workflows.filter((workflow) => workflow.id !== workflowId
        && workflow.status === 'enabled'
        && workflow.publishedDoc?.nodes.some((node) => node.data.kind === 'call-workflow' && node.data.workflowId === workflowId));
}
function stringifyValue(value) {
    return value === undefined || value === null
        ? ''
        : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
}
/* --------------- host graph walker (mirrors the client Run loop) --------------- */
function evalExprHost(expr, result, variables) {
    return evaluateResultExpression(expr, result, variables);
}
function evalConditionHost(expr, result, variables) {
    return Boolean(evalExprHost(expr, result, variables));
}
function renderTemplateHost(template, result, variables) {
    return renderResultTemplate(template, result, variables);
}
function parseDataStoreTemplate(template, result, variables) {
    const rendered = renderTemplateHost(template, result, variables).trim();
    if (!rendered)
        return '';
    try {
        return JSON.parse(rendered);
    }
    catch {
        return rendered;
    }
}
let dataStoreMutationQueue = Promise.resolve();
async function withDataStoreMutation(operation) {
    const previous = dataStoreMutationQueue;
    let release;
    dataStoreMutationQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
    }
}
async function executeDataStoreNode(dataDirectory, workflowId, data, input, variables) {
    if (!workflowId)
        throw new Error('Data Store 节点只能在已保存的工作流中运行');
    const namespace = normalizeDataStoreNamespace(data.storeNamespace);
    const operation = normalizeDataStoreOperation(data.storeOperation);
    const key = ['get', 'set', 'delete'].includes(operation) ? normalizeDataStoreKey(String(parseDataStoreTemplate(data.storeKey ?? '', input, variables)), '键') : undefined;
    return await withDataStoreMutation(() => {
        if (operation === 'get') {
            const record = readDataStoreValue(dataDirectory, workflowId, namespace, key);
            return record ? { found: true, key: record.key, value: record.value, updatedAt: record.updatedAt } : { found: false, key: key };
        }
        if (operation === 'set') {
            const value = parseDataStoreTemplate(data.storeValue ?? '{{result}}', input, variables);
            const record = writeDataStoreValue(dataDirectory, workflowId, namespace, key, value);
            return { stored: true, key: record.key, value: record.value, updatedAt: record.updatedAt };
        }
        if (operation === 'delete')
            return { deleted: deleteDataStoreValue(dataDirectory, workflowId, namespace, key), key: key };
        const prefix = renderTemplateHost(data.storePrefix ?? '', input, variables);
        const items = listDataStoreValues(dataDirectory, workflowId, namespace, prefix);
        return { items, count: items.length, prefix };
    });
}
/** Parse a node's `"provider|model"` route into subagent `agentOptions`. */
function parseAgentOptions(model) {
    if (!model)
        return undefined;
    const i = model.indexOf('|');
    if (i <= 0)
        return undefined;
    const provider = model.slice(0, i);
    const m = model.slice(i + 1);
    return provider && m ? { provider, model: m } : undefined;
}
/**
 * Execute a full workflow document as a graph (branching + loop/while), so a
 * scheduled run behaves like a manual Run. Returns a {@link RunRecord} with
 * one entry per executed node.
 */
async function runDocumentGraph(ctx, doc, initialInput, options = {}) {
    const variables = options.variables ?? resolveProjectVariables(projectVariableDataDir());
    const secretVariableNames = new Set(listProjectVariableSummaries(projectVariableDataDir()).filter((variable) => variable.kind === 'secret').map((variable) => variable.name));
    const projectSecrets = listProjectSecretValues(projectVariableDataDir());
    const safeValue = (value) => redactProjectSecrets(value, projectSecrets);
    const docNodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
    const docEdges = Array.isArray(doc?.edges) ? doc.edges : [];
    const byId = new Map(docNodes.map((n) => [n.id, n]));
    const edgesFrom = (id) => docEdges.filter((e) => e.source === id);
    const successEdgesFrom = (id) => edgesFrom(id).filter((edge) => edge.sourceHandle !== 'error');
    const errorEdgesFrom = (id) => edgesFrom(id).filter((edge) => edge.sourceHandle === 'error');
    const records = new Map((options.priorNodes ?? []).map((record) => [record.id, { ...record }]));
    const visited = new Set();
    let budget = 0;
    const limits = normalizeWorkflowExecutionLimits(doc.executionLimits);
    let ran = false;
    let lastOutput = typeof initialInput === 'string' ? initialInput : '';
    const initialText = stringifyValue(initialInput);
    const recFor = (id) => {
        let r = records.get(id);
        if (!r) {
            r = { id, kind: String(byId.get(id)?.data.kind ?? ''), status: 'skipped', ms: 0 };
            records.set(id, r);
        }
        return r;
    };
    // Run one loop/while body iteration (fresh visited per iteration; `stopAt`
    // ends the sub-walk when control flows back to the loop node).
    const runLoopBody = async (iterateId, loopId, input) => {
        if (!iterateId)
            return input;
        const bodyVisited = new Set(visited);
        return await executeNode(iterateId, input, bodyVisited, loopId);
    };
    const executeNode = async (id, input, ctxVisited, stopAt) => {
        if (options.signal?.aborted)
            throw new Error('运行已取消');
        if (!byId.has(id))
            return input;
        if (id === stopAt)
            return input;
        if (ctxVisited.has(id))
            return input;
        ctxVisited.add(id);
        ran = true;
        budget += 1;
        if (budget > limits.maxSteps) {
            options.onCheckpoint?.(id, input, [...records.values()], true);
            throw new WorkflowExecutionLimitError('steps', `超过运行步数上限（${limits.maxSteps}）`);
        }
        const n = byId.get(id);
        const d = n.data;
        const rec = recFor(id);
        const t0 = Date.now();
        const setRec = (patch) => {
            Object.assign(rec, safeValue(patch));
            rec.ms = Date.now() - t0;
            options.onProgress?.([...records.values()], lastOutput);
        };
        const onError = d.onError === 'continue' || d.onError === 'route' ? d.onError : 'stop';
        const pauseForDebugger = (reason, nodeId, nodeInput, previousNodeId) => {
            if (hasUnsafePersistentInput(nodeInput))
                throw new Error('调试暂停输入含认证字段或项目 Secret，无法安全持久化');
            const target = recFor(nodeId);
            Object.assign(target, {
                status: 'skipped',
                input: safeValue(nodeInput),
                debugPaused: true,
                error: undefined,
                ms: 0,
            });
            options.onProgress?.([...records.values()], lastOutput);
            throw new WorkflowWaitSignal(createDebugWaitpoint(nodeId, safeValue(nodeInput), reason, previousNodeId));
        };
        if (options.debug && d.breakpoint && options.skipBreakpointNodeId !== id) {
            pauseForDebugger('breakpoint', id, input);
        }
        Object.assign(rec, { status: 'running', input: safeValue(input), error: undefined, debugPaused: undefined, ms: 0 });
        options.onCheckpoint?.(id, input, [...records.values()]);
        const fanOut = async (value) => {
            if (options.singleNode && id === options.startNodeId)
                return value;
            if (options.debugStepAfterNodeId === id) {
                const successors = successEdgesFrom(id);
                if (successors.length === 1)
                    pauseForDebugger('step', successors[0].target, value, id);
            }
            let last = value;
            for (const e of successEdgesFrom(id))
                last = await executeNode(e.target, value, ctxVisited, stopAt);
            return last;
        };
        const routeError = async (error, attempts = 1) => {
            if (onError !== 'route' || options.singleNode)
                return undefined;
            const routes = errorEdgesFrom(id).filter((edge) => edge.target !== id);
            if (routes.length === 0)
                return undefined;
            const message = errorRouteMessage(error);
            const event = {
                type: 'workflow-node-error',
                error: {
                    message,
                    nodeId: id,
                    nodeLabel: d.label,
                    nodeKind: d.kind,
                    attempts,
                    occurredAt: new Date().toISOString(),
                },
            };
            setRec({ errorHandled: true });
            let last = stringifyValue(event);
            for (const edge of routes)
                last = await executeNode(edge.target, stringifyValue(event), ctxVisited, stopAt);
            return last;
        };
        try {
            const unsafeSecrets = extractUnsafeProjectSecretReferences(d).filter((name) => secretVariableNames.has(name));
            if (unsafeSecrets.length > 0)
                throw new Error(`Secret 变量不能用于该节点的对外输出：${unsafeSecrets.join('、')}`);
            if (d.kind === 'trigger' || d.kind === 'schedule' || d.kind === 'webhook' || d.kind === 'connector-trigger') {
                const value = d.kind === 'webhook' || d.kind === 'connector-trigger' ? input : input || renderResultTemplate(d.text ?? '', input, variables);
                setRec({ status: 'ok', output: value });
                return await fanOut(value);
            }
            else if (d.kind === 'wait') {
                if (stopAt)
                    throw new Error('Wait 节点暂不支持放在 Loop 或 While 内部');
                const waitpoint = createWorkflowWaitpoint(d, id, safeValue(input));
                setRec({ status: 'ok', output: { waiting: true, mode: waitpoint.mode, resumeAt: waitpoint.resumeAt, expiresAt: waitpoint.expiresAt } });
                lastOutput = input;
                throw new WorkflowWaitSignal(waitpoint);
            }
            else if (d.kind === 'code') {
                let val = '';
                let logs = [];
                let attempts = 1;
                let nodeError;
                try {
                    const retried = await executeWithRetry(async () => {
                        const ts = makeTimeoutSignal(d.timeout, options.signal);
                        try {
                            if (d.language === 'python') {
                                const py = await runPythonCode(d.code ?? '', input, ts.signal, variables);
                                val = typeof py.value === 'string' ? py.value : '';
                                logs = py.logs ?? [];
                                if (py.error)
                                    throw new Error(py.error.message);
                            }
                            else {
                                const codeRuntime = ctx.get('codeRuntime');
                                if (!codeRuntime)
                                    throw new Error('codeRuntime unavailable on this host');
                                const result = await codeRuntime.run({ program: d.code ?? '', bindings: buildCodeBindings(input, variables), signal: ts.signal });
                                val = stringifyValue(result.value);
                                logs = result.logs ?? [];
                                if (result.error)
                                    throw new Error(result.error.message);
                            }
                            return { val, logs };
                        }
                        finally {
                            ts.clear();
                        }
                    }, d, options.signal);
                    attempts = retried.attempts;
                }
                catch (error) {
                    attempts = error instanceof RetryExhaustedError ? error.attempts : attempts;
                    nodeError = error instanceof Error ? error.message : String(error);
                }
                if (options.signal?.aborted)
                    throw new Error('运行已取消');
                setRec({ status: nodeError ? 'error' : 'ok', output: val, logs, error: nodeError, attempts });
                lastOutput = nodeError ? '' : (val || logs.join('\n'));
                if (nodeError) {
                    const routed = await routeError(nodeError, attempts);
                    if (routed !== undefined)
                        return routed;
                    if (onError === 'continue')
                        return await fanOut('');
                    return input;
                }
                return await fanOut(val || logs.join('\n'));
            }
            else if (d.kind === 'agent') {
                const received = safeValue(input);
                const safeReceived = safeValue(received);
                const prompt = [safeReceived, renderResultTemplate(d.prompt ?? '', safeReceived, resolvePublicProjectVariables(projectVariableDataDir()))].map((s) => s.trim()).filter(Boolean).join('\n\n');
                let nodeError;
                let out = '';
                let attempts = 1;
                try {
                    const retried = await executeWithRetry(async () => {
                        const ts = makeTimeoutSignal(d.timeout, options.signal);
                        const agents = ctx.get('agents');
                        const subagents = ctx.get('subagents');
                        try {
                            if (!agents || !subagents)
                                throw new Error('subagent services unavailable on this host');
                            const parent = agents.roots()[0] ?? agents.list()[0];
                            const provider = pickSubagentProvider(subagents);
                            if (!parent)
                                throw new Error('no live agent to delegate from');
                            if (!provider)
                                throw new Error('no subagent provider registered');
                            const child = await subagents.start(provider, {
                                label: 'workflow-agent',
                                prompt: [{ type: 'text', text: prompt }],
                                parent,
                                signal: ts.signal,
                                agentOptions: parseAgentOptions(d.model),
                            });
                            try {
                                const result = await child.result;
                                out = outputText(result);
                                const failure = stopReasonError(result);
                                if (failure)
                                    throw new Error(failure);
                                return out;
                            }
                            finally {
                                void child.dispose().catch(() => { });
                            }
                        }
                        finally {
                            ts.clear();
                        }
                    }, d, options.signal);
                    attempts = retried.attempts;
                }
                catch (error) {
                    attempts = error instanceof RetryExhaustedError ? error.attempts : attempts;
                    nodeError = error instanceof Error ? error.message : String(error);
                }
                if (options.signal?.aborted)
                    throw new Error('运行已取消');
                setRec({ status: nodeError ? 'error' : 'ok', output: out, error: nodeError, attempts });
                lastOutput = nodeError ? '' : out;
                if (nodeError) {
                    const routed = await routeError(nodeError, attempts);
                    if (routed !== undefined)
                        return routed;
                    if (onError === 'continue')
                        return await fanOut('');
                    return received;
                }
                return await fanOut(out);
            }
            else if (d.kind === 'call-workflow') {
                const targetId = d.workflowId?.trim() ?? '';
                const stack = options.workflowStack ?? (options.workflowId ? [options.workflowId] : []);
                validateSubworkflowRuntimeCall(stack, targetId);
                const target = options.subworkflowSnapshots?.[targetId];
                if (!target)
                    throw new Error(`缺少子工作流发布快照：${targetId}`);
                const childInput = validateWorkflowContract(safeValue(renderSubworkflowInput(d.inputTemplate, input, resolvePublicProjectVariables(projectVariableDataDir()))), target.doc.inputs, '子工作流输入');
                let childRun;
                let attempts = 1;
                try {
                    const retried = await executeWithRetry(async () => {
                        const childRunId = runId('subflow');
                        childRun = await runWithController(childRunId, async (childSignal) => {
                            const childOptions = {
                                id: childRunId,
                                workflowId: target.workflowId,
                                name: target.name,
                                doc: target.doc,
                                input: childInput,
                                parentRunId: options.runId,
                                parentNodeId: id,
                                rootRunId: options.rootRunId ?? options.runId,
                                depth: (options.depth ?? 0) + 1,
                                workflowStack: [...stack, targetId],
                                subworkflowSnapshots: options.subworkflowSnapshots,
                                variables,
                            };
                            if (options.persistChildRuns !== false)
                                return await runPersistedDocument(ctx, childOptions, childSignal);
                            const transient = await runDocumentGraph(ctx, target.doc, childInput, {
                                signal: childSignal,
                                runId: childRunId,
                                workflowId: target.workflowId,
                                rootRunId: childOptions.rootRunId,
                                depth: childOptions.depth,
                                workflowStack: childOptions.workflowStack,
                                subworkflowSnapshots: options.subworkflowSnapshots,
                                persistChildRuns: false,
                                variables,
                            });
                            return { ...transient, id: childRunId, workflowId: target.workflowId, name: target.name, parentRunId: options.runId, parentNodeId: id, rootRunId: childOptions.rootRunId, depth: childOptions.depth };
                        }, options.signal);
                        if (childRun.status === 'waiting')
                            return childRun;
                        if (childRun.status !== 'ok' && childRun.status !== 'handled') {
                            const failed = childRun.nodes.find((node) => node.status === 'error');
                            throw new Error(failed?.error || `子工作流“${target.name}”执行失败`);
                        }
                        return childRun;
                    }, d, options.signal);
                    attempts = retried.attempts;
                    childRun = retried.value;
                    if (childRun.status === 'waiting') {
                        if (options.persistChildRuns === false)
                            throw new Error('含 Wait 节点的子工作流必须使用持久子运行');
                        setRec({
                            status: 'ok',
                            output: {
                                waiting: true,
                                mode: 'child',
                                childRunId: childRun.id,
                                childWaitMode: childRun.waitpoint?.mode,
                            },
                            childRunId: childRun.id,
                        });
                        throw new WorkflowWaitSignal({
                            nodeId: id,
                            mode: 'child',
                            createdAt: new Date().toISOString(),
                            input: '',
                            childRunId: childRun.id,
                            parentRunId: options.runId,
                            parentNodeId: id,
                        });
                    }
                }
                catch (error) {
                    if (error instanceof WorkflowWaitSignal)
                        throw error;
                    if (options.signal?.aborted)
                        throw new Error('运行已取消');
                    const message = error instanceof Error ? error.message : String(error);
                    setRec({ status: 'error', error: message, attempts: error instanceof RetryExhaustedError ? error.attempts : attempts, childRunId: options.persistChildRuns === false ? undefined : childRun?.id });
                    const routed = await routeError(message, error instanceof RetryExhaustedError ? error.attempts : attempts);
                    if (routed !== undefined)
                        return routed;
                    if (onError === 'continue')
                        return await fanOut('');
                    return input;
                }
                try {
                    const output = validateWorkflowContract(childRun.value, target.doc.outputs, '子工作流输出');
                    const next = stringifyValue(output);
                    setRec({ status: 'ok', output, attempts, childRunId: options.persistChildRuns === false ? undefined : childRun.id });
                    lastOutput = output;
                    return await fanOut(next);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    setRec({ status: 'error', error: message, attempts, childRunId: options.persistChildRuns === false ? undefined : childRun.id });
                    const routed = await routeError(message, attempts);
                    if (routed !== undefined)
                        return routed;
                    if (onError === 'continue')
                        return await fanOut('');
                    return input;
                }
            }
            else if (d.kind === 'http' || d.kind === 'connector') {
                try {
                    const execute = d.kind === 'http'
                        ? () => executeHttpNode(d, input, (credentialId, forceRefresh) => resolveCredentialHeaders(credentialDataDir(), credentialId, fetch, forceRefresh), options.signal, variables)
                        : () => {
                            const credential = listCredentialSummaries(credentialDataDir()).find((candidate) => candidate.id === d.credentialId);
                            const request = connectorRegistry.build(d, input, credential, variables);
                            return executePreparedHttpRequest({ ...request, timeout: d.timeout, credentialId: d.credentialId, failOnHttpError: d.failOnHttpError }, (credentialId, forceRefresh) => resolveCredentialHeaders(credentialDataDir(), credentialId, fetch, forceRefresh), options.signal);
                        };
                    const retried = await executeWithRetry(execute, d, options.signal);
                    const result = retried.value;
                    setRec({ status: 'ok', output: result.value, logs: result.logs, attempts: retried.attempts });
                    lastOutput = result.output;
                    return await fanOut(result.output);
                }
                catch (error) {
                    if (options.signal?.aborted)
                        throw new Error('运行已取消');
                    const source = error instanceof RetryExhaustedError ? error.lastError : error;
                    const result = source instanceof HttpNodeError ? source.result : undefined;
                    const message = error instanceof Error ? error.message : String(error);
                    setRec({ status: 'error', output: result?.value, logs: result?.logs, error: message, attempts: error instanceof RetryExhaustedError ? error.attempts : 1 });
                    const routed = await routeError(message, error instanceof RetryExhaustedError ? error.attempts : 1);
                    if (routed !== undefined)
                        return routed;
                    if (onError === 'continue')
                        return await fanOut('');
                    return input;
                }
            }
            else if (d.kind === 'data-store') {
                try {
                    const output = await executeDataStoreNode(credentialDataDir(), options.workflowId, d, input, variables);
                    const safeOutput = safeValue(output);
                    setRec({ status: 'ok', output: safeOutput });
                    lastOutput = safeOutput;
                    return await fanOut(stringifyValue(safeOutput));
                }
                catch (error) {
                    if (options.signal?.aborted)
                        throw new Error('运行已取消');
                    const message = error instanceof Error ? error.message : String(error);
                    setRec({ status: 'error', error: message });
                    const routed = await routeError(message);
                    if (routed !== undefined)
                        return routed;
                    if (onError === 'continue')
                        return await fanOut('');
                    return input;
                }
            }
            else if (d.kind === 'output') {
                const template = (d.template ?? '').trim() ? d.template : '{{result}}';
                const rendered = safeValue(renderTemplateHost(template, input, resolvePublicProjectVariables(projectVariableDataDir())));
                setRec({ status: 'ok', output: rendered });
                lastOutput = rendered;
                return await fanOut(rendered);
            }
            else if (d.kind === 'if') {
                const ok = evalConditionHost(d.condition ?? '', input, variables);
                setRec({ status: 'ok', output: String(ok) });
                const want = ok ? 'true' : 'false';
                const edge = edgesFrom(id).find((e) => (e.sourceHandle ?? 'true') === want);
                if (edge)
                    return await executeNode(edge.target, input, ctxVisited, stopAt);
                return input;
            }
            else if (d.kind === 'switch') {
                const val = evalExprHost(d.condition ?? '', input, variables);
                setRec({ status: 'ok', output: String(val) });
                const cases = (d.cases ?? '').split(',').map((s) => s.trim()).filter(Boolean);
                const sval = String(val);
                let edge = edgesFrom(id).find((e) => e.sourceHandle && cases.includes(e.sourceHandle) && e.sourceHandle === sval);
                if (!edge)
                    edge = edgesFrom(id).find((e) => e.sourceHandle === 'default');
                if (edge)
                    return await executeNode(edge.target, input, ctxVisited, stopAt);
                return input;
            }
            else if (d.kind === 'loop' || d.kind === 'while') {
                const value = await runLoopOrWhile(id, d, input);
                setRec({ status: 'ok', output: value });
                lastOutput = value;
                const doneEdge = edgesFrom(id).find((e) => e.sourceHandle === 'done' || (!e.sourceHandle && e.sourceHandle !== 'iterate'));
                if (doneEdge)
                    return await executeNode(doneEdge.target, value, ctxVisited, stopAt);
                return value;
            }
            return input;
        }
        catch (err) {
            if (err instanceof WorkflowWaitSignal)
                throw err;
            if (err instanceof WorkflowExecutionLimitError)
                throw err;
            if (options.signal?.aborted)
                throw err;
            const message = err instanceof Error ? err.message : String(err);
            setRec({ status: 'error', error: message });
            const routed = await routeError(message);
            if (routed !== undefined)
                return routed;
            if (onError === 'continue')
                return await fanOut('');
            return input;
        }
    };
    const runLoopOrWhile = async (id, d, input) => {
        const loopId = id;
        const iterateEdge = edgesFrom(id).find((e) => e.sourceHandle === 'iterate');
        const maxIters = parseInt(d.maxIters ?? '', 10) || 100;
        const collect = Boolean(d.collect);
        const results = [];
        let count = 0;
        if (d.kind === 'loop') {
            let items = [];
            if ((d.mode ?? 'items') === 'count') {
                const c = parseInt(d.count ?? '', 10) || 0;
                items = Array.from({ length: c }, (_, i) => String(i + 1));
            }
            else {
                const arr = evalExprHost(d.itemsExpr ?? '', input, variables);
                items = Array.isArray(arr) ? arr : [];
            }
            for (const it of items) {
                if (options.signal?.aborted)
                    throw new Error('运行已取消');
                if (count >= maxIters)
                    break;
                count += 1;
                const item = typeof it === 'string' ? it : JSON.stringify(it);
                const r = await runLoopBody(iterateEdge?.target ?? '', loopId, item);
                if (collect)
                    results.push(r);
            }
            return collect ? JSON.stringify(results) : String(results.length ? results[results.length - 1] : input);
        }
        let cond = input;
        while (true) {
            if (options.signal?.aborted)
                throw new Error('运行已取消');
            if (count >= maxIters)
                break;
            const ok = evalConditionHost(d.condition ?? '', cond, variables);
            if (!ok)
                break;
            count += 1;
            const r = await runLoopBody(iterateEdge?.target ?? '', loopId, cond);
            cond = r;
            if (collect)
                results.push(r);
        }
        return collect ? JSON.stringify(results) : String(cond);
    };
    const startIds = options.resumeAfterNodeId
        ? edgesFrom(options.resumeAfterNodeId)
            .filter((edge) => options.resumeErrorNodeId ? edge.sourceHandle === 'error' : edge.sourceHandle !== 'error')
            .map((edge) => edge.target)
        : options.startNodeId && byId.has(options.startNodeId)
            ? [options.startNodeId]
            : docNodes.filter((n) => n.data.kind === 'trigger' || n.data.kind === 'schedule' || n.data.kind === 'webhook' || n.data.kind === 'connector-trigger').map((n) => n.id);
    const starts = options.resumeAfterNodeId ? startIds : startIds.length > 0 ? startIds : docNodes.map((n) => n.id);
    for (const sid of starts)
        await executeNode(sid, initialText, visited);
    if (!ran && records.size === 0) {
        const rec = { id: '', kind: 'none', status: 'ok', output: 'no runnable nodes', ms: 0 };
        records.set('__none__', rec);
    }
    const nodes = [...records.values()];
    const failed = nodes.filter((node) => node.status === 'error' && !node.errorHandled).length;
    const handledErrors = nodes.filter((node) => node.status === 'error' && node.errorHandled).length;
    return {
        id: `run-${Date.now().toString(36)}`,
        name: '',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        nodeCount: nodes.length,
        status: failed > 0 ? 'error' : handledErrors > 0 ? 'handled' : 'ok',
        failed,
        handledErrors,
        value: safeValue(lastOutput),
        nodes,
    };
}
/** Single-timer scheduler: arm for the earliest next fire across all schedules. */
let scheduleTimer;
let waitpointTimer;
let pollingTriggerTimer;
const activeRuns = new Map();
/** Controllers reserved after an atomic root-run admission but before execution starts. */
const pendingRootRuns = new Map();
const activePollingTriggers = new Map();
const WORKFLOW_MUTATION_QUEUE = Symbol.for('dsh-node-flow.workflow-mutation-queue.v1');
const RUN_MUTATION_QUEUE = Symbol.for('dsh-node-flow.run-mutation-queue.v1');
const POLLING_TRIGGER_MUTATION_QUEUE = Symbol.for('dsh-node-flow.polling-trigger-mutation-queue.v1');
const PROJECT_VARIABLE_MUTATION_QUEUE = Symbol.for('dsh-node-flow.project-variable-mutation-queue.v1');
const AUDIT_LOG_MUTATION_QUEUE = Symbol.for('dsh-node-flow.audit-log-mutation-queue.v1');
async function withWorkflowMutation(task) {
    const shared = globalThis;
    const previous = shared[WORKFLOW_MUTATION_QUEUE] ?? Promise.resolve();
    let release;
    shared[WORKFLOW_MUTATION_QUEUE] = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
        return await task();
    }
    finally {
        release();
    }
}
async function withRunMutation(task) {
    const shared = globalThis;
    const previous = shared[RUN_MUTATION_QUEUE] ?? Promise.resolve();
    let release;
    shared[RUN_MUTATION_QUEUE] = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
        return await task();
    }
    finally {
        release();
    }
}
async function withPollingTriggerMutation(task) {
    const shared = globalThis;
    const previous = shared[POLLING_TRIGGER_MUTATION_QUEUE] ?? Promise.resolve();
    let release;
    shared[POLLING_TRIGGER_MUTATION_QUEUE] = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
        return await task();
    }
    finally {
        release();
    }
}
async function withProjectVariableMutation(task) {
    const shared = globalThis;
    const previous = shared[PROJECT_VARIABLE_MUTATION_QUEUE] ?? Promise.resolve();
    let release;
    shared[PROJECT_VARIABLE_MUTATION_QUEUE] = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
        return await task();
    }
    finally {
        release();
    }
}
async function withAuditLogMutation(task) {
    const shared = globalThis;
    const previous = shared[AUDIT_LOG_MUTATION_QUEUE] ?? Promise.resolve();
    let release;
    shared[AUDIT_LOG_MUTATION_QUEUE] = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
        return await task();
    }
    finally {
        release();
    }
}
async function recordWorkflowAudit(action, target, details, actor = 'local-user') {
    try {
        await withAuditLogMutation(() => {
            const event = createWorkflowAuditEvent({
                id: `audit-${Date.now().toString(36)}-${randomBytes(8).toString('base64url')}`,
                at: new Date().toISOString(),
                actor,
                action,
                target,
                details,
            });
            saveWorkflowAuditLog(appendWorkflowAuditEvent(loadWorkflowAuditLog(), event));
        });
    }
    catch {
        // An audit write must never make a completed control-plane change fail.
    }
}
function runId(prefix = 'run') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
async function runWithController(id, execute, parentSignal, reservedController) {
    if (activeRuns.has(id))
        throw new Error('运行 ID 已存在');
    const controller = reservedController ?? new AbortController();
    if (reservedController && pendingRootRuns.get(id) !== reservedController)
        throw new Error('运行预留已失效');
    if (reservedController)
        pendingRootRuns.delete(id);
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted)
        abortFromParent();
    else
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    activeRuns.set(id, controller);
    try {
        return await execute(controller.signal);
    }
    finally {
        activeRuns.delete(id);
        parentSignal?.removeEventListener('abort', abortFromParent);
    }
}
async function runPersistedDocument(ctx, options, signal) {
    const variables = options.variables ?? resolveProjectVariables(projectVariableDataDir());
    validateWorkflowExecutionLimits(options.doc.executionLimits);
    const executionLimits = normalizeWorkflowExecutionLimits(options.doc.executionLimits);
    const executionController = new AbortController();
    let executionLimit;
    let executionFinished = false;
    let durationTimer;
    const abortFromCaller = () => executionController.abort(signal.reason);
    if (signal.aborted)
        abortFromCaller();
    else
        signal.addEventListener('abort', abortFromCaller, { once: true });
    const cleanupExecution = () => {
        executionFinished = true;
        if (durationTimer)
            clearTimeout(durationTimer);
        signal.removeEventListener('abort', abortFromCaller);
    };
    durationTimer = executionLimits.maxDurationSec === undefined ? undefined : setTimeout(() => {
        if (executionFinished)
            return;
        executionLimit = new WorkflowExecutionLimitError('duration', `工作流运行超过最长时间（${executionLimits.maxDurationSec} 秒）`);
        executionController.abort(executionLimit);
    }, executionLimits.maxDurationSec * 1000);
    const subworkflowSnapshots = options.subworkflowSnapshots
        ?? capturePublishedSubworkflows(options.workflowId, options.doc, loadWorkflows());
    const retainReplaySnapshot = !options.parentRunId
        && options.replayInputAvailable === true
        && (options.trigger === 'manual' || options.trigger === 'replay');
    let failureCheckpoint;
    let run = {
        id: options.id,
        workflowId: options.workflowId,
        scheduleId: options.scheduleId,
        name: options.name,
        queuedAt: options.queuedAt,
        startedAt: options.startedAt ?? new Date().toISOString(),
        nodeCount: 0,
        status: 'running',
        trigger: options.trigger,
        failed: 0,
        nodes: [],
        snapshot: options.doc,
        resumedFromRunId: options.resumedFromRunId,
        parentRunId: options.parentRunId,
        parentNodeId: options.parentNodeId,
        rootRunId: options.rootRunId ?? options.id,
        depth: options.depth ?? 0,
        workflowStack: options.workflowStack ?? (options.workflowId ? [options.workflowId] : []),
        subworkflowSnapshots: options.parentRunId ? undefined : subworkflowSnapshots,
        replayInput: options.replayInput,
        replayInputAvailable: options.replayInputAvailable,
        replayedFromRunId: options.replayedFromRunId,
        webhookIdempotencyId: options.webhookIdempotencyId,
    };
    saveRun(run);
    try {
        const workflowInput = options.parentRunId && !options.resumeAfterNodeId
            ? validateWorkflowContract(options.input, options.doc.inputs, '子工作流输入')
            : options.input;
        let result = await runDocumentGraph(ctx, options.doc, workflowInput, {
            signal: executionController.signal,
            startNodeId: options.startNodeId,
            runId: options.id,
            workflowId: options.workflowId,
            rootRunId: options.rootRunId ?? options.id,
            depth: options.depth ?? 0,
            workflowStack: options.workflowStack ?? (options.workflowId ? [options.workflowId] : []),
            subworkflowSnapshots,
            resumeAfterNodeId: options.resumeAfterNodeId,
            priorNodes: options.priorNodes,
            debug: options.debug,
            skipBreakpointNodeId: options.skipBreakpointNodeId,
            debugStepAfterNodeId: options.debugStepAfterNodeId,
            resumeErrorNodeId: options.resumeErrorNodeId,
            variables,
            onCheckpoint: (nodeId, input, nodes, forced) => {
                const checkpoint = forced ? { nodeId, input, updatedAt: new Date().toISOString() } : failureCheckpoint ?? { nodeId, input, updatedAt: new Date().toISOString() };
                run = {
                    ...run,
                    nodeCount: nodes.length,
                    nodes,
                    checkpoint,
                };
                saveRun(run);
            },
            onProgress: (nodes, value) => {
                const failedNode = [...nodes].reverse().find((node) => node.status === 'error' && !node.errorHandled);
                if (failedNode && !failureCheckpoint) {
                    failureCheckpoint = { nodeId: failedNode.id, input: stringifyValue(failedNode.input), updatedAt: new Date().toISOString() };
                }
                run = {
                    ...run,
                    nodeCount: nodes.length,
                    failed: nodes.filter((node) => node.status === 'error' && !node.errorHandled).length,
                    handledErrors: nodes.filter((node) => node.status === 'error' && node.errorHandled).length,
                    nodes,
                    value,
                    checkpoint: failureCheckpoint ?? run.checkpoint,
                };
                saveRun(run);
            },
        });
        if (executionLimit)
            throw executionLimit;
        if (result.status === 'ok' || result.status === 'handled') {
            try {
                result = { ...result, value: validateWorkflowContract(result.value, options.doc.outputs, options.parentRunId ? '子工作流输出' : '工作流输出') };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result = {
                    ...result,
                    status: 'error',
                    failed: result.failed + 1,
                    nodeCount: result.nodeCount + 1,
                    nodes: [...result.nodes, { id: '__workflow-output__', kind: 'workflow-output', status: 'error', error: message, ms: 0 }],
                };
            }
        }
        run = {
            ...result,
            id: options.id,
            workflowId: options.workflowId,
            scheduleId: options.scheduleId,
            name: options.name,
            queuedAt: options.queuedAt,
            startedAt: run.startedAt,
            trigger: options.trigger,
            queue: undefined,
            skipReason: undefined,
            completedAt: new Date().toISOString(),
            checkpoint: result.status === 'error' ? failureCheckpoint ?? run.checkpoint : undefined,
            snapshot: result.status === 'error' || retainReplaySnapshot ? options.doc : undefined,
            resumedFromRunId: options.resumedFromRunId,
            parentRunId: options.parentRunId,
            parentNodeId: options.parentNodeId,
            rootRunId: options.rootRunId ?? options.id,
            depth: options.depth ?? 0,
            workflowStack: options.workflowStack ?? (options.workflowId ? [options.workflowId] : []),
            subworkflowSnapshots: result.status === 'error' || retainReplaySnapshot || options.parentRunId ? subworkflowSnapshots : undefined,
            replayInput: options.replayInput,
            replayInputAvailable: options.replayInputAvailable,
            replayedFromRunId: options.replayedFromRunId,
            webhookIdempotencyId: options.webhookIdempotencyId,
        };
        run.resumable = options.parentRunId ? false : canResumeRun(run);
    }
    catch (error) {
        if (executionLimit)
            error = executionLimit;
        if (error instanceof WorkflowWaitSignal) {
            run = {
                ...run,
                completedAt: undefined,
                status: 'waiting',
                failed: 0,
                checkpoint: undefined,
                waitpoint: error.waitpoint,
                snapshot: options.doc,
                resumable: false,
                workflowStack: options.workflowStack ?? (options.workflowId ? [options.workflowId] : []),
                subworkflowSnapshots,
            };
            saveRun(run);
            rescheduleWaitpoints(ctx);
            cleanupExecution();
            return run;
        }
        const cancelled = signal.aborted && !executionLimit;
        const limitError = error instanceof WorkflowExecutionLimitError ? error : undefined;
        const message = error instanceof Error ? error.message : String(error);
        const currentNodeId = run.checkpoint?.nodeId;
        const limitedNode = limitError && currentNodeId && !run.nodes.some((node) => node.id === currentNodeId)
            ? {
                id: currentNodeId,
                kind: String(options.doc.nodes.find((node) => node.id === currentNodeId)?.data.kind ?? 'workflow'),
                status: 'error',
                input: run.checkpoint?.input,
                error: message,
                ms: 0,
            }
            : undefined;
        const nextNodes = limitedNode
            ? [...run.nodes, limitedNode]
            : currentNodeId
                ? run.nodes.map((node) => node.id === currentNodeId && node.status === 'running'
                    ? { ...node, status: 'error', error: message }
                    : node)
                : run.nodes;
        run = {
            ...run,
            completedAt: new Date().toISOString(),
            status: cancelled ? 'cancelled' : 'error',
            timedOut: limitError !== undefined,
            limitReason: limitError?.reason,
            failed: cancelled ? run.failed : Math.max(1, run.failed),
            nodeCount: nextNodes.length,
            nodes: nextNodes,
        };
        run.resumable = options.parentRunId ? false : canResumeRun(run);
    }
    saveRun(run);
    rescheduleWaitpoints(ctx);
    cleanupExecution();
    return run;
}
function restoreResumeClaim(runs, run) {
    if (!run.resumedFromRunId)
        return runs;
    return runs.map((candidate) => {
        if (candidate.id !== run.resumedFromRunId || candidate.resumedByRunId !== run.id)
            return candidate;
        const released = { ...candidate, resumedByRunId: undefined, resumable: undefined };
        return { ...released, resumable: canResumeRun(released) };
    });
}
function rootRunReservation(request, status, now, queue, skipReason) {
    return {
        id: request.id,
        workflowId: request.workflowId,
        scheduleId: request.scheduleId,
        name: request.name,
        queuedAt: status === 'queued' ? now : undefined,
        startedAt: now,
        nodeCount: 0,
        status,
        trigger: request.trigger,
        failed: 0,
        nodes: [],
        snapshot: status === 'skipped' ? undefined : structuredClone(request.doc),
        queue,
        skipReason,
        completedAt: status === 'skipped' ? now : undefined,
        resumedFromRunId: request.resumedFromRunId,
        parentRunId: request.parentRunId,
        parentNodeId: request.parentNodeId,
        rootRunId: request.rootRunId ?? request.id,
        depth: request.depth ?? 0,
        workflowStack: request.workflowStack,
        subworkflowSnapshots: request.subworkflowSnapshots,
        replayInput: request.replayInput,
        replayInputAvailable: request.replayInputAvailable,
        replayedFromRunId: request.replayedFromRunId,
        webhookIdempotencyId: request.webhookIdempotencyId,
    };
}
function webhookResponseForRun(request, run) {
    if (request.trigger !== 'webhook')
        return undefined;
    const node = request.doc.nodes.find((candidate) => candidate.id === request.startNodeId && candidate.data.kind === 'webhook');
    if (!node)
        return undefined;
    const safeRun = sanitizeRun(run);
    if (safeRun.status === 'waiting') {
        return {
            status: 202,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: true, waiting: true, runId: safeRun.id, status: 'waiting' }),
            runId: safeRun.id,
        };
    }
    if (safeRun.status !== 'ok' && safeRun.status !== 'handled') {
        return {
            status: 500,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: false, runId: safeRun.id, value: safeRun.value, status: safeRun.status }),
            runId: safeRun.id,
        };
    }
    const built = buildWebhookSuccessResponse(node.data, safeRun.value, safeRun.id, resolvePublicProjectVariables(projectVariableDataDir()));
    return { ...built, runId: safeRun.id };
}
function finalizeWebhookIdempotency(request, run) {
    if (!request.webhookIdempotencyId)
        return;
    let response;
    try {
        response = webhookResponseForRun(request, run);
    }
    catch {
        releaseWebhookIdempotency(webhookIdempotencyDataDir(), request.webhookIdempotencyId);
        return;
    }
    if (!response) {
        releaseWebhookIdempotency(webhookIdempotencyDataDir(), request.webhookIdempotencyId);
        return;
    }
    try {
        completeWebhookIdempotency(webhookIdempotencyDataDir(), request.webhookIdempotencyId, response);
    }
    catch {
        releaseWebhookIdempotency(webhookIdempotencyDataDir(), request.webhookIdempotencyId);
    }
}
function sendWebhookResponse(response, value, replay = false) {
    response.writeHead(value.status, {
        'cache-control': 'no-store',
        ...value.headers,
        'x-dsh-run-id': value.runId,
        ...(replay ? { 'x-dsh-idempotent-replay': 'true' } : {}),
    });
    response.end(value.body);
}
async function updateWorkflowLastRun(workflowId, startedAt) {
    await withWorkflowMutation(() => {
        const workflows = loadWorkflows();
        const current = workflows.find((workflow) => workflow.id === workflowId);
        if (current)
            saveWorkflows(workflows.map((workflow) => workflow.id === workflowId ? { ...workflow, lastRunAt: startedAt } : workflow));
    });
}
async function executeReservedRootRun(ctx, request, queuedAt, reservedController) {
    const reserved = await withRunMutation(() => loadRuns().find((run) => run.id === request.id));
    if (!reserved) {
        if (reservedController && pendingRootRuns.get(request.id) === reservedController)
            pendingRootRuns.delete(request.id);
        throw new Error('排队运行不存在');
    }
    if (reserved.status !== 'running') {
        if (reservedController && pendingRootRuns.get(request.id) === reservedController)
            pendingRootRuns.delete(request.id);
        return reserved;
    }
    const workflow = loadWorkflows().find((candidate) => candidate.id === request.workflowId);
    if (!workflow || (request.requiresEnabled !== false && workflow.status !== 'enabled')) {
        if (reservedController && pendingRootRuns.get(request.id) === reservedController)
            pendingRootRuns.delete(request.id);
        const cancelled = { ...reserved, status: 'cancelled', completedAt: new Date().toISOString(), queue: undefined, skipReason: '工作流已停用或删除，未启动排队运行', resumable: false };
        await withRunMutation(() => {
            const runs = loadRuns();
            saveRuns(redactProjectSecrets(restoreResumeClaim(upsertRunRecord(runs, cancelled), cancelled), listProjectSecretValues(projectVariableDataDir())));
        });
        if (cancelled.webhookIdempotencyId)
            releaseWebhookIdempotency(webhookIdempotencyDataDir(), cancelled.webhookIdempotencyId);
        void drainQueuedWorkflowRuns(ctx, request.workflowId);
        return cancelled;
    }
    try {
        const run = await runWithController(request.id, (signal) => runPersistedDocument(ctx, {
            id: request.id,
            workflowId: request.workflowId,
            scheduleId: request.scheduleId,
            name: request.name,
            doc: request.doc,
            input: request.input,
            startNodeId: request.startNodeId,
            resumeAfterNodeId: request.resumeAfterNodeId,
            priorNodes: request.priorNodes,
            resumedFromRunId: request.resumedFromRunId,
            parentRunId: request.parentRunId,
            parentNodeId: request.parentNodeId,
            rootRunId: request.rootRunId ?? request.id,
            depth: request.depth,
            workflowStack: request.workflowStack,
            subworkflowSnapshots: request.subworkflowSnapshots,
            trigger: request.trigger,
            startedAt: reserved.startedAt,
            queuedAt,
            replayInput: request.replayInput,
            replayInputAvailable: request.replayInputAvailable,
            replayedFromRunId: request.replayedFromRunId,
            debug: request.debug,
            skipBreakpointNodeId: request.skipBreakpointNodeId,
            debugStepAfterNodeId: request.debugStepAfterNodeId,
            webhookIdempotencyId: request.webhookIdempotencyId,
            resumeErrorNodeId: request.resumeErrorNodeId,
        }, signal), undefined, reservedController);
        finalizeWebhookIdempotency(request, run);
        await updateWorkflowLastRun(request.workflowId, run.startedAt);
        if (run.status === 'cancelled') {
            await withRunMutation(() => {
                const runs = loadRuns();
                const next = restoreResumeClaim(runs, run);
                if (next.some((candidate, index) => candidate !== runs[index]))
                    saveRuns(redactProjectSecrets(next, listProjectSecretValues(projectVariableDataDir())));
            });
        }
        if (run.parentRunId)
            await resumeWaitingParentForChild(ctx, run);
        return run;
    }
    catch (error) {
        const latest = loadRuns().find((run) => run.id === request.id) ?? reserved;
        const failed = {
            ...latest,
            status: 'error',
            completedAt: new Date().toISOString(),
            failed: Math.max(1, latest.failed),
            queue: undefined,
            skipReason: undefined,
            nodes: latest.nodes.length > 0 ? latest.nodes : [{ id: '__workflow__', kind: 'workflow', status: 'error', error: error instanceof Error ? error.message : String(error), ms: 0 }],
            resumable: false,
        };
        await withRunMutation(() => {
            const runs = loadRuns();
            saveRuns(redactProjectSecrets(restoreResumeClaim(upsertRunRecord(runs, failed), failed), listProjectSecretValues(projectVariableDataDir())));
        });
        finalizeWebhookIdempotency(request, failed);
        return failed;
    }
    finally {
        if (reservedController && pendingRootRuns.get(request.id) === reservedController)
            pendingRootRuns.delete(request.id);
        void drainQueuedWorkflowRuns(ctx, request.workflowId);
    }
}
async function submitTriggeredWorkflowRun(ctx, request) {
    validateWorkflowExecutionLimits(request.doc.executionLimits);
    const decision = await withRunMutation(() => {
        const runs = loadRuns();
        if (runs.some((run) => run.id === request.id) || activeRuns.has(request.id) || pendingRootRuns.has(request.id))
            throw new Error('运行 ID 已存在');
        const source = request.resumedFromRunId ? runs.find((run) => run.id === request.resumedFromRunId) : undefined;
        if (request.resumedFromRunId && (!source || !canResumeRun(source) || !source.snapshot || !source.checkpoint))
            throw new Error('该运行没有可用的恢复点');
        const concurrency = decideWorkflowConcurrency(request.doc.concurrency, runs, request.workflowId);
        const now = new Date().toISOString();
        if (concurrency.action === 'skip') {
            const run = rootRunReservation(request, 'skipped', now, undefined, concurrency.reason || '当前并发限制阻止了本次触发');
            saveRun(run);
            return { run, start: false };
        }
        const claimedRuns = source
            ? runs.map((run) => run.id === source.id ? { ...run, resumable: false, resumedByRunId: request.id } : run)
            : runs;
        if (concurrency.action === 'queue') {
            if (hasUnsafePersistentInput(request.input)) {
                throw new Error('输入含认证字段或项目 Secret，无法安全进入持久并发队列');
            }
            const queue = {
                trigger: request.trigger,
                input: request.input,
                startNodeId: request.startNodeId,
                scheduleId: request.scheduleId,
                requiresEnabled: request.requiresEnabled,
                resumedFromRunId: request.resumedFromRunId,
                resumeAfterNodeId: request.resumeAfterNodeId,
                skipBreakpointNodeId: request.skipBreakpointNodeId,
                debugStepAfterNodeId: request.debugStepAfterNodeId,
                webhookIdempotencyId: request.webhookIdempotencyId,
                priorNodes: request.priorNodes,
                rootRunId: request.rootRunId,
                subworkflowSnapshots: request.subworkflowSnapshots,
                executionLimits: request.doc.executionLimits,
            };
            const run = rootRunReservation(request, 'queued', now, queue);
            saveRuns(redactProjectSecrets(upsertRunRecord(claimedRuns, run), listProjectSecretValues(projectVariableDataDir())));
            return { run, start: false };
        }
        const run = rootRunReservation(request, 'running', now);
        const controller = new AbortController();
        pendingRootRuns.set(request.id, controller);
        saveRuns(redactProjectSecrets(upsertRunRecord(claimedRuns, run), listProjectSecretValues(projectVariableDataDir())));
        return { run, start: true, controller };
    });
    if (!decision.start)
        return { run: decision.run };
    return { run: decision.run, completion: executeReservedRootRun(ctx, request, undefined, decision.controller) };
}
async function cancelQueuedWorkflowRuns(workflowId, reason) {
    const webhookIdempotencyIds = await withRunMutation(() => {
        const runs = loadRuns();
        const cancelledAt = new Date().toISOString();
        const cancelled = runs.filter((run) => run.workflowId === workflowId && run.status === 'queued');
        let next = runs.map((run) => run.workflowId === workflowId && run.status === 'queued'
            ? { ...run, status: 'cancelled', completedAt: cancelledAt, queue: undefined, skipReason: reason, resumable: false }
            : run);
        for (const run of cancelled)
            next = restoreResumeClaim(next, run);
        if (next.some((run, index) => run !== runs[index]))
            saveRuns(redactProjectSecrets(next, listProjectSecretValues(projectVariableDataDir())));
        return cancelled.flatMap((run) => run.webhookIdempotencyId ? [run.webhookIdempotencyId] : []);
    });
    for (const id of webhookIdempotencyIds)
        releaseWebhookIdempotency(webhookIdempotencyDataDir(), id);
}
async function drainQueuedWorkflowRuns(ctx, onlyWorkflowId) {
    const webhookIdempotencyIds = [];
    const launches = await withRunMutation(() => {
        const workflows = new Map(loadWorkflows().map((workflow) => [workflow.id, workflow]));
        const runs = loadRuns();
        let next = [...runs];
        const now = new Date().toISOString();
        const launch = [];
        let changed = false;
        for (let index = 0; index < next.length; index += 1) {
            const queued = next[index];
            if (queued.status !== 'queued' || !queued.queue || !queued.workflowId || (onlyWorkflowId && queued.workflowId !== onlyWorkflowId))
                continue;
            const workflow = workflows.get(queued.workflowId);
            if (workflow && (workflow.status === 'enabled' || queued.queue?.requiresEnabled === false))
                continue;
            const cancelled = { ...queued, status: 'cancelled', completedAt: now, queue: undefined, skipReason: '工作流已停用或删除，已取消排队运行', resumable: false };
            next[index] = cancelled;
            next = restoreResumeClaim(next, cancelled);
            if (cancelled.webhookIdempotencyId)
                webhookIdempotencyIds.push(cancelled.webhookIdempotencyId);
            changed = true;
        }
        const workflowIds = [...new Set(next.filter((run) => run.status === 'queued' && run.queue && run.workflowId && (!onlyWorkflowId || run.workflowId === onlyWorkflowId)).map((run) => run.workflowId))];
        for (const workflowId of workflowIds) {
            const workflow = workflows.get(workflowId);
            if (!workflow)
                continue;
            while (true) {
                const candidates = next
                    .filter((run) => run.status === 'queued' && run.queue && run.workflowId === workflowId)
                    .sort((left, right) => (left.queuedAt ?? left.startedAt).localeCompare(right.queuedAt ?? right.startedAt));
                const queued = candidates[0];
                if (!queued?.queue)
                    break;
                if (!queued.snapshot) {
                    const index = next.findIndex((run) => run.id === queued.id);
                    const cancelled = { ...queued, status: 'cancelled', completedAt: now, queue: undefined, skipReason: '排队快照无效，已取消运行', resumable: false };
                    next[index] = cancelled;
                    next = restoreResumeClaim(next, cancelled);
                    if (cancelled.webhookIdempotencyId)
                        webhookIdempotencyIds.push(cancelled.webhookIdempotencyId);
                    changed = true;
                    continue;
                }
                if (queued.queue.requiresEnabled !== false && workflow.status !== 'enabled')
                    break;
                const concurrency = queued.snapshot.concurrency;
                if (!canStartQueuedWorkflowRun(concurrency, next, workflowId))
                    break;
                const queue = queued.queue;
                const index = next.findIndex((run) => run.id === queued.id);
                const request = {
                    id: queued.id,
                    workflowId,
                    scheduleId: queue.scheduleId ?? queued.scheduleId,
                    name: queued.name,
                    doc: queue.executionLimits ? { ...queued.snapshot, executionLimits: queue.executionLimits } : queued.snapshot,
                    input: queue.input,
                    startNodeId: queue.startNodeId,
                    trigger: queue.trigger,
                    requiresEnabled: queue.requiresEnabled,
                    resumedFromRunId: queue.resumedFromRunId ?? queued.resumedFromRunId,
                    resumeAfterNodeId: queue.resumeAfterNodeId,
                    skipBreakpointNodeId: queue.skipBreakpointNodeId,
                    debugStepAfterNodeId: queue.debugStepAfterNodeId,
                    webhookIdempotencyId: queue.webhookIdempotencyId ?? queued.webhookIdempotencyId,
                    priorNodes: queue.priorNodes,
                    rootRunId: queue.rootRunId ?? queued.rootRunId,
                    subworkflowSnapshots: queue.subworkflowSnapshots ?? queued.subworkflowSnapshots,
                    replayInput: queued.replayInput,
                    replayInputAvailable: queued.replayInputAvailable,
                    replayedFromRunId: queued.replayedFromRunId,
                    debug: queue.trigger === 'debug',
                };
                next[index] = { ...queued, status: 'running', startedAt: now, queue: undefined, skipReason: undefined };
                const controller = new AbortController();
                pendingRootRuns.set(request.id, controller);
                launch.push({ request, queuedAt: queued.queuedAt, controller });
                changed = true;
            }
        }
        if (changed)
            saveRuns(redactProjectSecrets(next, listProjectSecretValues(projectVariableDataDir())));
        return launch;
    });
    for (const id of webhookIdempotencyIds)
        releaseWebhookIdempotency(webhookIdempotencyDataDir(), id);
    for (const launch of launches)
        void executeReservedRootRun(ctx, launch.request, launch.queuedAt, launch.controller);
}
async function resumePersistedRun(ctx, previous, id) {
    const latest = loadRuns().find((run) => run.id === previous.id);
    if (!latest || !canResumeRun(latest) || !latest.snapshot || !latest.checkpoint)
        throw new Error('该运行没有可用的恢复点');
    const workflow = latest.workflowId ? loadWorkflows().find((candidate) => candidate.id === latest.workflowId) : undefined;
    if (latest.workflowId && workflow) {
        const submission = await submitTriggeredWorkflowRun(ctx, {
            id,
            workflowId: latest.workflowId,
            scheduleId: latest.scheduleId,
            name: latest.name,
            doc: latest.snapshot,
            input: latest.checkpoint.input,
            startNodeId: latest.checkpoint.nodeId,
            priorNodes: latest.nodes,
            resumedFromRunId: latest.id,
            rootRunId: latest.rootRunId ?? latest.id,
            subworkflowSnapshots: latest.subworkflowSnapshots,
            trigger: 'resume',
            requiresEnabled: false,
        });
        return submission.completion ? await submission.completion : submission.run;
    }
    return await runWithController(id, async (signal) => {
        const current = loadRuns().find((run) => run.id === previous.id);
        if (!current || !canResumeRun(current) || !current.snapshot || !current.checkpoint)
            throw new Error('该运行没有可用的恢复点');
        saveRun({ ...current, resumable: false, resumedByRunId: id });
        return await runPersistedDocument(ctx, {
            id,
            workflowId: current.workflowId,
            scheduleId: current.scheduleId,
            name: current.name,
            doc: current.snapshot,
            input: current.checkpoint.input,
            startNodeId: current.checkpoint.nodeId,
            resumedFromRunId: current.id,
            rootRunId: current.rootRunId ?? current.id,
            depth: 0,
            workflowStack: current.workflowId ? [current.workflowId] : [],
            subworkflowSnapshots: current.subworkflowSnapshots,
            trigger: 'resume',
        }, signal);
    });
}
async function resolvePersistedWaitpoint(ctx, sourceId, input, id = runId('continue')) {
    const source = loadRuns().find((run) => run.id === sourceId);
    if (!source || !source.waitpoint || !source.snapshot || source.status !== 'waiting')
        throw new Error('等待记录不存在或已结束');
    const waitpoint = source.waitpoint;
    let claimed = false;
    try {
        return await runWithController(id, async (signal) => {
            const latest = await withRunMutation(() => {
                const runs = loadRuns();
                const current = runs.find((run) => run.id === sourceId);
                if (!current || current.status !== 'waiting' || current.resumedByRunId || !current.waitpoint || !current.snapshot)
                    throw new Error('等待已经被其他请求处理');
                const now = new Date().toISOString();
                let next = runs.map((run) => run.id === current.id
                    ? { ...run, resumedByRunId: id, completedAt: now }
                    : run);
                if (current.parentRunId) {
                    const parent = runs.find((run) => run.id === current.parentRunId);
                    if (parent?.status === 'waiting' && !parent.resumedByRunId && parent.waitpoint?.mode === 'child' && parent.waitpoint.childRunId === current.id) {
                        next = next.map((run) => run.id === parent.id
                            ? { ...run, waitpoint: { ...parent.waitpoint, childRunId: id } }
                            : run);
                    }
                }
                saveRuns(redactProjectSecrets(next, listProjectSecretValues(projectVariableDataDir())));
                return current;
            });
            claimed = true;
            const run = await runPersistedDocument(ctx, {
                id,
                workflowId: latest.workflowId,
                scheduleId: latest.scheduleId,
                name: latest.name,
                doc: latest.snapshot,
                input,
                resumeAfterNodeId: latest.waitpoint.nodeId,
                priorNodes: latest.nodes,
                resumedFromRunId: latest.id,
                parentRunId: latest.parentRunId,
                parentNodeId: latest.parentNodeId,
                rootRunId: latest.rootRunId ?? latest.id,
                depth: latest.depth,
                workflowStack: latest.workflowStack ?? (latest.workflowId ? [latest.workflowId] : []),
                subworkflowSnapshots: latest.subworkflowSnapshots,
                trigger: 'resume',
            }, signal);
            if (run.parentRunId)
                await resumeWaitingParentForChild(ctx, run);
            return run;
        });
    }
    catch (error) {
        if (claimed) {
            await withRunMutation(() => {
                const runs = loadRuns();
                const latest = runs.find((run) => run.id === sourceId);
                if (!latest?.status || latest.status !== 'waiting' || latest.resumedByRunId !== id)
                    return;
                let next = runs.map((run) => run.id === latest.id
                    ? { ...run, resumedByRunId: undefined, completedAt: undefined }
                    : run);
                if (latest.parentRunId) {
                    const parent = runs.find((run) => run.id === latest.parentRunId);
                    if (parent?.waitpoint?.mode === 'child' && parent.waitpoint.childRunId === id) {
                        next = next.map((run) => run.id === parent.id
                            ? { ...run, waitpoint: { ...parent.waitpoint, childRunId: latest.id } }
                            : run);
                    }
                }
                saveRuns(redactProjectSecrets(next, listProjectSecretValues(projectVariableDataDir())));
            });
        }
        throw error;
    }
    finally {
        rescheduleWaitpoints(ctx);
        if (source.workflowId)
            void drainQueuedWorkflowRuns(ctx, source.workflowId);
    }
}
/** Resume the parent Call Workflow node after a persisted child run finishes. */
async function resumeWaitingParentForChild(ctx, child) {
    const parentId = child.parentRunId;
    const parentNodeId = child.parentNodeId;
    if (!parentId || !parentNodeId)
        return;
    const parent = loadRuns().find((run) => run.id === parentId);
    if (!parent?.waitpoint || !parent.snapshot || parent.status !== 'waiting' || parent.resumedByRunId)
        return;
    if (parent.waitpoint.mode !== 'child' || parent.waitpoint.childRunId !== child.id)
        return;
    if (child.status === 'waiting' || child.status === 'running' || child.status === 'queued')
        return;
    if (child.status === 'cancelled' || child.status === 'interrupted') {
        const controller = activeRuns.get(parent.id);
        if (controller)
            controller.abort(new Error('子工作流已取消'));
        else {
            const cancelledParent = { ...parent, status: 'cancelled', completedAt: new Date().toISOString(), waitpoint: undefined, resumable: false };
            saveRun(cancelledParent);
            if (cancelledParent.parentRunId)
                await resumeWaitingParentForChild(ctx, cancelledParent);
        }
        return;
    }
    const childOutput = child.status === 'ok' || child.status === 'handled' ? child.value : undefined;
    const childError = child.status === 'error' ? '子工作流执行失败' : undefined;
    const parentNode = parent.snapshot.nodes.find((node) => node.id === parentNodeId);
    const parentErrorEdges = parent.snapshot.edges.filter((edge) => edge.source === parentNodeId && edge.sourceHandle === 'error');
    const parentBehavior = parentNode?.data.onError === 'route' || parentNode?.data.onError === 'continue' ? parentNode.data.onError : 'stop';
    const routeChildError = Boolean(childError && parentBehavior === 'route' && parentErrorEdges.length > 0);
    const continueChildError = Boolean(childError && parentBehavior === 'continue');
    if (childError && !routeChildError && !continueChildError) {
        const failedParent = {
            ...parent,
            status: 'error',
            completedAt: new Date().toISOString(),
            waitpoint: undefined,
            failed: Math.max(1, parent.failed),
            nodes: parent.nodes.map((node) => node.id === parentNodeId
                ? { ...node, status: 'error', error: childError, childRunId: child.id }
                : node),
            resumable: false,
        };
        saveRun(failedParent);
        if (failedParent.parentRunId)
            await resumeWaitingParentForChild(ctx, failedParent);
        return;
    }
    const continuationId = runId('subflow-continue');
    let claimed = false;
    try {
        const claim = await withRunMutation(() => {
            const runs = loadRuns();
            const latestParent = runs.find((run) => run.id === parent.id);
            const latestChild = runs.find((run) => run.id === child.id);
            if (!latestParent || !latestChild || latestChild.status === 'waiting' || latestParent.status !== 'waiting'
                || latestParent.resumedByRunId || latestParent.waitpoint?.mode !== 'child'
                || latestParent.waitpoint.childRunId !== latestChild.id || !latestParent.snapshot)
                return undefined;
            const parentNodes = latestParent.nodes.map((node) => node.id === parentNodeId
                ? childError
                    ? {
                        ...node,
                        status: 'error',
                        error: childError,
                        output: undefined,
                        childRunId: latestChild.id,
                        errorHandled: routeChildError || undefined,
                    }
                    : { ...node, status: 'ok', error: undefined, output: childOutput, childRunId: latestChild.id }
                : node);
            const nextParent = { ...latestParent, resumedByRunId: continuationId, completedAt: new Date().toISOString() };
            const controller = new AbortController();
            pendingRootRuns.set(continuationId, controller);
            const request = {
                id: continuationId,
                workflowId: latestParent.workflowId ?? '',
                scheduleId: latestParent.scheduleId,
                name: latestParent.name,
                doc: structuredClone(latestParent.snapshot),
                input: routeChildError
                    ? JSON.stringify({ type: 'workflow-node-error', error: { message: childError, nodeId: parentNodeId } })
                    : continueChildError ? '' : childOutput,
                resumeAfterNodeId: parentNodeId,
                resumeErrorNodeId: routeChildError ? parentNodeId : undefined,
                priorNodes: parentNodes,
                resumedFromRunId: latestParent.id,
                parentRunId: latestParent.parentRunId,
                parentNodeId: latestParent.parentNodeId,
                rootRunId: latestParent.rootRunId ?? latestParent.id,
                depth: latestParent.depth,
                workflowStack: latestParent.workflowStack,
                subworkflowSnapshots: latestParent.subworkflowSnapshots,
                trigger: 'resume',
                requiresEnabled: false,
            };
            const reservation = {
                ...rootRunReservation(request, 'running', new Date().toISOString()),
                parentRunId: latestParent.parentRunId,
                parentNodeId: latestParent.parentNodeId,
                rootRunId: latestParent.rootRunId ?? latestParent.id,
                depth: latestParent.depth,
                workflowStack: latestParent.workflowStack,
            };
            let nextRuns = runs.map((run) => run.id === latestParent.id ? nextParent : run);
            if (latestParent.parentRunId) {
                const ancestor = runs.find((run) => run.id === latestParent.parentRunId);
                if (ancestor?.status === 'waiting' && !ancestor.resumedByRunId
                    && ancestor.waitpoint?.mode === 'child' && ancestor.waitpoint.childRunId === latestParent.id) {
                    nextRuns = nextRuns.map((run) => run.id === ancestor.id
                        ? { ...run, waitpoint: { ...ancestor.waitpoint, childRunId: continuationId } }
                        : run);
                }
            }
            saveRuns(redactProjectSecrets(upsertRunRecord(nextRuns, reservation), listProjectSecretValues(projectVariableDataDir())));
            return { request, controller };
        });
        if (!claim)
            return;
        claimed = true;
        await executeReservedRootRun(ctx, claim.request, undefined, claim.controller);
    }
    catch (error) {
        if (claimed) {
            const latest = loadRuns().find((run) => run.id === parent.id);
            if (latest?.resumedByRunId === continuationId) {
                const runs = loadRuns();
                let nextRuns = runs.map((run) => run.id === latest.id ? { ...latest, resumedByRunId: undefined, completedAt: undefined } : run);
                if (latest.parentRunId) {
                    const ancestor = runs.find((run) => run.id === latest.parentRunId);
                    if (ancestor?.waitpoint?.mode === 'child' && ancestor.waitpoint.childRunId === continuationId) {
                        nextRuns = nextRuns.map((run) => run.id === ancestor.id
                            ? { ...run, waitpoint: { ...ancestor.waitpoint, childRunId: latest.id } }
                            : run);
                    }
                }
                saveRuns(redactProjectSecrets(nextRuns, listProjectSecretValues(projectVariableDataDir())));
            }
        }
        console.error(`[dsh-node-flow] parent subworkflow continuation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        if (child.workflowId)
            void drainQueuedWorkflowRuns(ctx, child.workflowId);
        if (parent.workflowId)
            void drainQueuedWorkflowRuns(ctx, parent.workflowId);
    }
}
/** Cancel persisted descendants when a parent run is stopped or deleted from execution. */
async function cancelDescendantRuns(ctx, rootRunId, reason) {
    const descendantIds = new Set();
    const abortIds = new Set();
    await withRunMutation(() => {
        const runs = loadRuns();
        let changed = true;
        while (changed) {
            changed = false;
            for (const run of runs) {
                if (run.parentRunId && (run.parentRunId === rootRunId || descendantIds.has(run.parentRunId)) && !descendantIds.has(run.id)) {
                    descendantIds.add(run.id);
                    changed = true;
                }
            }
        }
        if (descendantIds.size === 0)
            return;
        const completedAt = new Date().toISOString();
        const next = runs.map((run) => {
            if (!descendantIds.has(run.id))
                return run;
            if (run.status === 'running') {
                abortIds.add(run.id);
                return run;
            }
            if (run.status === 'queued' || run.status === 'waiting') {
                return {
                    ...run,
                    status: 'cancelled',
                    completedAt,
                    queue: undefined,
                    waitpoint: undefined,
                    skipReason: reason,
                    resumable: false,
                };
            }
            return run;
        });
        if (next.some((run, index) => run !== runs[index]))
            saveRuns(redactProjectSecrets(next, listProjectSecretValues(projectVariableDataDir())));
    });
    for (const id of abortIds) {
        const controller = activeRuns.get(id) ?? pendingRootRuns.get(id);
        if (controller && !controller.signal.aborted)
            controller.abort(new Error(reason));
    }
    rescheduleWaitpoints(ctx);
    for (const run of loadRuns().filter((candidate) => descendantIds.has(candidate.id) && candidate.status === 'cancelled')) {
        if (run.parentRunId)
            await resumeWaitingParentForChild(ctx, run);
    }
}
async function reconcileCompletedChildRuns(ctx) {
    const terminalChildren = loadRuns().filter((run) => Boolean(run.parentRunId && run.parentNodeId)
        && ['ok', 'handled', 'error', 'cancelled', 'interrupted'].includes(run.status));
    for (const child of terminalChildren)
        await resumeWaitingParentForChild(ctx, child);
}
async function resolvePersistedDebugWaitpoint(ctx, sourceId, action, id = runId(action === 'step' ? 'debug-step' : 'debug-continue')) {
    const claimed = await withRunMutation(() => {
        const runs = loadRuns();
        if (runs.some((run) => run.id === id) || activeRuns.has(id) || pendingRootRuns.has(id))
            throw new Error('运行 ID 已存在');
        const source = runs.find((run) => run.id === sourceId);
        if (!source?.waitpoint || source.status !== 'waiting' || source.resumedByRunId || source.waitpoint.mode !== 'debug' || !source.snapshot) {
            throw new Error('当前运行不在调试暂停状态');
        }
        if (hasUnsafePersistentInput(source.waitpoint.input))
            throw new Error('调试暂停输入已不再满足安全策略，无法继续');
        validateWorkflowDebugDocument(source.snapshot);
        if (!source.snapshot.nodes.some((node) => node.id === source.waitpoint?.nodeId))
            throw new Error('调试暂停节点不在冻结快照中');
        const now = new Date().toISOString();
        const request = {
            id,
            workflowId: source.workflowId ?? '',
            scheduleId: source.scheduleId,
            name: source.name,
            doc: structuredClone(source.snapshot),
            input: source.waitpoint.input,
            startNodeId: source.waitpoint.nodeId,
            trigger: 'debug',
            requiresEnabled: false,
            resumedFromRunId: source.id,
            rootRunId: source.rootRunId ?? source.id,
            subworkflowSnapshots: source.subworkflowSnapshots,
            priorNodes: source.nodes,
            debug: true,
            skipBreakpointNodeId: source.waitpoint.nodeId,
            ...(action === 'step' ? { debugStepAfterNodeId: source.waitpoint.nodeId } : {}),
        };
        if (!request.workflowId)
            throw new Error('调试运行缺少工作流标识');
        const sourceClaimed = {
            ...source,
            resumedByRunId: id,
            completedAt: now,
            resumable: false,
        };
        const reservation = rootRunReservation(request, 'running', now);
        const controller = new AbortController();
        pendingRootRuns.set(id, controller);
        const next = upsertRunRecord(runs.map((run) => run.id === source.id ? sourceClaimed : run), reservation);
        saveRuns(redactProjectSecrets(next, listProjectSecretValues(projectVariableDataDir())));
        return { request, controller };
    });
    try {
        return await executeReservedRootRun(ctx, claimed.request, undefined, claimed.controller);
    }
    finally {
        rescheduleWaitpoints(ctx);
        if (claimed.request.workflowId)
            void drainQueuedWorkflowRuns(ctx, claimed.request.workflowId);
    }
}
function waitpointDueAt(run) {
    const waitpoint = run.waitpoint;
    if (run.status !== 'waiting' || run.resumedByRunId || !waitpoint)
        return undefined;
    const value = waitpoint.mode === 'delay' ? waitpoint.resumeAt : waitpoint.expiresAt;
    if (!value)
        return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}
async function runDueWaitpoints(ctx) {
    const now = Date.now();
    const due = loadRuns().filter((run) => canResolveWaitpoint(run, now) || (run.status === 'waiting' && run.waitpoint && waitpointTimedOut(run.waitpoint, now)));
    await Promise.allSettled(due.map(async (run) => {
        const waitpoint = run.waitpoint;
        const input = waitpoint.mode === 'delay'
            ? waitpoint.input
            : renderResultTemplate(waitpoint.timeoutValue?.trim() || '{"timedOut":true}', waitpoint.input);
        try {
            await resolvePersistedWaitpoint(ctx, run.id, input, runId(waitpoint.mode === 'delay' ? 'delay' : 'timeout'));
        }
        catch (error) {
            console.error(`[dsh-node-flow] waitpoint ${run.id} could not resume: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));
    rescheduleWaitpoints(ctx);
}
function rescheduleWaitpoints(ctx) {
    if (waitpointTimer) {
        clearTimeout(waitpointTimer);
        waitpointTimer = undefined;
    }
    const dueAt = loadRuns().map(waitpointDueAt).filter((value) => value !== undefined).sort((left, right) => left - right)[0];
    if (dueAt === undefined)
        return;
    const delay = Math.max(0, Math.min(dueAt - Date.now(), 2_147_000_000));
    waitpointTimer = setTimeout(() => { void runDueWaitpoints(ctx); }, delay);
}
async function pollConnectorTrigger(ctx, state) {
    const controller = new AbortController();
    activePollingTriggers.set(state.id, { claimedAt: state.claimedAt ?? '', controller });
    const workflow = loadWorkflows().find((candidate) => candidate.id === state.workflowId && candidate.status === 'enabled');
    const document = workflow?.publishedDoc;
    const node = document?.nodes.find((candidate) => candidate.id === state.nodeId && candidate.data.kind === 'connector-trigger');
    if (!workflow || !document || !node) {
        await withPollingTriggerMutation(() => {
            const current = loadPollingTriggers().find((candidate) => candidate.id === state.id);
            if (current?.claimedAt !== state.claimedAt)
                return;
            savePollingTriggers(loadPollingTriggers().filter((candidate) => candidate.id !== state.id));
        });
        const active = activePollingTriggers.get(state.id);
        if (active?.claimedAt === (state.claimedAt ?? ''))
            activePollingTriggers.delete(state.id);
        return;
    }
    let intervalMs = 60_000;
    try {
        intervalMs = pollingIntervalMs(node.data);
        const credential = listCredentialSummaries(credentialDataDir()).find((candidate) => candidate.id === node.data.credentialId);
        const variables = resolveProjectVariables(projectVariableDataDir());
        const built = buildConnectorTriggerRequest(connectorRegistry.list(), node.data, credential, variables);
        const response = await executePreparedHttpRequest({ ...built.request, credentialId: node.data.credentialId, timeout: '30', failOnHttpError: true }, (credentialId, forceRefresh) => resolveCredentialHeaders(credentialDataDir(), credentialId, fetch, forceRefresh), controller.signal);
        let extracted;
        try {
            extracted = built.trigger.extract(response.value);
        }
        catch {
            throw new Error('连接器触发器响应无法解析');
        }
        if (!Array.isArray(extracted.items) || extracted.items.length > 100)
            throw new Error('连接器触发器返回了无效事件列表');
        let keyed;
        try {
            keyed = extracted.items.map((item) => ({ item, key: built.trigger.key(item) }));
        }
        catch {
            throw new Error('连接器触发器返回了无效事件键');
        }
        if (keyed.some((entry) => !entry.key || entry.key.length > 500))
            throw new Error('连接器触发器返回了无效事件键');
        const unique = [...new Map(keyed.map((entry) => [entry.key, entry])).values()];
        const completed = completePollingTrigger(state, unique.map((entry) => entry.key), intervalMs, extracted.cursor);
        const stillOwned = await withPollingTriggerMutation(() => {
            const current = loadPollingTriggers().find((candidate) => candidate.id === state.id);
            return Boolean(current && current.claimedAt === state.claimedAt && current.configurationHash === state.configurationHash);
        });
        if (!stillOwned)
            return;
        for (const entry of unique.filter((candidate) => completed.newKeys.includes(candidate.key)).reverse()) {
            if (controller.signal.aborted)
                return;
            const id = runId('poll');
            const submission = await submitTriggeredWorkflowRun(ctx, {
                id,
                workflowId: workflow.id,
                name: workflow.name,
                doc: document,
                input: entry.item,
                startNodeId: node.id,
                trigger: 'connector-trigger',
            });
            if (submission.completion)
                void submission.completion;
        }
        await withPollingTriggerMutation(() => {
            const states = loadPollingTriggers();
            const current = states.find((candidate) => candidate.id === state.id);
            if (!current || current.claimedAt !== state.claimedAt || current.configurationHash !== state.configurationHash)
                return;
            savePollingTriggers(states.map((candidate) => candidate.id === state.id ? completed.state : candidate));
        });
    }
    catch (error) {
        const safeError = pollingTriggerError(error);
        await withPollingTriggerMutation(() => {
            const states = loadPollingTriggers();
            const current = states.find((candidate) => candidate.id === state.id);
            if (!current || current.claimedAt !== state.claimedAt || current.configurationHash !== state.configurationHash)
                return;
            const failed = failPollingTrigger(state, intervalMs, safeError);
            savePollingTriggers(states.map((candidate) => candidate.id === state.id ? failed : candidate));
        });
        if (!controller.signal.aborted)
            console.error(`[dsh-node-flow] polling trigger ${state.id} failed: ${safeError.message}`);
    }
    finally {
        const active = activePollingTriggers.get(state.id);
        if (active?.claimedAt === (state.claimedAt ?? ''))
            activePollingTriggers.delete(state.id);
    }
}
function pollingTriggerError(error) {
    if (error instanceof HttpNodeError)
        return new Error(error.result ? `连接器请求失败：HTTP ${error.result.status}` : '连接器请求失败');
    const source = error instanceof Error ? error.message : String(error);
    const safe = source
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/\b(authorization|bearer|token|secret|api[-_ ]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
        .slice(0, 500);
    return new Error(safe || '连接器轮询失败');
}
async function runDuePollingTriggers(ctx) {
    const claimed = await withPollingTriggerMutation(() => {
        const result = claimDuePollingTriggers(loadPollingTriggers());
        if (result.claimed.length > 0)
            savePollingTriggers(result.states);
        return result;
    });
    if (claimed.claimed.length === 0)
        return reschedulePollingTriggers(ctx);
    await Promise.all(claimed.claimed.map((state) => pollConnectorTrigger(ctx, state)));
    reschedulePollingTriggers(ctx);
}
function reschedulePollingTriggers(ctx) {
    if (pollingTriggerTimer) {
        clearTimeout(pollingTriggerTimer);
        pollingTriggerTimer = undefined;
    }
    const dueAt = loadPollingTriggers().filter((state) => !state.claimedAt).map((state) => Date.parse(state.nextPollAt)).filter(Number.isFinite).sort((left, right) => left - right)[0];
    if (dueAt === undefined)
        return;
    pollingTriggerTimer = setTimeout(() => { void runDuePollingTriggers(ctx); }, Math.max(0, Math.min(dueAt - Date.now(), 2_147_000_000)));
}
function rescheduleScheduler(ctx) {
    if (scheduleTimer) {
        clearTimeout(scheduleTimer);
        scheduleTimer = undefined;
    }
    const schedules = loadSchedules();
    const now = new Date();
    let next = null;
    for (const s of schedules) {
        const t = nextScheduleFire(s.cron, now, s.timezone, s.lastFiredWallClock);
        if (t && (next === null || t.getTime() < next.getTime()))
            next = t;
    }
    if (next === null)
        return;
    let delay = Math.max(0, next.getTime() - Date.now());
    const MAX = 2_147_000_000; // clamp below Node's 2^31-1 ms timer ceiling (~24.8 days)
    if (delay > MAX)
        delay = MAX;
    scheduleTimer = setTimeout(() => {
        scheduleTimer = undefined;
        runDueSchedules(ctx);
        rescheduleScheduler(ctx); // re-arm for the next occurrence
    }, delay);
}
/** Fire every schedule whose cron matches the current minute in its own timezone. */
function runDueSchedules(ctx) {
    const now = new Date();
    const minuteKey = scheduleInstantMinuteKey(now);
    const schedules = loadSchedules();
    let changed = false;
    for (const sched of schedules) {
        if (sched.lastFired === minuteKey)
            continue;
        let wallClockKey;
        try {
            wallClockKey = scheduleWallClockKey(now, sched.timezone);
        }
        catch (error) {
            console.warn(`[dsh-node-flow] schedule "${sched.name}" has an invalid timezone; skipping: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (sched.lastFiredWallClock === wallClockKey)
            continue;
        if (!cronMatchesSchedule(sched.cron, now, sched.timezone))
            continue;
        sched.lastFired = minuteKey;
        sched.lastFiredWallClock = wallClockKey;
        changed = true;
        const doc = sched.doc;
        if (!doc) {
            console.info(`[dsh-node-flow] schedule "${sched.name}" has no workflow snapshot; skipping`);
            continue;
        }
        void (async () => {
            const id = runId('schedule');
            const workflowId = sched.workflowId ?? /^workflow:([^:]+):/.exec(sched.id)?.[1];
            if (!workflowId) {
                const run = await runWithController(id, (signal) => runPersistedDocument(ctx, { id, scheduleId: sched.id, name: sched.name, doc, input: sched.input, trigger: 'schedule' }, signal));
                console.info(`[dsh-node-flow] scheduled run "${sched.name}" → ${run.status} (${run.failed} failed)`);
                return;
            }
            const submission = await submitTriggeredWorkflowRun(ctx, {
                id,
                workflowId,
                scheduleId: sched.id,
                name: sched.name,
                doc,
                input: sched.input,
                trigger: 'schedule',
            });
            const run = submission.completion ? await submission.completion : submission.run;
            console.info(`[dsh-node-flow] scheduled run "${sched.name}" → ${run.status} (${run.failed} failed)`);
        })();
    }
    if (changed)
        saveSchedules(schedules);
}
export function apply(ctx) {
    // `inject: ['webServer']` guarantees this is present when apply runs.
    const webServer = ctx.webServer;
    migratePersistedConnectorVersions();
    const storedRuns = loadRuns();
    const recoveredRuns = releaseOrphanedWaitpointClaims(recoverInterruptedRuns(storedRuns));
    if (recoveredRuns.some((run, index) => run.status !== storedRuns[index]?.status || run.resumable !== storedRuns[index]?.resumable))
        saveRuns(recoveredRuns);
    ctx.effect(() => {
        const disposers = [];
        // --- code route ---
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/connectors',
            handler: async (request, response) => {
                if (request.method === 'GET')
                    return sendJson(response, 200, { connectors: connectorRegistry.catalog() });
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = await readJsonBody(request, 256 * 1024);
                    const node = body?.node;
                    if (!node?.data || (node.data.kind !== 'connector' && node.data.kind !== 'connector-trigger'))
                        return sendJson(response, 400, { error: 'connector node is required' });
                    const credential = listCredentialSummaries(credentialDataDir()).find((candidate) => candidate.id === node.data.credentialId);
                    const operationId = node.data.kind === 'connector-trigger' ? node.data.connectorTrigger : node.data.connectorAction;
                    const built = buildConnectorDynamicOptionsRequest(connectorRegistry.list(), node.data, operationId, String(body?.fieldId ?? ''), credential, resolveProjectVariables(projectVariableDataDir()));
                    const result = await executePreparedHttpRequest({ ...built.request, credentialId: node.data.credentialId, timeout: '20', failOnHttpError: true }, (credentialId, forceRefresh) => resolveCredentialHeaders(credentialDataDir(), credentialId, fetch, forceRefresh));
                    let options;
                    try {
                        options = sanitizeConnectorDynamicOptions(built.extract(result.value));
                    }
                    catch {
                        throw new Error('连接器动态选项响应无法解析');
                    }
                    return sendJson(response, 200, { options });
                }
                catch (error) {
                    return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/project-variables',
            handler: async (request, response) => {
                if (request.method === 'GET') {
                    const variables = listProjectVariableSummaries(projectVariableDataDir()).map((variable) => ({ ...variable, references: projectVariableReferences(variable.name) }));
                    return sendJson(response, 200, { variables });
                }
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = await readJsonBody(request, 128 * 1024);
                    if (body?.action === 'save' && body.variable && typeof body.variable === 'object') {
                        const saved = await withProjectVariableMutation(async () => {
                            const input = body.variable;
                            const existing = input.id ? listProjectVariableSummaries(projectVariableDataDir()).find((variable) => variable.id === input.id) : undefined;
                            if (input.id && !existing)
                                throw new Error('项目变量不存在');
                            if (existing && body.expectedUpdatedAt && existing.updatedAt !== String(body.expectedUpdatedAt))
                                throw new Error('项目变量已被其他操作更新，请刷新后重试');
                            const variable = saveProjectVariable(projectVariableDataDir(), input);
                            for (const workflow of loadWorkflows().filter((candidate) => candidate.status === 'enabled'))
                                await syncWorkflowPollingTriggers(workflow);
                            return { variable, created: !existing };
                        });
                        reschedulePollingTriggers(ctx);
                        await recordWorkflowAudit(saved.created ? 'variable.created' : 'variable.updated', {
                            type: 'variable', id: saved.variable.id, name: saved.variable.name,
                        }, { kind: saved.variable.kind });
                        return sendJson(response, 200, { variable: { ...saved.variable, references: projectVariableReferences(saved.variable.name) } });
                    }
                    if (body?.action === 'delete') {
                        const id = String(body.id ?? '');
                        const deleted = await withProjectVariableMutation(async () => {
                            const variable = listProjectVariableSummaries(projectVariableDataDir()).find((candidate) => candidate.id === id);
                            if (!variable)
                                return { status: 'missing' };
                            if (body.expectedUpdatedAt && variable.updatedAt !== String(body.expectedUpdatedAt))
                                return { status: 'conflict' };
                            const references = projectVariableReferences(variable.name);
                            if (references.length > 0)
                                return { status: 'referenced', references };
                            deleteProjectVariable(projectVariableDataDir(), id);
                            return { status: 'deleted', id: variable.id, name: variable.name, kind: variable.kind };
                        });
                        if (deleted.status === 'missing')
                            return sendJson(response, 404, { error: '项目变量不存在' });
                        if (deleted.status === 'conflict')
                            return sendJson(response, 409, { error: '项目变量已被其他操作更新，请刷新后重试' });
                        if (deleted.status === 'referenced')
                            return sendJson(response, 409, { error: `项目变量仍被 ${deleted.references.length} 个节点引用`, references: deleted.references });
                        await recordWorkflowAudit('variable.deleted', { type: 'variable', id: deleted.id, name: deleted.name }, { kind: deleted.kind });
                        return sendJson(response, 200, { ok: true });
                    }
                    return sendJson(response, 400, { error: 'unsupported project variable action' });
                }
                catch (error) {
                    const message = redactProjectSecrets(error instanceof Error ? error.message : String(error), listProjectSecretValues(projectVariableDataDir()));
                    return sendJson(response, message.includes('其他操作更新') ? 409 : 400, { error: message });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/polling-triggers',
            handler: async (request, response) => {
                if (request.method === 'GET')
                    return sendJson(response, 200, { triggers: loadPollingTriggers().map(pollingTriggerSummary) });
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = await readJsonBody(request, 16 * 1024);
                    if (body?.action !== 'poll')
                        return sendJson(response, 400, { error: 'unsupported polling trigger action' });
                    const id = String(body.id ?? '');
                    const claimed = await withPollingTriggerMutation(() => {
                        const states = loadPollingTriggers();
                        const state = states.find((candidate) => candidate.id === id);
                        if (!state)
                            return { status: 'missing' };
                        if (state.claimedAt)
                            return { status: 'busy' };
                        const next = { ...state, claimedAt: new Date().toISOString() };
                        savePollingTriggers(states.map((candidate) => candidate.id === id ? next : candidate));
                        return { status: 'claimed', state: next };
                    });
                    if (claimed.status === 'missing')
                        return sendJson(response, 404, { error: 'polling trigger not found' });
                    if (claimed.status === 'busy')
                        return sendJson(response, 409, { error: 'polling trigger is already running' });
                    await pollConnectorTrigger(ctx, claimed.state);
                    reschedulePollingTriggers(ctx);
                    const current = loadPollingTriggers().find((candidate) => candidate.id === id);
                    return sendJson(response, 200, { trigger: current ? pollingTriggerSummary(current) : undefined });
                }
                catch (error) {
                    return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/run',
            handler: async (request, response) => {
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                let ts;
                try {
                    const body = (await readJsonBody(request, 256 * 1024));
                    const program = typeof body?.program === 'string' ? body.program : '';
                    if (!program.trim()) {
                        return sendJson(response, 400, { error: 'program must be a non-empty string' });
                    }
                    const language = typeof body?.language === 'string' ? body.language : 'typescript';
                    ts = makeTimeoutSignal(body?.timeout);
                    // Python runs through a host subprocess (ctx.codeRuntime has no
                    // Python backend); the flow input arrives via the DSH_INPUT env var.
                    if (language === 'python') {
                        const variables = resolveProjectVariables(projectVariableDataDir());
                        const py = await runPythonCode(program, body?.input, ts.signal, variables);
                        const failure = ts.isTimeout() ? { kind: 'abort', message: `运行超时（>${Number(body?.timeout)}s）` } : py.error;
                        return sendJson(response, 200, redactProjectSecrets({
                            ok: true,
                            language: 'python',
                            value: py.value,
                            logs: py.logs,
                            failure,
                        }, listProjectSecretValues(projectVariableDataDir())));
                    }
                    const codeRuntime = ctx.get('codeRuntime');
                    if (!codeRuntime) {
                        return sendJson(response, 503, { error: 'codeRuntime unavailable on this host' });
                    }
                    if (language !== codeRuntime.language) {
                        return sendJson(response, 400, {
                            error: `unsupported language '${language}' (runtime is '${codeRuntime.language}')`,
                        });
                    }
                    const variables = resolveProjectVariables(projectVariableDataDir());
                    const result = await codeRuntime.run({
                        program,
                        bindings: buildCodeBindings(body?.input, variables),
                        signal: ts.signal,
                    });
                    const failure = ts.isTimeout() ? { kind: 'abort', message: `运行超时（>${Number(body?.timeout)}s）` } : result.error;
                    sendJson(response, 200, redactProjectSecrets({
                        ok: true,
                        language: codeRuntime.language,
                        value: result.value,
                        logs: result.logs,
                        failure,
                    }, listProjectSecretValues(projectVariableDataDir())));
                }
                catch (err) {
                    if (ts?.isTimeout()) {
                        return sendJson(response, 200, { ok: true, value: undefined, logs: [], failure: { kind: 'abort', message: `运行超时（>${ts.seconds}s）` } });
                    }
                    sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
                }
                finally {
                    ts?.clear();
                }
            },
        }));
        // --- agent route ---
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/run-agent',
            handler: async (request, response) => {
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                let ts;
                try {
                    const body = (await readJsonBody(request, 256 * 1024));
                    const prompt = typeof body?.prompt === 'string' ? renderResultTemplate(body.prompt, '', resolvePublicProjectVariables(projectVariableDataDir())) : '';
                    if (!prompt.trim()) {
                        return sendJson(response, 400, { error: 'prompt must be a non-empty string' });
                    }
                    const agents = ctx.get('agents');
                    const subagents = ctx.get('subagents');
                    if (!agents || !subagents) {
                        return sendJson(response, 503, {
                            error: 'subagent services unavailable on this host (ctx.agents / ctx.subagents)',
                        });
                    }
                    // Delegate from a live agent (root preferred) so the child derives
                    // workspace, lineage, and delegation depth correctly.
                    const parent = agents.roots()[0] ?? agents.list()[0];
                    if (!parent) {
                        return sendJson(response, 400, { error: 'no live agent to delegate from' });
                    }
                    const provider = pickSubagentProvider(subagents);
                    if (!provider) {
                        return sendJson(response, 400, { error: 'no subagent provider registered' });
                    }
                    ts = makeTimeoutSignal(body?.timeout);
                    // Optional per-child model route: "provider|modelId" picked in the canvas.
                    let agentOptions;
                    if (typeof body?.agentOptions === 'object' && body?.agentOptions !== null) {
                        const ao = body.agentOptions;
                        if (typeof ao.provider === 'string' && typeof ao.model === 'string' && ao.provider && ao.model) {
                            agentOptions = { provider: ao.provider, model: ao.model };
                        }
                    }
                    const run = await subagents.start(provider, {
                        label: 'workflow-agent',
                        prompt: [{ type: 'text', text: prompt }],
                        parent,
                        signal: ts.signal,
                        agentOptions,
                    });
                    let result;
                    try {
                        result = await run.result;
                    }
                    finally {
                        void run.dispose().catch(() => { });
                    }
                    const error = ts.isTimeout() ? `运行超时（>${Number(body?.timeout)}s）` : stopReasonError(result);
                    sendJson(response, 200, redactProjectSecrets({
                        ok: true,
                        output: outputText(result),
                        stopReason: result.stopReason,
                        error,
                        structured: result.structured,
                    }, listProjectSecretValues(projectVariableDataDir())));
                }
                catch (err) {
                    if (ts?.isTimeout()) {
                        return sendJson(response, 200, { ok: true, output: '', error: `运行超时（>${ts.seconds}s）` });
                    }
                    sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
                }
                finally {
                    ts?.clear();
                }
            },
        }));
        // --- model list route (populates the agent-node model dropdown) ---
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/models',
            handler: async (request, response) => {
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                const llm = ctx.get('llm');
                if (!llm) {
                    return sendJson(response, 200, { models: [] });
                }
                const models = [];
                let providers = [];
                try {
                    providers = await llm.listProviders();
                }
                catch {
                    providers = [];
                }
                for (const p of providers) {
                    try {
                        const list = await llm.listModels(p.id);
                        for (const m of list) {
                            if (typeof m.id === 'string' && m.id.length > 0) {
                                models.push({ provider: p.id, id: m.id, name: m.name || m.id });
                            }
                        }
                    }
                    catch {
                        // Provider that cannot enumerate models is skipped.
                    }
                }
                sendJson(response, 200, { models });
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/oauth2/start',
            handler: async (request, response) => {
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = await readJsonBody(request, 32 * 1024);
                    const id = String(body?.id ?? '');
                    const origin = new URL(String(request.headers.origin)).origin;
                    const callbackUrl = new URL(String(body?.callbackUrl ?? `${origin}/dsh-node-flow/oauth2/callback`));
                    if (callbackUrl.origin !== origin || callbackUrl.pathname !== '/dsh-node-flow/oauth2/callback' || callbackUrl.search || callbackUrl.hash) {
                        throw new Error('OAuth2 回调 URL 与当前页面不匹配');
                    }
                    const redirectUri = callbackUrl.toString();
                    const { config, updatedAt } = getOAuthAuthorizationConfig(credentialDataDir(), id);
                    const state = randomBytes(32).toString('base64url');
                    const verifier = config.usePkce ? createPkceVerifier() : undefined;
                    const expiresAt = Date.now() + 10 * 60 * 1000;
                    for (const [key, pending] of pendingOAuthAuthorizations) {
                        if (pending.expiresAt <= Date.now() || pending.credentialId === id)
                            pendingOAuthAuthorizations.delete(key);
                    }
                    const stateHash = hashOAuthState(state);
                    pendingOAuthAuthorizations.set(stateHash, { credentialId: id, redirectUri, verifier, expectedUpdatedAt: updatedAt, expiresAt });
                    let authorizationUrl;
                    try {
                        authorizationUrl = buildAuthorizationUrl(config, redirectUri, state, verifier);
                        markCredentialAuthorizing(credentialDataDir(), id);
                    }
                    catch (error) {
                        pendingOAuthAuthorizations.delete(stateHash);
                        throw error;
                    }
                    await recordWorkflowAudit('credential.authorization-started', {
                        type: 'credential', id, name: (getOAuthAuthorizationConfig(credentialDataDir(), id)).summary.name,
                    }, { kind: 'oauth2', pkce: Boolean(verifier) });
                    return sendJson(response, 200, {
                        authorizationUrl,
                        callbackUrl: redirectUri,
                        expiresAt: new Date(expiresAt).toISOString(),
                    });
                }
                catch (error) {
                    return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/oauth2/callback',
            handler: async (request, response) => {
                if (request.method !== 'GET') {
                    response.writeHead(405, { allow: 'GET' });
                    response.end();
                    return;
                }
                const requestUrl = new URL(request.url || '/dsh-node-flow/oauth2/callback', `http://${request.headers.host || 'localhost'}`);
                const state = requestUrl.searchParams.get('state') || '';
                const pending = state ? pendingOAuthAuthorizations.get(hashOAuthState(state)) : undefined;
                if (state)
                    pendingOAuthAuthorizations.delete(hashOAuthState(state));
                if (!pending || pending.expiresAt <= Date.now())
                    return sendOAuthResult(response, false, 'OAuth2 State 无效或已过期，请重新授权');
                const providerError = (requestUrl.searchParams.get('error_description') || requestUrl.searchParams.get('error'))?.slice(0, 500);
                if (providerError) {
                    markCredentialAuthorizationFailed(credentialDataDir(), pending.credentialId, `OAuth2 授权失败：${providerError}`);
                    return sendOAuthResult(response, false, `OAuth2 授权失败：${providerError}`);
                }
                const code = requestUrl.searchParams.get('code') || '';
                if (!code) {
                    markCredentialAuthorizationFailed(credentialDataDir(), pending.credentialId, 'OAuth2 回调缺少授权码');
                    return sendOAuthResult(response, false, 'OAuth2 回调缺少授权码');
                }
                try {
                    const credential = await exchangeOAuthAuthorizationCode(credentialDataDir(), pending.credentialId, code, pending.redirectUri, pending.verifier, pending.expectedUpdatedAt);
                    await recordWorkflowAudit('credential.authorized', { type: 'credential', id: credential.id, name: credential.name }, { kind: 'oauth2' }, 'system');
                    return sendOAuthResult(response, true, '连接已授权，可以返回 DSH 继续使用。');
                }
                catch (error) {
                    return sendOAuthResult(response, false, error instanceof Error ? error.message : String(error));
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/audit-log',
            handler: (request, response) => {
                if (request.method !== 'GET') {
                    response.writeHead(405, { allow: 'GET' });
                    response.end();
                    return;
                }
                const url = new URL(request.url || '/dsh-node-flow/audit-log', 'http://localhost');
                const requestedLimit = Number(url.searchParams.get('limit'));
                const limit = Math.max(1, Math.min(200, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 200));
                const targetType = url.searchParams.get('targetType');
                const events = loadWorkflowAuditLog()
                    .filter((event) => !targetType || event.target.type === targetType)
                    .slice(0, limit);
                return sendJson(response, 200, { events });
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/credentials',
            handler: async (request, response) => {
                if (request.method === 'GET')
                    return sendJson(response, 200, { credentials: listCredentialSummaries(credentialDataDir()) });
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = await readJsonBody(request, 128 * 1024);
                    if (body?.action === 'save' && body.credential && typeof body.credential === 'object') {
                        const input = body.credential;
                        const existing = input.id ? listCredentialSummaries(credentialDataDir()).find((credential) => credential.id === input.id) : undefined;
                        const credential = saveCredential(credentialDataDir(), input);
                        await recordWorkflowAudit(existing ? 'credential.updated' : 'credential.created', { type: 'credential', id: credential.id, name: credential.name }, { kind: credential.kind });
                        return sendJson(response, 200, { credential });
                    }
                    if (body?.action === 'test') {
                        const credential = await testCredentialConnection(credentialDataDir(), String(body.id ?? ''));
                        await recordWorkflowAudit('credential.tested', { type: 'credential', id: credential.id, name: credential.name }, { kind: credential.kind, status: credential.status ?? 'untested' });
                        return sendJson(response, 200, { credential });
                    }
                    if (body?.action === 'cancel-authorize') {
                        const id = String(body.id ?? '');
                        for (const [key, pending] of pendingOAuthAuthorizations) {
                            if (pending.credentialId === id)
                                pendingOAuthAuthorizations.delete(key);
                        }
                        const credential = cancelCredentialAuthorization(credentialDataDir(), id);
                        await recordWorkflowAudit('credential.authorization-cancelled', { type: 'credential', id: credential.id, name: credential.name }, { kind: credential.kind });
                        return sendJson(response, 200, { credential });
                    }
                    if (body?.action === 'delete') {
                        const id = String(body.id ?? '');
                        const credential = listCredentialSummaries(credentialDataDir()).find((candidate) => candidate.id === id);
                        const references = loadWorkflows().filter((workflow) => [workflow.doc, workflow.publishedDoc]
                            .filter(Boolean)
                            .some((document) => document.nodes.some((node) => node.data.credentialId === id)));
                        if (references.length > 0)
                            return sendJson(response, 409, { error: `凭据仍被 ${references.length} 个工作流引用` });
                        if (!deleteCredential(credentialDataDir(), id))
                            return sendJson(response, 404, { error: '凭据不存在' });
                        for (const [key, pending] of pendingOAuthAuthorizations) {
                            if (pending.credentialId === id)
                                pendingOAuthAuthorizations.delete(key);
                        }
                        if (credential)
                            await recordWorkflowAudit('credential.deleted', { type: 'credential', id: credential.id, name: credential.name }, { kind: credential.kind });
                        return sendJson(response, 200, { ok: true });
                    }
                    return sendJson(response, 400, { error: 'unsupported credential action' });
                }
                catch (error) {
                    return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/node-test',
            handler: async (request, response) => {
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = await readJsonBody(request, 512 * 1024);
                    const node = body?.node;
                    if (!node?.id || !node.data?.kind)
                        return sendJson(response, 400, { error: 'node is required' });
                    const id = String(body?.runId ?? runId('test'));
                    const document = { version: 1, name: '节点测试', nodes: [node], edges: [] };
                    const currentWorkflowId = String(body?.workflowId ?? '') || undefined;
                    const parentRunId = String(body?.parentRunId ?? '') || undefined;
                    const run = await runWithController(id, (signal) => runDocumentGraph(ctx, document, body?.input, {
                        signal,
                        startNodeId: node.id,
                        singleNode: true,
                        runId: parentRunId ?? id,
                        workflowId: currentWorkflowId,
                        rootRunId: parentRunId ?? id,
                        workflowStack: currentWorkflowId ? [currentWorkflowId] : [],
                        subworkflowSnapshots: capturePublishedSubworkflows(currentWorkflowId, document, loadWorkflows()),
                        persistChildRuns: body?.persistChildRuns === true,
                    }));
                    const safeRun = sanitizeRun(run);
                    return sendJson(response, 200, { ok: safeRun.status === 'ok' || safeRun.status === 'handled', runId: id, run: safeRun, node: safeRun.nodes[0] });
                }
                catch (error) {
                    return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/webhook',
            handler: async (request, response) => {
                if (request.method === 'OPTIONS') {
                    response.writeHead(204, { allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' });
                    response.end();
                    return;
                }
                let idempotencyRecordId;
                try {
                    const requestUrl = new URL(request.url || '/dsh-node-flow/webhook', `http://${request.headers.host || 'localhost'}`);
                    const token = requestUrl.searchParams.get('token') || '';
                    if (token.length < 24)
                        return sendJson(response, 404, { error: 'webhook not found' });
                    const method = (request.method || 'GET').toUpperCase();
                    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
                        response.writeHead(405, { allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' });
                        response.end();
                        return;
                    }
                    let target;
                    for (const workflow of loadWorkflows()) {
                        if (workflow.status !== 'enabled' || !workflow.publishedDoc)
                            continue;
                        const node = workflow.publishedDoc.nodes.find((candidate) => candidate.data.kind === 'webhook'
                            && candidate.data.webhookToken === token
                            && (!candidate.data.httpMethod || candidate.data.httpMethod === 'ANY' || candidate.data.httpMethod === method));
                        if (node) {
                            target = { workflow, node };
                            break;
                        }
                    }
                    if (!target)
                        return sendJson(response, 404, { error: 'webhook not found' });
                    const rawBodyBytes = method === 'GET' || method === 'HEAD' ? new Uint8Array() : await readBodyBytes(request, 1024 * 1024);
                    const rawBody = new TextDecoder().decode(rawBodyBytes);
                    let signatureHeaderName;
                    let idempotencyHeaderName;
                    if (target.node.data.credentialId) {
                        signatureHeaderName = normalizeWebhookSignatureHeader(target.node.data.webhookSignatureHeader);
                        const signatureValue = request.headers[signatureHeaderName];
                        const signature = Array.isArray(signatureValue) ? signatureValue[0] : signatureValue;
                        const secret = resolveWebhookSecret(credentialDataDir(), target.node.data.credentialId);
                        if (!verifyWebhookSignature(rawBodyBytes, secret, signature))
                            return sendJson(response, 401, { error: 'invalid webhook signature' });
                    }
                    let parsedBody = rawBody;
                    if (rawBody && request.headers['content-type']?.includes('json')) {
                        try {
                            parsedBody = JSON.parse(rawBody);
                        }
                        catch {
                            return sendJson(response, 400, { error: 'invalid JSON body' });
                        }
                    }
                    idempotencyHeaderName = normalizeWebhookIdempotencyHeader(target.node.data.webhookIdempotencyHeader);
                    requestUrl.searchParams.delete('token');
                    const idempotencyKeyValue = idempotencyHeaderName ? request.headers[idempotencyHeaderName] : undefined;
                    if (idempotencyHeaderName && Array.isArray(idempotencyKeyValue))
                        return sendJson(response, 400, { error: 'Webhook 幂等键 Header 只能出现一次' });
                    if (idempotencyHeaderName && !idempotencyKeyValue)
                        return sendJson(response, 400, { error: `缺少 Webhook 幂等键 Header：${idempotencyHeaderName}` });
                    const idempotencyKey = idempotencyHeaderName ? normalizeWebhookIdempotencyKey(typeof idempotencyKeyValue === 'string' ? idempotencyKeyValue : undefined) : undefined;
                    const id = runId('webhook');
                    if (idempotencyKey && idempotencyHeaderName) {
                        const fingerprint = webhookRequestFingerprint(target.workflow.id, target.node.id, method, rawBodyBytes, requestUrl.searchParams.toString());
                        const claim = claimWebhookIdempotency(webhookIdempotencyDataDir(), {
                            workflowId: target.workflow.id,
                            nodeId: target.node.id,
                            method,
                            key: idempotencyKey,
                            fingerprint,
                            runId: id,
                            ttlSeconds: normalizeWebhookIdempotencyTtl(target.node.data.webhookIdempotencyTtl),
                        });
                        if (claim.kind === 'replay')
                            return sendWebhookResponse(response, claim.response, true);
                        if (claim.kind === 'processing') {
                            response.writeHead(409, { 'cache-control': 'no-store', 'retry-after': '1', 'x-dsh-run-id': claim.runId });
                            response.end(JSON.stringify({ error: '相同幂等键的 Webhook 仍在处理中', runId: claim.runId }));
                            return;
                        }
                        if (claim.kind === 'conflict')
                            return sendJson(response, 409, { error: '相同幂等键对应了不同的请求内容' });
                        idempotencyRecordId = claim.id;
                    }
                    const safeHeaders = Object.fromEntries(Object.entries(request.headers)
                        .filter(([name]) => !['authorization', 'cookie', 'proxy-authorization', signatureHeaderName, idempotencyHeaderName].includes(name))
                        .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]));
                    const input = { method, query: Object.fromEntries(requestUrl.searchParams.entries()), headers: safeHeaders, body: parsedBody };
                    const submission = await submitTriggeredWorkflowRun(ctx, {
                        id,
                        workflowId: target.workflow.id,
                        name: target.workflow.name,
                        doc: target.workflow.publishedDoc,
                        input,
                        startNodeId: target.node.id,
                        trigger: 'webhook',
                        webhookIdempotencyId: idempotencyRecordId,
                    });
                    if (!submission.completion) {
                        const queued = sanitizeRun(submission.run);
                        const status = queued.status === 'queued' ? 202 : 429;
                        if (idempotencyRecordId && queued.status !== 'queued')
                            releaseWebhookIdempotency(webhookIdempotencyDataDir(), idempotencyRecordId);
                        return sendJson(response, status, { ok: queued.status === 'queued', queued: queued.status === 'queued', runId: id, status: queued.status, error: queued.skipReason });
                    }
                    const run = await submission.completion;
                    const webhookResponse = webhookResponseForRun({ id, workflowId: target.workflow.id, name: target.workflow.name, doc: target.workflow.publishedDoc, input, startNodeId: target.node.id, trigger: 'webhook', webhookIdempotencyId: idempotencyRecordId }, run);
                    if (idempotencyRecordId)
                        finalizeWebhookIdempotency({ id, workflowId: target.workflow.id, name: target.workflow.name, doc: target.workflow.publishedDoc, input, startNodeId: target.node.id, trigger: 'webhook', webhookIdempotencyId: idempotencyRecordId }, run);
                    if (!webhookResponse)
                        return sendJson(response, 500, { error: 'Webhook response could not be built' });
                    sendWebhookResponse(response, webhookResponse);
                }
                catch (error) {
                    if (idempotencyRecordId)
                        releaseWebhookIdempotency(webhookIdempotencyDataDir(), idempotencyRecordId);
                    return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        // --- workflow folders (control-plane metadata; never part of an execution snapshot) ---
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/workflow-folders',
            handler: async (request, response) => {
                if (request.method === 'GET')
                    return sendJson(response, 200, { folders: loadWorkflowFolders() });
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = await readJsonBody(request, 32 * 1024);
                    if (body?.action === 'create') {
                        const created = await withWorkflowMutation(() => {
                            const folders = loadWorkflowFolders();
                            if (folders.length >= MAX_WORKFLOW_FOLDERS)
                                throw new Error(`文件夹最多保存 ${MAX_WORKFLOW_FOLDERS} 个`);
                            const name = normalizeWorkflowFolderName(body.name);
                            if (folders.some((folder) => folder.name.localeCompare(name, 'zh-CN', { sensitivity: 'accent' }) === 0))
                                throw new Error('同名文件夹已存在');
                            const folder = createWorkflowFolder({
                                id: `folder-${randomBytes(12).toString('base64url')}`,
                                name,
                            }, new Date().toISOString());
                            saveWorkflowFolders([...folders, folder]);
                            return folder;
                        });
                        await recordWorkflowAudit('folder.created', { type: 'folder', id: created.id, name: created.name }, { revision: created.revision });
                        return sendJson(response, 200, { folder: created, folders: loadWorkflowFolders() });
                    }
                    if (body?.action === 'rename') {
                        const renamed = await withWorkflowMutation(() => {
                            const folders = loadWorkflowFolders();
                            const id = requireWorkflowFolderId(body.id);
                            const existing = folders.find((folder) => folder.id === id);
                            if (!existing)
                                return { status: 'missing' };
                            if (!workflowFolderRevisionMatches(existing, body.expectedRevision))
                                return { status: 'conflict', latest: existing };
                            const name = normalizeWorkflowFolderName(body.name);
                            if (folders.some((folder) => folder.id !== id && folder.name.localeCompare(name, 'zh-CN', { sensitivity: 'accent' }) === 0))
                                throw new Error('同名文件夹已存在');
                            const folder = renameWorkflowFolder(existing, name, new Date().toISOString());
                            saveWorkflowFolders(folders.map((candidate) => candidate.id === id ? folder : candidate));
                            return { status: 'renamed', folder, changed: folder.revision !== existing.revision };
                        });
                        if (renamed.status === 'missing')
                            return sendJson(response, 404, { error: '文件夹不存在' });
                        if (renamed.status === 'conflict')
                            return sendJson(response, 409, { error: '文件夹已被其他操作更新，请刷新后重试', latest: renamed.latest });
                        if (renamed.changed)
                            await recordWorkflowAudit('folder.renamed', { type: 'folder', id: renamed.folder.id, name: renamed.folder.name }, { revision: renamed.folder.revision });
                        return sendJson(response, 200, { folder: renamed.folder, folders: loadWorkflowFolders() });
                    }
                    if (body?.action === 'delete') {
                        const deleted = await withWorkflowMutation(() => {
                            const folders = loadWorkflowFolders();
                            const id = requireWorkflowFolderId(body.id);
                            const existing = folders.find((folder) => folder.id === id);
                            if (!existing)
                                return { status: 'missing' };
                            if (!workflowFolderRevisionMatches(existing, body.expectedRevision))
                                return { status: 'conflict', latest: existing };
                            const remaining = folders.filter((folder) => folder.id !== id);
                            const destination = existingFolderForId(remaining, body.targetFolderId);
                            const now = new Date().toISOString();
                            const workflows = loadWorkflows();
                            let moved = 0;
                            const next = workflows.map((workflow) => {
                                if (workflow.folderId !== id)
                                    return workflow;
                                moved += 1;
                                return moveWorkflowToFolder(workflow, destination?.id, now);
                            });
                            saveWorkflows(next);
                            saveWorkflowFolders(remaining);
                            return { status: 'deleted', folder: existing, moved, destination };
                        });
                        if (deleted.status === 'missing')
                            return sendJson(response, 404, { error: '文件夹不存在' });
                        if (deleted.status === 'conflict')
                            return sendJson(response, 409, { error: '文件夹已被其他操作更新，请刷新后重试', latest: deleted.latest });
                        await recordWorkflowAudit('folder.deleted', { type: 'folder', id: deleted.folder.id, name: deleted.folder.name }, {
                            revision: deleted.folder.revision,
                            moved: deleted.moved,
                            destination: deleted.destination?.name ?? '未分类',
                        });
                        return sendJson(response, 200, { ok: true, folders: loadWorkflowFolders(), workflows: loadWorkflows(), moved: deleted.moved });
                    }
                    return sendJson(response, 400, { error: 'unsupported workflow folder action' });
                }
                catch (error) {
                    return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        // --- saved workflow library ---
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/workflows',
            handler: async (request, response) => {
                if (request.method === 'GET') {
                    const workflows = loadWorkflows().sort((left, right) => {
                        const created = right.createdAt.localeCompare(left.createdAt);
                        return created !== 0 ? created : left.id.localeCompare(right.id);
                    });
                    ensureWorkflowVersions(workflows);
                    return sendJson(response, 200, { workflows, capabilities: { directRun: true, runWrites: true, workflowRevisions: true, workflowVersions: true, workflowFolders: true, credentials: true, oauth2: true, connectionTesting: true, webhooks: true, webhookSignatures: true, webhookResponses: true, webhookIdempotency: true, nodeTesting: true, runCancellation: true, runRetries: true, runRecovery: true, errorRoutes: true, runDetails: true, runReplay: true, waitpoints: true, waitpointCallbacks: true, approvals: true, debugger: true, subworkflows: true, connectors: true, connectorVersions: true, connectorDynamicOptions: true, pollingTriggers: true, projectVariables: true, projectSecrets: true, dataStore: true, workflowConcurrency: true, executionLimits: true, persistentRunQueue: true, workflowInputContracts: true, auditLog: true, scheduleTimezones: true, strictCron: true } });
                }
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = (await readJsonBody(request, 2 * 1024 * 1024));
                    if (body?.action === 'cancel') {
                        const id = String(body.runId ?? '');
                        const controller = activeRuns.get(id) ?? pendingRootRuns.get(id);
                        if (controller) {
                            const activeRun = loadRuns().find((run) => run.id === id);
                            const accepted = !controller.signal.aborted;
                            if (accepted)
                                controller.abort(new Error('运行已取消'));
                            if (accepted)
                                void cancelDescendantRuns(ctx, id, '父工作流已取消');
                            if (accepted) {
                                await recordWorkflowAudit(activeRun?.trigger === 'debug' ? 'run.debug-cancelled' : 'run.cancelled', {
                                    type: 'run', id, name: activeRun?.name,
                                }, activeRun?.workflowId ? { workflowId: activeRun.workflowId } : undefined);
                            }
                            return sendJson(response, 200, { ok: true, runId: id });
                        }
                        const cancelled = await withRunMutation(() => {
                            const runs = loadRuns();
                            const queued = runs.find((run) => run.id === id && run.status === 'queued');
                            if (queued) {
                                const nextRun = { ...queued, status: 'cancelled', completedAt: new Date().toISOString(), queue: undefined, skipReason: '已在排队期间取消', resumable: false };
                                const next = restoreResumeClaim(upsertRunRecord(runs, nextRun), nextRun);
                                saveRuns(redactProjectSecrets(next, listProjectSecretValues(projectVariableDataDir())));
                                return { workflowId: queued.workflowId, name: queued.name, waiting: false, debug: queued.trigger === 'debug', run: nextRun };
                            }
                            const waiting = runs.find((run) => run.id === id && run.status === 'waiting' && !run.resumedByRunId);
                            if (!waiting)
                                return undefined;
                            const nextRun = { ...waiting, status: 'cancelled', completedAt: new Date().toISOString(), waitpoint: undefined, resumable: false };
                            saveRuns(redactProjectSecrets(upsertRunRecord(runs, nextRun), listProjectSecretValues(projectVariableDataDir())));
                            return { workflowId: waiting.workflowId, name: waiting.name, waiting: true, debug: waiting.waitpoint?.mode === 'debug' || waiting.trigger === 'debug', run: nextRun };
                        });
                        if (!cancelled)
                            return sendJson(response, 404, { error: '运行不存在或已结束' });
                        if (cancelled.run?.webhookIdempotencyId)
                            releaseWebhookIdempotency(webhookIdempotencyDataDir(), cancelled.run.webhookIdempotencyId);
                        if (cancelled.waiting)
                            rescheduleWaitpoints(ctx);
                        if (cancelled.run?.parentRunId)
                            void resumeWaitingParentForChild(ctx, cancelled.run);
                        if (cancelled.waiting)
                            void cancelDescendantRuns(ctx, id, '父工作流已取消');
                        if (cancelled.workflowId)
                            void drainQueuedWorkflowRuns(ctx, cancelled.workflowId);
                        await recordWorkflowAudit(cancelled.debug ? 'run.debug-cancelled' : 'run.cancelled', {
                            type: 'run', id, name: cancelled.name,
                        }, {
                            ...(cancelled.workflowId ? { workflowId: cancelled.workflowId } : {}),
                            waiting: cancelled.waiting,
                        });
                        return sendJson(response, 200, { ok: true, runId: id });
                    }
                    if (body?.action === 'delete') {
                        return await withWorkflowMutation(async () => {
                            const workflows = loadWorkflows();
                            const id = String(body.id ?? '');
                            if (!id)
                                return sendJson(response, 400, { error: 'workflow id is required' });
                            const workflow = workflows.find((candidate) => candidate.id === id);
                            if (!workflow)
                                return sendJson(response, 404, { error: 'workflow not found' });
                            if (!workflowRevisionMatches(workflow, body.expectedRevision)) {
                                return sendJson(response, 409, { error: 'workflow revision conflict', latest: workflow });
                            }
                            const references = activeWorkflowReferences(id, workflows);
                            if (references.length > 0)
                                return sendJson(response, 409, { error: `工作流正被“${references[0].name}”等已启用流程调用，无法删除` });
                            const next = workflows.filter((workflow) => workflow.id !== id);
                            const deletedDataStoreEntries = await withDataStoreMutation(() => deleteDataStoreWorkflow(credentialDataDir(), id));
                            saveWorkflows(next);
                            await cancelQueuedWorkflowRuns(id, '工作流已删除，已取消排队运行');
                            removeWebhookIdempotencyWorkflow(webhookIdempotencyDataDir(), id);
                            removeWorkflowSchedules(id);
                            await removeWorkflowPollingTriggers(id);
                            removeWorkflowVersions(id);
                            rescheduleScheduler(ctx);
                            reschedulePollingTriggers(ctx);
                            await recordWorkflowAudit('workflow.deleted', {
                                type: 'workflow', id: workflow.id, name: workflow.name,
                            }, { revision: workflow.revision, enabled: workflow.status === 'enabled', deletedDataStoreEntries });
                            return sendJson(response, 200, { ok: true });
                        });
                    }
                    if (body?.action === 'status') {
                        return await withWorkflowMutation(async () => {
                            const workflows = loadWorkflows();
                            const id = String(body.id ?? '');
                            const status = body.status === 'enabled' ? 'enabled' : 'disabled';
                            const workflow = workflows.find((candidate) => candidate.id === id);
                            if (!workflow)
                                return sendJson(response, 404, { error: 'workflow not found' });
                            if (!workflowRevisionMatches(workflow, body.expectedRevision)) {
                                return sendJson(response, 409, { error: 'workflow revision conflict', latest: workflow });
                            }
                            if (status === 'disabled') {
                                const references = activeWorkflowReferences(id, workflows);
                                if (references.length > 0)
                                    return sendJson(response, 409, { error: `工作流正被“${references[0].name}”等已启用流程调用，无法停用` });
                            }
                            if (status === 'enabled') {
                                const publishError = validateWorkflowPublish(workflow, workflows);
                                if (publishError)
                                    return sendJson(response, 400, { error: publishError });
                            }
                            const saved = publishWorkflow(workflow, status, new Date().toISOString());
                            saveWorkflows(workflows.map((candidate) => candidate.id === saved.id ? saved : candidate));
                            if (status === 'disabled')
                                await cancelQueuedWorkflowRuns(id, '工作流已停用，已取消排队运行');
                            saveWorkflowVersion(saved, status === 'enabled' ? 'published' : 'disabled');
                            syncWorkflowSchedules(saved);
                            await syncWorkflowPollingTriggers(saved);
                            rescheduleScheduler(ctx);
                            reschedulePollingTriggers(ctx);
                            await recordWorkflowAudit(status === 'enabled' ? 'workflow.published' : 'workflow.disabled', {
                                type: 'workflow', id: saved.id, name: saved.name,
                            }, status === 'enabled'
                                ? { revision: saved.revision, publishedRevision: saved.publishedRevision ?? saved.revision }
                                : { revision: saved.revision });
                            return sendJson(response, 200, { workflow: saved });
                        });
                    }
                    if (body?.action === 'move-folder') {
                        return await withWorkflowMutation(async () => {
                            const workflows = loadWorkflows();
                            const id = String(body.id ?? '');
                            const workflow = workflows.find((candidate) => candidate.id === id);
                            if (!workflow)
                                return sendJson(response, 404, { error: 'workflow not found' });
                            if (!workflowRevisionMatches(workflow, body.expectedRevision)) {
                                return sendJson(response, 409, { error: 'workflow revision conflict', latest: workflow });
                            }
                            const destination = existingFolderForId(loadWorkflowFolders(), body.folderId);
                            const saved = moveWorkflowToFolder(workflow, destination?.id, new Date().toISOString());
                            if (saved.revision === workflow.revision)
                                return sendJson(response, 200, { workflow });
                            saveWorkflows(workflows.map((candidate) => candidate.id === saved.id ? saved : candidate));
                            await recordWorkflowAudit('workflow.moved', {
                                type: 'workflow', id: saved.id, name: saved.name,
                            }, {
                                revision: saved.revision,
                                destination: destination?.name ?? '未分类',
                            });
                            return sendJson(response, 200, { workflow: saved });
                        });
                    }
                    if (body?.action === 'run') {
                        const workflows = loadWorkflows();
                        const workflowId = String(body.id ?? '');
                        const workflow = workflows.find((candidate) => candidate.id === workflowId);
                        if (!workflow)
                            return sendJson(response, 404, { error: 'workflow not found' });
                        const activeRunId = String(body.runId ?? runId());
                        const requestedDocument = body.document && typeof body.document === 'object' ? body.document : undefined;
                        if (requestedDocument && (!Array.isArray(requestedDocument.nodes) || !Array.isArray(requestedDocument.edges)))
                            return sendJson(response, 400, { error: 'invalid workflow document' });
                        const document = workflow.status === 'enabled'
                            ? executionDocument(workflow)
                            : requestedDocument
                                ? pinDocumentConnectorVersions({ ...requestedDocument, nodes: requestedDocument.nodes.map((node) => ({ ...node, data: { ...node.data, lastRun: undefined } })) })
                                : executionDocument(workflow);
                        validateWorkflowExecutionLimits(document.executionLimits);
                        validateWorkflowErrorRoutes(document);
                        validateWorkflowWaitpoints(document);
                        const rawInput = body.input === undefined && document.inputs?.length ? {} : body.input;
                        const input = validateWorkflowContract(rawInput, document.inputs, '工作流输入');
                        const replayInput = captureReplayInput(input);
                        const submission = await submitTriggeredWorkflowRun(ctx, {
                            id: activeRunId,
                            workflowId: workflow.id,
                            name: workflow.name,
                            doc: document,
                            input,
                            trigger: 'manual',
                            requiresEnabled: false,
                            replayInput: replayInput.available ? replayInput.input : undefined,
                            replayInputAvailable: replayInput.available,
                        });
                        if (submission.run.status !== 'skipped') {
                            await recordWorkflowAudit('run.manual-started', {
                                type: 'run', id: submission.run.id, name: submission.run.name,
                            }, { workflowId: workflow.id, queued: submission.run.status === 'queued' });
                        }
                        const run = submission.completion ? await submission.completion : submission.run;
                        const saved = loadWorkflows().find((candidate) => candidate.id === workflowId) ?? workflow;
                        return sendJson(response, run.status === 'queued' || run.status === 'waiting' ? 202 : run.status === 'skipped' ? 429 : 200, { workflow: saved, run: sanitizeRun(run) });
                    }
                    if (body?.action === 'debug') {
                        const workflows = loadWorkflows();
                        const workflowId = String(body.id ?? '');
                        const workflow = workflows.find((candidate) => candidate.id === workflowId);
                        if (!workflow)
                            return sendJson(response, 404, { error: 'workflow not found' });
                        const activeRunId = String(body.runId ?? runId('debug'));
                        const requestedDocument = body.document && typeof body.document === 'object' ? body.document : undefined;
                        if (requestedDocument && (!Array.isArray(requestedDocument.nodes) || !Array.isArray(requestedDocument.edges)))
                            return sendJson(response, 400, { error: 'invalid workflow document' });
                        // Debugging intentionally runs the editable draft, never the published production snapshot.
                        const sourceDocument = requestedDocument ?? workflow.doc;
                        const document = pinDocumentConnectorVersions({
                            ...sourceDocument,
                            nodes: sourceDocument.nodes.map((node) => ({ ...node, data: { ...node.data, lastRun: undefined } })),
                        });
                        validateWorkflowExecutionLimits(document.executionLimits);
                        validateWorkflowErrorRoutes(document);
                        validateWorkflowWaitpoints(document);
                        validateWorkflowDebugDocument(document);
                        validateWorkflowConcurrency(document.concurrency);
                        if (!document.nodes.some((node) => node.data.breakpoint))
                            return sendJson(response, 400, { error: '请至少在一个节点启用断点后再开始调试' });
                        const rawInput = body.input === undefined && document.inputs?.length ? {} : body.input;
                        const input = validateWorkflowContract(rawInput, document.inputs, '调试输入');
                        if (hasUnsafePersistentInput(input))
                            return sendJson(response, 400, { error: '调试输入含认证字段或项目 Secret，无法安全持久化' });
                        const submission = await submitTriggeredWorkflowRun(ctx, {
                            id: activeRunId,
                            workflowId: workflow.id,
                            name: workflow.name,
                            doc: document,
                            input,
                            trigger: 'debug',
                            requiresEnabled: false,
                            debug: true,
                        });
                        if (submission.run.status !== 'skipped') {
                            await recordWorkflowAudit('run.debug-started', {
                                type: 'run', id: submission.run.id, name: submission.run.name,
                            }, { workflowId: workflow.id, queued: submission.run.status === 'queued' });
                        }
                        const run = submission.completion ? await submission.completion : submission.run;
                        const saved = loadWorkflows().find((candidate) => candidate.id === workflowId) ?? workflow;
                        return sendJson(response, run.status === 'queued' || run.status === 'waiting' ? 202 : run.status === 'skipped' ? 429 : 200, { workflow: saved, run: sanitizeRun(run) });
                    }
                    if (body?.action === 'run-meta') {
                        return await withWorkflowMutation(() => {
                            const workflows = loadWorkflows();
                            const id = String(body.id ?? '');
                            const workflow = workflows.find((candidate) => candidate.id === id);
                            if (!workflow)
                                return sendJson(response, 404, { error: 'workflow not found' });
                            workflow.lastRunAt = String(body.startedAt ?? new Date().toISOString());
                            saveWorkflows(workflows);
                            return sendJson(response, 200, { workflow });
                        });
                    }
                    if (body?.action !== 'save' || body.workflow === null || typeof body.workflow !== 'object') {
                        return sendJson(response, 400, { error: 'unsupported workflow action' });
                    }
                    return await withWorkflowMutation(async () => {
                        const workflows = loadWorkflows();
                        const incoming = body.workflow;
                        const doc = incoming.doc;
                        if (!incoming.id || !doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
                            return sendJson(response, 400, { error: 'workflow id and document are required' });
                        }
                        validateWorkflowExecutionLimits(doc.executionLimits);
                        const now = new Date().toISOString();
                        const existing = workflows.find((candidate) => candidate.id === incoming.id);
                        const expectedRevision = Number(body.expectedRevision);
                        if (existing && !workflowRevisionMatches(existing, expectedRevision)) {
                            return sendJson(response, 409, { error: 'workflow revision conflict', latest: existing });
                        }
                        if (!existing && !workflowRevisionMatches(existing, expectedRevision)) {
                            return sendJson(response, 409, { error: 'workflow no longer exists' });
                        }
                        const requestedFolder = existing ? undefined : existingFolderForId(loadWorkflowFolders(), incoming.folderId);
                        const source = pinWorkflowConnectorVersions({
                            ...incoming,
                            ...(requestedFolder ? { folderId: requestedFolder.id } : { folderId: undefined }),
                        });
                        const workflow = existing
                            ? updateWorkflowDraft(existing, source, now)
                            : createSavedWorkflow(source, now);
                        const next = workflows.filter((candidate) => candidate.id !== workflow.id);
                        next.push(workflow);
                        if (!existing && workflow.status === 'enabled') {
                            const publishError = validateWorkflowPublish(workflow, next);
                            if (publishError)
                                return sendJson(response, 400, { error: publishError });
                        }
                        saveWorkflows(next);
                        saveWorkflowVersion(workflow, existing ? 'draft' : 'created');
                        if (!existing) {
                            await recordWorkflowAudit('workflow.created', {
                                type: 'workflow', id: workflow.id, name: workflow.name,
                            }, { revision: workflow.revision, enabled: workflow.status === 'enabled' });
                            if (workflow.status === 'enabled') {
                                await recordWorkflowAudit('workflow.published', {
                                    type: 'workflow', id: workflow.id, name: workflow.name,
                                }, { revision: workflow.revision, initial: true });
                            }
                        }
                        return sendJson(response, 200, { workflow });
                    });
                }
                catch (err) {
                    return sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/workflow-versions',
            handler: async (request, response) => {
                if (request.method === 'GET') {
                    const workflows = loadWorkflows();
                    const workflowId = new URL(request.url ?? '/', 'http://local').searchParams.get('workflowId') ?? '';
                    const workflow = workflows.find((candidate) => candidate.id === workflowId);
                    if (!workflow)
                        return sendJson(response, 404, { error: 'workflow not found' });
                    const versions = ensureWorkflowVersions(workflows)
                        .filter((version) => version.workflowId === workflowId)
                        .sort((left, right) => right.revision - left.revision);
                    return sendJson(response, 200, { workflow, versions });
                }
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = (await readJsonBody(request, 256 * 1024));
                    if (body?.action !== 'restore')
                        return sendJson(response, 400, { error: 'unsupported version action' });
                    return await withWorkflowMutation(async () => {
                        const workflows = loadWorkflows();
                        const id = String(body.id ?? '');
                        const versionId = String(body.versionId ?? '');
                        const workflow = workflows.find((candidate) => candidate.id === id);
                        if (!workflow)
                            return sendJson(response, 404, { error: 'workflow not found' });
                        if (!workflowRevisionMatches(workflow, body.expectedRevision)) {
                            return sendJson(response, 409, { error: 'workflow revision conflict', latest: workflow });
                        }
                        const versions = ensureWorkflowVersions(workflows);
                        const version = versions.find((candidate) => candidate.id === versionId && candidate.workflowId === id);
                        if (!version)
                            return sendJson(response, 404, { error: 'workflow version not found' });
                        const publish = body.publish === true;
                        const restored = pinWorkflowConnectorVersions(restoreWorkflowVersion(workflow, version, publish, new Date().toISOString()));
                        if (publish) {
                            const publishError = validateWorkflowPublish(restored, workflows);
                            if (publishError)
                                return sendJson(response, 400, { error: publishError });
                        }
                        saveWorkflows(workflows.map((candidate) => candidate.id === restored.id ? restored : candidate));
                        const restoredVersion = saveWorkflowVersion(restored, publish ? 'restored-published' : 'restored', version.id);
                        if (publish) {
                            syncWorkflowSchedules(restored);
                            await syncWorkflowPollingTriggers(restored);
                            rescheduleScheduler(ctx);
                            reschedulePollingTriggers(ctx);
                        }
                        await recordWorkflowAudit('workflow.restored', {
                            type: 'workflow', id: restored.id, name: restored.name,
                        }, {
                            revision: restored.revision,
                            sourceRevision: version.revision,
                            published: publish,
                        });
                        return sendJson(response, 200, { workflow: restored, version: restoredVersion });
                    });
                }
                catch (error) {
                    return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        // --- schedule routes ---
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/schedule',
            handler: async (request, response) => {
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = (await readJsonBody(request, 256 * 1024));
                    const schedules = loadSchedules();
                    if (body?.action === 'clear') {
                        const id = String(body.id ?? '');
                        const next = schedules.filter((s) => s.id !== id);
                        writeJson(schedulesFile(), next);
                        rescheduleScheduler(ctx);
                        return sendJson(response, 200, { ok: true, schedules: next.map((s) => scheduleResponseRecord(s)) });
                    }
                    // Manual "run now" from the scheduled-task board.
                    if (body?.action === 'run') {
                        const scheduleId = String(body.id ?? '');
                        const sched = schedules.find((s) => s.id === scheduleId);
                        if (!sched)
                            return sendJson(response, 404, { error: 'schedule not found' });
                        if (!sched.doc)
                            return sendJson(response, 400, { error: 'schedule has no workflow snapshot' });
                        const activeRunId = runId('schedule');
                        const workflowId = sched.workflowId ?? /^workflow:([^:]+):/.exec(sched.id)?.[1];
                        if (!workflowId) {
                            const run = await runWithController(activeRunId, (signal) => runPersistedDocument(ctx, {
                                id: activeRunId,
                                scheduleId: sched.id,
                                name: sched.name,
                                doc: sched.doc,
                                input: sched.input,
                                trigger: 'schedule',
                            }, signal));
                            return sendJson(response, 200, { ok: true, run: sanitizeRun(run) });
                        }
                        const submission = await submitTriggeredWorkflowRun(ctx, {
                            id: activeRunId,
                            workflowId,
                            scheduleId: sched.id,
                            name: sched.name,
                            doc: sched.doc,
                            input: sched.input,
                            trigger: 'schedule',
                            requiresEnabled: false,
                        });
                        const run = submission.completion ? await submission.completion : submission.run;
                        return sendJson(response, run.status === 'queued' ? 202 : run.status === 'skipped' ? 429 : 200, { ok: run.status !== 'skipped', queued: run.status === 'queued', run: sanitizeRun(run) });
                    }
                    const id = String(body?.id ?? `s-${Date.now().toString(36)}`);
                    const workflowId = typeof body?.workflowId === 'string' && body.workflowId.trim()
                        ? body.workflowId.trim()
                        : /^workflow:([^:]+):/.exec(id)?.[1];
                    const configuration = validateScheduleConfiguration(body?.cron, body?.timezone);
                    const name = String(body?.name ?? 'scheduled workflow');
                    const steps = Array.isArray(body?.steps) ? body.steps : [];
                    const doc = body?.doc && typeof body.doc === 'object' ? body.doc : undefined;
                    if ((!steps.length && !doc)) {
                        return sendJson(response, 400, { error: 'cron and steps (or doc) are required' });
                    }
                    const previous = schedules.find((schedule) => schedule.id === id);
                    const preserveFireState = previous?.cron === configuration.cron && previous.timezone === configuration.timezone;
                    const next = schedules.filter((s) => s.id !== id);
                    next.push({
                        id,
                        workflowId,
                        name,
                        cron: configuration.cron,
                        ...(configuration.timezone ? { timezone: configuration.timezone } : {}),
                        input: body?.input,
                        steps,
                        doc,
                        ...(preserveFireState && previous?.lastFired ? { lastFired: previous.lastFired } : {}),
                        ...(preserveFireState && previous?.lastFiredWallClock ? { lastFiredWallClock: previous.lastFiredWallClock } : {}),
                    });
                    writeJson(schedulesFile(), next);
                    rescheduleScheduler(ctx);
                    return sendJson(response, 200, { ok: true, schedules: next.map((s) => scheduleResponseRecord(s)) });
                }
                catch (err) {
                    return sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/schedules',
            handler: (request, response) => {
                if (request.method !== 'GET') {
                    response.writeHead(405, { allow: 'GET' });
                    response.end();
                    return;
                }
                const list = loadSchedules().map((schedule) => scheduleResponseRecord(schedule));
                sendJson(response, 200, { schedules: list });
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/waitpoint-callback',
            handler: async (request, response) => {
                if (request.method !== 'POST')
                    return sendJson(response, 405, { error: 'method not allowed' });
                try {
                    const tokenValue = request.headers['x-dsh-wait-token'];
                    const token = Array.isArray(tokenValue) ? tokenValue[0] : tokenValue;
                    if (!token || token.length < 32)
                        return sendJson(response, 401, { error: 'invalid waitpoint token' });
                    const source = loadRuns().find((run) => run.status === 'waiting'
                        && !run.resumedByRunId
                        && run.waitpoint?.mode === 'callback'
                        && waitpointTokenMatches(run.waitpoint, token));
                    if (!source?.waitpoint)
                        return sendJson(response, 404, { error: 'waitpoint not found' });
                    if (waitpointTimedOut(source.waitpoint))
                        return sendJson(response, 410, { error: 'waitpoint expired' });
                    const rawBody = await readBodyBytes(request, 1024 * 1024);
                    const text = new TextDecoder().decode(rawBody);
                    let input = text;
                    if (text && request.headers['content-type']?.includes('json')) {
                        try {
                            input = JSON.parse(text);
                        }
                        catch {
                            return sendJson(response, 400, { error: 'invalid JSON body' });
                        }
                    }
                    const run = await resolvePersistedWaitpoint(ctx, source.id, input);
                    return sendJson(response, run.status === 'waiting' ? 202 : run.status === 'ok' || run.status === 'handled' ? 200 : 500, { ok: run.status === 'ok' || run.status === 'handled' || run.status === 'waiting', runId: run.id, status: run.status });
                }
                catch (error) {
                    return sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        }));
        disposers.push(webServer.register({
            kind: 'exact',
            path: '/dsh-node-flow/runs',
            handler: async (request, response) => {
                if (request.method === 'GET') {
                    const url = new URL(request.url || '/dsh-node-flow/runs', 'http://localhost');
                    const id = url.searchParams.get('id');
                    if (id) {
                        const run = loadRuns().find((candidate) => candidate.id === id);
                        if (!run)
                            return sendJson(response, 404, { error: '运行记录不存在' });
                        return sendJson(response, 200, { run: sanitizeRunDetail(run), replayable: canReplayPersistedRun(run), writable: true });
                    }
                    if (url.searchParams.get('view') === 'summary') {
                        return sendJson(response, 200, { runs: loadRuns().map(summarizeRun), writable: true });
                    }
                    return sendJson(response, 200, { runs: loadRuns().map(sanitizeRun), writable: true });
                }
                if (rejectNonPost(request, response))
                    return;
                if (!sameOrigin(request))
                    return sendJson(response, 403, { error: 'untrusted origin' });
                try {
                    const body = (await readJsonBody(request, 2 * 1024 * 1024));
                    if (body?.action === 'replay') {
                        const source = loadRuns().find((run) => run.id === String(body.id ?? ''));
                        if (!source)
                            return sendJson(response, 404, { error: '运行记录不存在' });
                        if (!canReplayPersistedRun(source) || !source.workflowId || !source.snapshot) {
                            return sendJson(response, 409, { error: '该运行没有可用的安全重放快照' });
                        }
                        const workflow = loadWorkflows().find((candidate) => candidate.id === source.workflowId);
                        if (!workflow)
                            return sendJson(response, 409, { error: '原工作流已删除，无法重放' });
                        const id = String(body.runId ?? runId('replay'));
                        const submission = await submitTriggeredWorkflowRun(ctx, {
                            id,
                            workflowId: source.workflowId,
                            name: source.name,
                            doc: structuredClone(source.snapshot),
                            input: source.replayInput,
                            trigger: 'replay',
                            requiresEnabled: false,
                            replayInput: source.replayInput,
                            replayInputAvailable: true,
                            replayedFromRunId: source.id,
                            subworkflowSnapshots: source.subworkflowSnapshots,
                        });
                        if (submission.run.status !== 'skipped') {
                            await recordWorkflowAudit('run.replayed', {
                                type: 'run', id: submission.run.id, name: submission.run.name,
                            }, {
                                workflowId: source.workflowId,
                                replayedFrom: source.id,
                                queued: submission.run.status === 'queued',
                            });
                        }
                        const run = submission.completion ? await submission.completion : submission.run;
                        return sendJson(response, run.status === 'queued' ? 202 : run.status === 'skipped' ? 429 : 200, { ok: run.status !== 'skipped', run: sanitizeRun(run) });
                    }
                    if (body?.action === 'debug-continue' || body?.action === 'debug-step') {
                        const sourceId = String(body.id ?? '');
                        const source = loadRuns().find((run) => run.id === sourceId);
                        if (!source)
                            return sendJson(response, 404, { error: '运行记录不存在' });
                        if (source.status !== 'waiting' || source.resumedByRunId || source.waitpoint?.mode !== 'debug') {
                            return sendJson(response, 409, { error: '当前运行不在调试暂停状态' });
                        }
                        const action = body.action === 'debug-step' ? 'step' : 'continue';
                        const id = String(body.runId ?? runId(action === 'step' ? 'debug-step' : 'debug-continue'));
                        let run;
                        try {
                            run = await resolvePersistedDebugWaitpoint(ctx, source.id, action, id);
                        }
                        catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            if (message === '当前运行不在调试暂停状态')
                                return sendJson(response, 409, { error: message });
                            throw error;
                        }
                        await recordWorkflowAudit(action === 'step' ? 'run.debug-stepped' : 'run.debug-continued', {
                            type: 'run', id: run.id, name: run.name,
                        }, {
                            ...(run.workflowId ? { workflowId: run.workflowId } : {}),
                            sourceRunId: source.id,
                            waiting: run.status === 'waiting',
                        });
                        return sendJson(response, run.status === 'waiting' ? 202 : run.status === 'ok' || run.status === 'handled' ? 200 : 500, { ok: run.status === 'ok' || run.status === 'handled' || run.status === 'waiting', run: sanitizeRun(run) });
                    }
                    if (body?.action === 'resume') {
                        const previous = loadRuns().find((run) => run.id === String(body.id ?? ''));
                        if (!previous)
                            return sendJson(response, 404, { error: '运行记录不存在' });
                        const id = String(body.runId ?? runId('resume'));
                        const run = await resumePersistedRun(ctx, previous, id);
                        if (run.status !== 'skipped') {
                            await recordWorkflowAudit('run.resumed', {
                                type: 'run', id: run.id, name: run.name,
                            }, {
                                ...(run.workflowId ? { workflowId: run.workflowId } : {}),
                                resumedFrom: previous.id,
                                queued: run.status === 'queued',
                            });
                        }
                        return sendJson(response, 200, { ok: run.status === 'ok' || run.status === 'handled', run: sanitizeRun(run) });
                    }
                    if (body?.action === 'create-wait-token') {
                        const id = String(body.id ?? '');
                        const run = loadRuns().find((candidate) => candidate.id === id);
                        if (!run?.waitpoint || run.status !== 'waiting' || run.resumedByRunId || run.waitpoint.mode !== 'callback')
                            return sendJson(response, 409, { error: '当前运行不在等待外部回调' });
                        if (waitpointTimedOut(run.waitpoint))
                            return sendJson(response, 410, { error: '等待回调已超时' });
                        const token = randomBytes(32).toString('base64url');
                        saveRun({ ...run, waitpoint: { ...run.waitpoint, tokenHash: waitpointTokenHash(token) } });
                        return sendJson(response, 200, { callbackUrl: '/dsh-node-flow/waitpoint-callback', token });
                    }
                    if (body?.action === 'resolve-waitpoint') {
                        const id = String(body.id ?? '');
                        const source = loadRuns().find((candidate) => candidate.id === id);
                        if (!source?.waitpoint || source.status !== 'waiting' || source.resumedByRunId || source.waitpoint.mode !== 'approval')
                            return sendJson(response, 409, { error: '当前运行不在等待审批' });
                        if (waitpointTimedOut(source.waitpoint))
                            return sendJson(response, 410, { error: '等待审批已超时' });
                        const decision = String(body.decision ?? '');
                        if (!['approved', 'rejected'].includes(decision))
                            return sendJson(response, 400, { error: '审批结果无效' });
                        const note = String(body.note ?? '').slice(0, 4000);
                        const run = await resolvePersistedWaitpoint(ctx, id, { approved: decision === 'approved', decision, note, previous: source.waitpoint.input });
                        await recordWorkflowAudit(decision === 'approved' ? 'waitpoint.approved' : 'waitpoint.rejected', {
                            type: 'waitpoint', id: source.id, name: source.name,
                        }, {
                            ...(source.workflowId ? { workflowId: source.workflowId } : {}),
                            continuationRunId: run.id,
                        });
                        return sendJson(response, 200, { ok: run.status === 'ok' || run.status === 'handled' || run.status === 'waiting', run: sanitizeRun(run) });
                    }
                    if (body?.action === 'delete') {
                        const id = String(body.id ?? '');
                        const run = loadRuns().find((candidate) => candidate.id === id);
                        if (!run)
                            return sendJson(response, 404, { error: '运行记录不存在' });
                        if (activeRuns.has(id))
                            return sendJson(response, 409, { error: '运行仍在执行，无法删除' });
                        saveRuns(loadRuns().filter((candidate) => candidate.id !== id));
                        rescheduleWaitpoints(ctx);
                        return sendJson(response, 200, { ok: true });
                    }
                    if (body?.action !== 'save' || body.run === null || typeof body.run !== 'object') {
                        return sendJson(response, 400, { error: 'run record is required' });
                    }
                    const incoming = body.run;
                    if (!incoming.id || !incoming.name || !incoming.startedAt || !Array.isArray(incoming.nodes)) {
                        return sendJson(response, 400, { error: 'invalid run record' });
                    }
                    const existingRun = loadRuns().find((candidate) => candidate.id === incoming.id);
                    if (existingRun?.status === 'waiting' && !existingRun.resumedByRunId)
                        return sendJson(response, 409, { error: '等待运行由宿主持久状态机管理' });
                    const run = {
                        id: String(incoming.id),
                        workflowId: incoming.workflowId ? String(incoming.workflowId) : undefined,
                        scheduleId: incoming.scheduleId ? String(incoming.scheduleId) : undefined,
                        name: String(incoming.name),
                        startedAt: String(incoming.startedAt),
                        completedAt: incoming.completedAt ? String(incoming.completedAt) : undefined,
                        nodeCount: Number(incoming.nodeCount) || incoming.nodes.length,
                        status: ['running', 'handled', 'error', 'cancelled', 'interrupted'].includes(String(incoming.status))
                            ? incoming.status
                            : 'ok',
                        failed: Number(incoming.failed) || 0,
                        handledErrors: Number(incoming.handledErrors) || 0,
                        value: incoming.value,
                        nodes: incoming.nodes,
                        checkpoint: incoming.checkpoint,
                        snapshot: incoming.snapshot,
                        resumable: Boolean(incoming.resumable),
                        resumedFromRunId: incoming.resumedFromRunId,
                        resumedByRunId: incoming.resumedByRunId,
                        parentRunId: incoming.parentRunId,
                        parentNodeId: incoming.parentNodeId,
                        rootRunId: incoming.rootRunId,
                        depth: Number.isInteger(incoming.depth) ? incoming.depth : undefined,
                        subworkflowSnapshots: incoming.subworkflowSnapshots,
                    };
                    saveRun(run);
                    sendJson(response, 200, { ok: true, run: sanitizeRun(run) });
                }
                catch (err) {
                    sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
                }
            },
        }));
        const pollingStates = releaseOrphanedPollingClaims(loadPollingTriggers());
        const activeWorkflows = loadWorkflows().filter((workflow) => workflow.status === 'enabled');
        let syncedPollingStates = pollingStates;
        const variables = resolveProjectVariables(projectVariableDataDir());
        for (const workflow of activeWorkflows)
            syncedPollingStates = syncPollingTriggerStates(syncedPollingStates, workflow.id, executionDocument(workflow), Date.now(), variables);
        savePollingTriggers(syncedPollingStates.filter((state) => activeWorkflows.some((workflow) => workflow.id === state.workflowId)));
        // Arm the single next-fire schedulers; stop them on unload.
        rescheduleScheduler(ctx);
        rescheduleWaitpoints(ctx);
        reschedulePollingTriggers(ctx);
        void drainQueuedWorkflowRuns(ctx).catch((error) => console.error(`[dsh-node-flow] queued workflow recovery failed: ${error instanceof Error ? error.message : String(error)}`));
        void reconcileCompletedChildRuns(ctx).catch((error) => console.error(`[dsh-node-flow] child workflow recovery failed: ${error instanceof Error ? error.message : String(error)}`));
        return () => {
            if (scheduleTimer)
                clearTimeout(scheduleTimer);
            if (waitpointTimer)
                clearTimeout(waitpointTimer);
            if (pollingTriggerTimer)
                clearTimeout(pollingTriggerTimer);
            for (const controller of activeRuns.values())
                controller.abort(new Error('插件已卸载'));
            for (const controller of pendingRootRuns.values())
                controller.abort(new Error('插件已卸载'));
            for (const active of activePollingTriggers.values())
                active.controller.abort(new Error('插件已卸载'));
            activePollingTriggers.clear();
            pendingOAuthAuthorizations.clear();
            for (const dispose of disposers.splice(0))
                dispose();
        };
    });
}

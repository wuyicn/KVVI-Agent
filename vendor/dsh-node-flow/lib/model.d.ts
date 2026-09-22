/**
 * Workflow data model for dsh-node-flow.
 *
 * The model is deliberately transport-agnostic: nodes/edges serialise to a
 * plain JSON workflow that can be handed to DSH's `ctx.workflows` service, so
 * the canvas is only ever a *view* over a DSH-native workflow spec.
 *
 * @module model
 */
import type { Node, Edge } from '@xyflow/react';
/** Node kinds the canvas understands. */
export type WorkflowNodeType = 'trigger' | 'webhook' | 'schedule' | 'connector-trigger' | 'agent' | 'call-workflow' | 'connector' | 'data-store' | 'wait' | 'if' | 'switch' | 'loop' | 'while' | 'code' | 'http' | 'output' | 'note';
/** Outcome of the last code-node execution, shown in the inspector. */
export type CodeRunOutcome = {
    /** The input this node received from the upstream flow (the `dsh.input()` value). */
    input?: string;
    /** Text the program emitted (console.*), in order. */
    logs: string[];
    /** The program's completion value (top-level `return`), when present. */
    value?: unknown;
    /** Failure message, when the run did not complete successfully. */
    error?: string;
    /** True when this failed node entered an explicit error branch. */
    errorHandled?: boolean;
    /** Local wall-clock time the run finished (or was marked running). */
    at: string;
    /** Elapsed milliseconds for the node's run (best-effort client timing). */
    duration?: number;
    /** Number of attempts used by the node, including the first attempt. */
    attempts?: number;
    /** Persisted child run created by a Call Workflow node. */
    childRunId?: string;
    /** True while a run is in flight. */
    running?: boolean;
    /** True when the persisted workflow paused at this node. */
    waiting?: boolean;
    /** True when a manual debugger paused immediately before this node. */
    debugPaused?: boolean;
};
/** Payload carried by each node — the part that maps to DSH workflow steps. */
export type WorkflowNodeData = {
    /** Node kind. */
    kind: WorkflowNodeType;
    /** User-facing label. */
    label: string;
    /** Trigger input text (kind === 'trigger'), flows to the next node. */
    text?: string;
    /** Cron schedule (kind === 'trigger'), e.g. "30 7 * * *" — host runs the flow on this. */
    cron?: string;
    /** IANA timezone for the cron schedule (kind === 'trigger'); defaults to system/local. */
    timezone?: string;
    /** Prompt for the sub-agent. */
    prompt?: string;
    /** Referenced workflow id (kind === 'call-workflow'). */
    workflowId?: string;
    /** JSON/text template passed to the referenced workflow. */
    inputTemplate?: string;
    /** Registered connector id (kind === 'connector'). */
    connectorId?: string;
    /** Exact registered connector version used by actions and polling triggers. */
    connectorVersion?: number;
    /** Registered connector action id (kind === 'connector'). */
    connectorAction?: string;
    /** Connector field templates keyed by the registered field id. */
    connectorParams?: Record<string, string>;
    /** Host-persisted ordinary state namespace (kind === 'data-store'). */
    storeNamespace?: string;
    /** Data Store operation: get, set, delete, or list. */
    storeOperation?: DataStoreOperation;
    /** Key template used by get, set, and delete. */
    storeKey?: string;
    /** Value template used by set. */
    storeValue?: string;
    /** Optional key prefix used by list. */
    storePrefix?: string;
    /** Registered polling trigger id (kind === 'connector-trigger'). */
    connectorTrigger?: string;
    /** Polling interval in seconds for a connector trigger. */
    pollInterval?: string;
    /** Waitpoint mode: delay, callback, or approval. */
    waitMode?: string;
    /** Delay amount for a delay waitpoint. */
    waitAmount?: string;
    /** Delay unit: seconds, minutes, hours, or days. */
    waitUnit?: string;
    /** Optional maximum wait duration for callback and approval waitpoints. */
    waitTimeout?: string;
    /** Template used when a waitpoint expires. */
    waitTimeoutValue?: string;
    /** HTTP method used by an HTTP request or accepted by a webhook trigger. */
    httpMethod?: string;
    /** URL template for an HTTP request. */
    url?: string;
    /** JSON object containing request headers. */
    headers?: string;
    /** Request body template. */
    body?: string;
    /** Server-side credential reference; secret material is never stored here. */
    credentialId?: string;
    /** HTTP response decoding mode. */
    responseMode?: string;
    /** Treat non-2xx HTTP responses as node failures. */
    failOnHttpError?: boolean;
    /** Unpredictable token used to authenticate one webhook trigger. */
    webhookToken?: string;
    /** Header carrying an HMAC-SHA256 signature for an authenticated webhook. */
    webhookSignatureHeader?: string;
    webhookIdempotencyHeader?: string;
    /** Retention window for completed webhook idempotency keys, in seconds. */
    webhookIdempotencyTtl?: string;
    /** Successful webhook response mode: summary, output, or custom. */
    webhookResponseMode?: string;
    /** HTTP status returned by a successful custom webhook response. */
    webhookResponseStatus?: string;
    /** JSON object containing custom webhook response headers. */
    webhookResponseHeaders?: string;
    /** Template used as the successful custom webhook response body. */
    webhookResponseBody?: string;
    /** Selected model route for the sub-agent (kind === 'agent'); stored as
     *  `"<provider>|<modelId>"`, empty means inherit the parent agent's model. */
    model?: string;
    /** Condition expression (kind === 'if' | 'switch' | 'while'). */
    condition?: string;
    /** Comma-separated case values (kind === 'switch'); each maps to a source handle. */
    cases?: string;
    /** Loop mode (kind === 'loop'): 'items' (iterate over an array) or 'count' (repeat N times). */
    mode?: string;
    /** Expression producing the array to iterate over (kind === 'loop' && mode === 'items'). */
    itemsExpr?: string;
    /** Repeat count (kind === 'loop' && mode === 'count'); parsed as an integer. */
    count?: string;
    /** Hard iteration cap for loop / while; parsed as an integer, defaults to 100. */
    maxIters?: string;
    /** Collect every iteration's result into an array delivered to `done`. */
    collect?: boolean;
    /** Code source (kind === 'code'). */
    code?: string;
    /** Code language (kind === 'code'); defaults to 'typescript'. */
    language?: string;
    /** Per-node runtime timeout in seconds (kind === 'code' | 'agent'); the host
     *  aborts the run past this and the node is recorded as a failure. */
    timeout?: string;
    /** Failure behavior for executable nodes. stop (default) cuts the branch,
     *  continue keeps going with an empty value, and route invokes explicit
     *  error output edges with a redacted error event. */
    onError?: WorkflowErrorBehavior;
    /** Number of retries after the first failed attempt (0-10). */
    retryCount?: string;
    /** Delay before the first retry, in seconds. */
    retryDelay?: string;
    /** Retry delay strategy: fixed or exponential. */
    retryBackoff?: string;
    /** Pause a manual debug run immediately before this node executes. */
    breakpoint?: boolean;
    /** Last execution outcome (kind === 'code'), set after a run. */
    lastRun?: CodeRunOutcome;
    /** Output template / summary (kind === 'output'). */
    template?: string;
    /** Free-form notes. */
    notes?: string;
};
/** A canvas node with our typed data payload. */
export type WorkflowNode = Node<WorkflowNodeData>;
/** How an executable node responds after its retries are exhausted. */
export type WorkflowErrorBehavior = 'stop' | 'continue' | 'route';
export type DataStoreOperation = 'get' | 'set' | 'delete' | 'list';
/** Safe payload passed into an explicit node error branch. It intentionally
 * contains no upstream input, response body, credential material, or stack. */
export type WorkflowErrorEvent = {
    type: 'workflow-node-error';
    error: {
        message: string;
        nodeId: string;
        nodeLabel: string;
        nodeKind: WorkflowNodeType;
        attempts: number;
        occurredAt: string;
    };
};
/** A canvas edge, optionally carrying a branch label. An error source handle
 * is reserved for an executable node's explicit error branch. */
export type WorkflowEdge = Edge<{
    label?: string;
}>;
/** The serialisable workflow document the canvas produces. */
export type WorkflowDocument = {
    /** Spec version for forward compat. */
    version: 1;
    name: string;
    description?: string;
    /** Root-run concurrency policy captured with this draft or published snapshot. */
    concurrency?: WorkflowConcurrency;
    /** Optional wall-clock and graph-step budgets for one execution. */
    executionLimits?: WorkflowExecutionLimits;
    /** Typed input fields expected when another workflow calls this workflow. */
    inputs?: WorkflowContractField[];
    /** Typed fields promised by this workflow's final result. */
    outputs?: WorkflowContractField[];
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
};
/** How root workflow triggers behave when the configured run limit is full. */
export type WorkflowConcurrencyMode = 'parallel' | 'skip' | 'queue';
/** Per-workflow root-run policy. `parallel` intentionally preserves legacy unlimited execution. */
export type WorkflowConcurrency = {
    mode?: WorkflowConcurrencyMode;
    maxConcurrent?: number;
    maxQueue?: number;
};
/** Optional per-run execution budgets captured by drafts and published snapshots. */
export type WorkflowExecutionLimits = {
    /** Maximum wall-clock time for one active execution, in seconds. */
    maxDurationSec?: number;
    /** Maximum graph-node visits, including loop iterations. */
    maxSteps?: number;
};
export type WorkflowValueType = 'any' | 'string' | 'number' | 'boolean' | 'object' | 'array';
export type WorkflowContractField = {
    name: string;
    label?: string;
    type: WorkflowValueType;
    required?: boolean;
    description?: string;
};
export type WorkflowStatus = 'enabled' | 'disabled';
export type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'oauth2' | 'webhook-secret';
export type CredentialHealth = 'untested' | 'authorizing' | 'connected' | 'expiring' | 'expired' | 'error';
export type OAuth2ClientAuth = 'body' | 'basic' | 'none';
export type CredentialSummary = {
    id: string;
    name: string;
    kind: CredentialKind;
    headerName?: string;
    testUrl?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    scopes?: string;
    clientAuth?: OAuth2ClientAuth;
    usePkce?: boolean;
    extraAuthParams?: string;
    extraTokenParams?: string;
    status?: CredentialHealth;
    statusMessage?: string;
    lastCheckedAt?: string;
    authorizedAt?: string;
    expiresAt?: string;
    createdAt: string;
    updatedAt: string;
};
export type ProjectVariableKind = 'plain' | 'secret';
export type ProjectVariableSummary = {
    id: string;
    name: string;
    kind: ProjectVariableKind;
    description?: string;
    value?: string;
    createdAt: string;
    updatedAt: string;
};
export type ProjectVariableReference = {
    workflowId: string;
    workflowName: string;
    nodeId: string;
    nodeLabel: string;
    scope: 'draft' | 'published';
};
/** A flat control-plane grouping for workflows. It never affects execution. */
export type WorkflowFolder = {
    id: string;
    name: string;
    /** Monotonic folder record version used for rename/delete conflicts. */
    revision: number;
    createdAt: string;
    updatedAt: string;
};
export type SavedWorkflow = {
    id: string;
    name: string;
    description?: string;
    /** Optional control-plane folder. Draft and published documents remain unchanged. */
    folderId?: string;
    status: WorkflowStatus;
    /** Monotonic record version used for optimistic concurrency control. */
    revision: number;
    /** Monotonic version of the editable draft document. */
    draftRevision: number;
    /** Draft version currently deployed to schedules, when published. */
    publishedRevision?: number;
    publishedAt?: string;
    /** Immutable execution snapshot captured by the latest publish action. */
    publishedDoc?: WorkflowDocument;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
    doc: WorkflowDocument;
};
export type WorkflowVersionKind = 'created' | 'draft' | 'published' | 'disabled' | 'restored' | 'restored-published' | 'imported';
export type WorkflowVersion = {
    id: string;
    workflowId: string;
    revision: number;
    draftRevision: number;
    publishedRevision?: number;
    kind: WorkflowVersionKind;
    createdAt: string;
    sourceVersionId?: string;
    name: string;
    description?: string;
    status: WorkflowStatus;
    doc: WorkflowDocument;
    publishedAt?: string;
    publishedDoc?: WorkflowDocument;
};
export type WorkflowVersionNodeRef = {
    id: string;
    kind: WorkflowNodeType;
    label: string;
};
export type WorkflowVersionNodeChange = WorkflowVersionNodeRef & {
    fields: string[];
};
export type WorkflowVersionEdgeRef = {
    id: string;
    source: string;
    target: string;
};
export type WorkflowVersionDiff = {
    nameChanged: boolean;
    descriptionChanged: boolean;
    inputsChanged: boolean;
    outputsChanged: boolean;
    concurrencyChanged: boolean;
    executionLimitsChanged: boolean;
    addedNodes: WorkflowVersionNodeRef[];
    removedNodes: WorkflowVersionNodeRef[];
    changedNodes: WorkflowVersionNodeChange[];
    addedEdges: WorkflowVersionEdgeRef[];
    removedEdges: WorkflowVersionEdgeRef[];
    changedEdges: WorkflowVersionEdgeRef[];
};
export type WorkflowRunNode = {
    id: string;
    kind: string;
    status: 'running' | 'ok' | 'error' | 'skipped';
    input?: unknown;
    output?: unknown;
    logs?: string[];
    error?: string;
    /** The node failed but its explicit error branch was invoked. */
    errorHandled?: boolean;
    /** The manual debugger paused immediately before this node executed. */
    debugPaused?: boolean;
    ms: number;
    attempts?: number;
    childRunId?: string;
};
export type WorkflowRunStatus = 'queued' | 'running' | 'waiting' | 'ok' | 'handled' | 'error' | 'cancelled' | 'interrupted' | 'skipped';
/** Entry point that created a persisted root run. */
export type WorkflowRunTrigger = 'manual' | 'debug' | 'schedule' | 'webhook' | 'connector-trigger' | 'resume' | 'replay';
/** Payload retained only while a root run waits in the persistent concurrency queue. */
export type WorkflowQueuedRun = {
    trigger: WorkflowRunTrigger;
    input?: unknown;
    startNodeId?: string;
    scheduleId?: string;
    /** Manual draft runs may execute even when their workflow is not published. */
    requiresEnabled?: boolean;
    /** Recovery metadata retained while a failed root run waits for a slot. */
    resumedFromRunId?: string;
    resumeAfterNodeId?: string;
    /** Continue a debug run by executing this paused node. */
    skipBreakpointNodeId?: string;
    /** Stops again immediately after one node has completed. */
    debugStepAfterNodeId?: string;
    /** Idempotency record claimed by an inbound Webhook trigger. */
    webhookIdempotencyId?: string;
    priorNodes?: WorkflowRunNode[];
    rootRunId?: string;
    subworkflowSnapshots?: Record<string, WorkflowExecutionSnapshot>;
    executionLimits?: WorkflowExecutionLimits;
};
export type WorkflowRunCheckpoint = {
    nodeId: string;
    input: string;
    updatedAt: string;
};
export type WorkflowWaitpoint = {
    nodeId: string;
    mode: 'delay' | 'callback' | 'approval' | 'debug' | 'child';
    createdAt: string;
    input: string;
    resumeAt?: string;
    expiresAt?: string;
    timeoutValue?: string;
    tokenHash?: string;
    /** `breakpoint` pauses before execution; `step` pauses after one linear node. */
    debugReason?: 'breakpoint' | 'step';
    /** The node that completed before a `step` pause, if any. */
    previousNodeId?: string;
    /** Set when this wait belongs to a persisted child workflow run. */
    childRunId?: string;
    /** Parent run and call node resumed after the child finishes. */
    parentRunId?: string;
    parentNodeId?: string;
};
export type WorkflowRunRecord = {
    id: string;
    workflowId?: string;
    scheduleId?: string;
    name: string;
    /** Time at which an item entered the persistent concurrency queue. */
    queuedAt?: string;
    startedAt: string;
    completedAt?: string;
    nodeCount: number;
    status: WorkflowRunStatus;
    trigger?: WorkflowRunTrigger;
    failed: number;
    /** True when the configured workflow wall-clock budget aborted this run. */
    timedOut?: boolean;
    /** Which execution budget ended the run, when a budget was reached. */
    limitReason?: 'duration' | 'steps';
    /** Number of failed nodes whose explicit error branch was invoked. */
    handledErrors?: number;
    value?: unknown;
    nodes: WorkflowRunNode[];
    checkpoint?: WorkflowRunCheckpoint;
    waitpoint?: WorkflowWaitpoint;
    /** Present only while status is queued; removed when execution starts. */
    queue?: WorkflowQueuedRun;
    /** Why a run was skipped before execution, when status is skipped. */
    skipReason?: string;
    snapshot?: WorkflowDocument;
    resumable?: boolean;
    resumedFromRunId?: string;
    resumedByRunId?: string;
    parentRunId?: string;
    parentNodeId?: string;
    rootRunId?: string;
    depth?: number;
    /** Hash-keyed idempotency record used by an inbound Webhook. */
    webhookIdempotencyId?: string;
    /** Workflow stack used to validate nested calls after a persisted wait. */
    workflowStack?: string[];
    subworkflowSnapshots?: Record<string, WorkflowExecutionSnapshot>;
    /** Root input retained only when the host determined it is safe to replay. */
    replayInput?: unknown;
    /** Distinguishes an intentionally empty input from one that cannot be retained. */
    replayInputAvailable?: boolean;
    /** Source run for an explicit full replay; recovery uses resumedFromRunId instead. */
    replayedFromRunId?: string;
};
/** Lightweight run-history item returned by the list endpoint. */
export type WorkflowRunSummary = Pick<WorkflowRunRecord, 'id' | 'workflowId' | 'scheduleId' | 'name' | 'queuedAt' | 'startedAt' | 'completedAt' | 'nodeCount' | 'status' | 'trigger' | 'failed' | 'resumable' | 'resumedFromRunId' | 'timedOut' | 'limitReason' | 'handledErrors' | 'resumedByRunId' | 'replayedFromRunId' | 'parentRunId' | 'parentNodeId' | 'rootRunId' | 'depth' | 'skipReason'> & {
    waitpoint?: Pick<WorkflowWaitpoint, 'nodeId' | 'mode' | 'createdAt' | 'resumeAt' | 'expiresAt' | 'debugReason' | 'previousNodeId' | 'childRunId' | 'parentRunId' | 'parentNodeId'>;
    replayable?: boolean;
};
/** Control-plane action retained in the local workflow audit log. */
export type WorkflowAuditAction = 'workflow.created' | 'workflow.moved' | 'workflow.published' | 'workflow.disabled' | 'workflow.deleted' | 'workflow.restored' | 'credential.created' | 'credential.updated' | 'credential.tested' | 'credential.authorization-started' | 'credential.authorized' | 'credential.authorization-cancelled' | 'credential.deleted' | 'variable.created' | 'variable.updated' | 'variable.deleted' | 'folder.created' | 'folder.renamed' | 'folder.deleted' | 'run.manual-started' | 'run.debug-started' | 'run.debug-stepped' | 'run.debug-continued' | 'run.debug-cancelled' | 'run.cancelled' | 'run.resumed' | 'run.replayed' | 'waitpoint.approved' | 'waitpoint.rejected';
export type WorkflowAuditTargetType = 'workflow' | 'credential' | 'variable' | 'folder' | 'run' | 'waitpoint';
/** A bounded, append-only, redacted control-plane audit event. */
export type WorkflowAuditEvent = {
    id: string;
    at: string;
    actor: 'local-user' | 'system';
    action: WorkflowAuditAction;
    target: {
        type: WorkflowAuditTargetType;
        id: string;
        name?: string;
    };
    details?: Record<string, string | number | boolean>;
};
export type WorkflowExecutionSnapshot = {
    workflowId: string;
    name: string;
    publishedRevision?: number;
    doc: WorkflowDocument;
};
/** Default dimensions per node kind (px). */
export declare const NODE_SIZE: Record<WorkflowNodeType, {
    width: number;
    height: number;
}>;
export declare function createNode(kind: WorkflowNodeType, label: string, position: {
    x: number;
    y: number;
}): WorkflowNode;
export declare function createWebhookToken(): string;
export declare function refreshWebhookTokens(document: WorkflowDocument): WorkflowDocument;
export declare function createBlankWorkflowDocument(name?: string): WorkflowDocument;
/**
 * Flatten a canvas workflow into an ordered step list — the bridge to DSH's
 * `ctx.workflows`. Breadth-first from every trigger; conditions become
 * conditional steps with `then`/`else` targets derived from edges.
 */
export declare function toStepList(doc: WorkflowDocument): unknown[];
/**
 * A ready-made "fetch weather → agent organizes → output" workflow document,
 * loaded by the toolbar's "加载天气示例" button.
 */
export declare function buildWeatherExample(): WorkflowDocument;
export declare function buildNewsExample(): WorkflowDocument;
/** 通用条件分流：code 生成一个数 → If >10 → true/false 两个输出。 */
export declare function buildBasicIfExample(): WorkflowDocument;
/** AI 问答·判断：agent 回答后，If 判断回答是否提到 "AI" 走不同分支。 */
export declare function buildQaIfExample(): WorkflowDocument;
/** 日常 Switch：按当前时段（早上/下午/晚上）路由到不同问候。 */
export declare function buildDailySwitchExample(): WorkflowDocument;
/** Loop 示例：遍历一批热点，按是否含 "AI" 分流到 agent 深入或直接跳过，并收集每轮结果。 */
export declare function buildLoopExample(): WorkflowDocument;
/** While 示例：用字符串状态（待处理→处理中→完成）做判断，直到状态变为"完成"才停。 */
export declare function buildWhileExample(): WorkflowDocument;

/**
 * Workflow data model for dsh-node-flow.
 *
 * The model is deliberately transport-agnostic: nodes/edges serialise to a
 * plain JSON workflow that can be handed to DSH's `ctx.workflows` service, so
 * the canvas is only ever a *view* over a DSH-native workflow spec.
 *
 * @module model
 */

import type { Node, Edge } from '@xyflow/react'

/** Node kinds the canvas understands. */
export type WorkflowNodeType =
  | 'trigger' // entry point / prompt trigger
  | 'webhook' // external HTTP trigger using a per-node token
  | 'schedule' // cron-triggered entry point (host schedules the flow)
  | 'connector-trigger' // poll a declared connector trigger for new events
  | 'agent' // delegate to a sub-agent
  | 'call-workflow' // execute another published workflow snapshot
  | 'connector' // execute a declared action from the built-in connector catalog
  | 'data-store' // persist ordinary workflow state on the DSH host
  | 'wait' // persist the run until a delay, callback, or approval resumes it
  | 'if' // boolean branch: routes to "true" or "false" source handle
  | 'switch' // value branch: routes to a matching case source handle (or "default")
  | 'loop' // repeat a body over an array or N times (iterate / done / back)
  | 'while' // repeat a body while a condition holds (iterate / done / back)
  | 'code' // execute code on the DSH host (ctx.codeRuntime)
  | 'http' // make an HTTP request from the DSH host
  | 'output' // terminal result
  | 'note' // a free annotation (no connection handles)

/** Outcome of the last code-node execution, shown in the inspector. */
export type CodeRunOutcome = {
  /** The input this node received from the upstream flow (the `dsh.input()` value). */
  input?: string
  /** Text the program emitted (console.*), in order. */
  logs: string[]
  /** The program's completion value (top-level `return`), when present. */
  value?: unknown
  /** Failure message, when the run did not complete successfully. */
  error?: string
  /** True when this failed node entered an explicit error branch. */
  errorHandled?: boolean
  /** Local wall-clock time the run finished (or was marked running). */
  at: string
  /** Elapsed milliseconds for the node's run (best-effort client timing). */
  duration?: number
  /** Number of attempts used by the node, including the first attempt. */
  attempts?: number
  /** Persisted child run created by a Call Workflow node. */
  childRunId?: string
  /** True while a run is in flight. */
  running?: boolean
  /** True when the persisted workflow paused at this node. */
  waiting?: boolean
  /** True when a manual debugger paused immediately before this node. */
  debugPaused?: boolean
}

/** Payload carried by each node — the part that maps to DSH workflow steps. */
export type WorkflowNodeData = {
  /** Node kind. */
  kind: WorkflowNodeType
  /** User-facing label. */
  label: string
  /** Trigger input text (kind === 'trigger'), flows to the next node. */
  text?: string
  /** Cron schedule (kind === 'trigger'), e.g. "30 7 * * *" — host runs the flow on this. */
  cron?: string
  /** IANA timezone for the cron schedule (kind === 'trigger'); defaults to system/local. */
  timezone?: string
  /** Prompt for the sub-agent. */
  prompt?: string
  /** Referenced workflow id (kind === 'call-workflow'). */
  workflowId?: string
  /** JSON/text template passed to the referenced workflow. */
  inputTemplate?: string
  /** Registered connector id (kind === 'connector'). */
  connectorId?: string
  /** Exact registered connector version used by actions and polling triggers. */
  connectorVersion?: number
  /** Registered connector action id (kind === 'connector'). */
  connectorAction?: string
  /** Connector field templates keyed by the registered field id. */
  connectorParams?: Record<string, string>
  /** Host-persisted ordinary state namespace (kind === 'data-store'). */
  storeNamespace?: string
  /** Data Store operation: get, set, delete, or list. */
  storeOperation?: DataStoreOperation
  /** Key template used by get, set, and delete. */
  storeKey?: string
  /** Value template used by set. */
  storeValue?: string
  /** Optional key prefix used by list. */
  storePrefix?: string
  /** Registered polling trigger id (kind === 'connector-trigger'). */
  connectorTrigger?: string
  /** Polling interval in seconds for a connector trigger. */
  pollInterval?: string
  /** Waitpoint mode: delay, callback, or approval. */
  waitMode?: string
  /** Delay amount for a delay waitpoint. */
  waitAmount?: string
  /** Delay unit: seconds, minutes, hours, or days. */
  waitUnit?: string
  /** Optional maximum wait duration for callback and approval waitpoints. */
  waitTimeout?: string
  /** Template used when a waitpoint expires. */
  waitTimeoutValue?: string
  /** HTTP method used by an HTTP request or accepted by a webhook trigger. */
  httpMethod?: string
  /** URL template for an HTTP request. */
  url?: string
  /** JSON object containing request headers. */
  headers?: string
  /** Request body template. */
  body?: string
  /** Server-side credential reference; secret material is never stored here. */
  credentialId?: string
  /** HTTP response decoding mode. */
  responseMode?: string
  /** Treat non-2xx HTTP responses as node failures. */
  failOnHttpError?: boolean
  /** Unpredictable token used to authenticate one webhook trigger. */
  webhookToken?: string
  /** Header carrying an HMAC-SHA256 signature for an authenticated webhook. */
  webhookSignatureHeader?: string
  webhookIdempotencyHeader?: string
  /** Retention window for completed webhook idempotency keys, in seconds. */
  webhookIdempotencyTtl?: string
  /** Successful webhook response mode: summary, output, or custom. */
  webhookResponseMode?: string
  /** HTTP status returned by a successful custom webhook response. */
  webhookResponseStatus?: string
  /** JSON object containing custom webhook response headers. */
  webhookResponseHeaders?: string
  /** Template used as the successful custom webhook response body. */
  webhookResponseBody?: string
  /** Selected model route for the sub-agent (kind === 'agent'); stored as
   *  `"<provider>|<modelId>"`, empty means inherit the parent agent's model. */
  model?: string
  /** Condition expression (kind === 'if' | 'switch' | 'while'). */
  condition?: string
  /** Comma-separated case values (kind === 'switch'); each maps to a source handle. */
  cases?: string
  /** Loop mode (kind === 'loop'): 'items' (iterate over an array) or 'count' (repeat N times). */
  mode?: string
  /** Expression producing the array to iterate over (kind === 'loop' && mode === 'items'). */
  itemsExpr?: string
  /** Repeat count (kind === 'loop' && mode === 'count'); parsed as an integer. */
  count?: string
  /** Hard iteration cap for loop / while; parsed as an integer, defaults to 100. */
  maxIters?: string
  /** Collect every iteration's result into an array delivered to `done`. */
  collect?: boolean
  /** Code source (kind === 'code'). */
  code?: string
  /** Code language (kind === 'code'); defaults to 'typescript'. */
  language?: string
  /** Per-node runtime timeout in seconds (kind === 'code' | 'agent'); the host
   *  aborts the run past this and the node is recorded as a failure. */
  timeout?: string
  /** Failure behavior for executable nodes. stop (default) cuts the branch,
   *  continue keeps going with an empty value, and route invokes explicit
   *  error output edges with a redacted error event. */
  onError?: WorkflowErrorBehavior
  /** Number of retries after the first failed attempt (0-10). */
  retryCount?: string
  /** Delay before the first retry, in seconds. */
  retryDelay?: string
  /** Retry delay strategy: fixed or exponential. */
  retryBackoff?: string
  /** Pause a manual debug run immediately before this node executes. */
  breakpoint?: boolean
  /** Last execution outcome (kind === 'code'), set after a run. */
  lastRun?: CodeRunOutcome
  /** Output template / summary (kind === 'output'). */
  template?: string
  /** Free-form notes. */
  notes?: string
}

/** A canvas node with our typed data payload. */
export type WorkflowNode = Node<WorkflowNodeData>

/** How an executable node responds after its retries are exhausted. */
export type WorkflowErrorBehavior = 'stop' | 'continue' | 'route'

export type DataStoreOperation = 'get' | 'set' | 'delete' | 'list'

/** Safe payload passed into an explicit node error branch. It intentionally
 * contains no upstream input, response body, credential material, or stack. */
export type WorkflowErrorEvent = {
  type: 'workflow-node-error'
  error: {
    message: string
    nodeId: string
    nodeLabel: string
    nodeKind: WorkflowNodeType
    attempts: number
    occurredAt: string
  }
}

/** A canvas edge, optionally carrying a branch label. An error source handle
 * is reserved for an executable node's explicit error branch. */
export type WorkflowEdge = Edge<{ label?: string }>

/** The serialisable workflow document the canvas produces. */
export type WorkflowDocument = {
  /** Spec version for forward compat. */
  version: 1
  name: string
  description?: string
  /** Root-run concurrency policy captured with this draft or published snapshot. */
  concurrency?: WorkflowConcurrency
  /** Optional wall-clock and graph-step budgets for one execution. */
  executionLimits?: WorkflowExecutionLimits
  /** Typed input fields expected when another workflow calls this workflow. */
  inputs?: WorkflowContractField[]
  /** Typed fields promised by this workflow's final result. */
  outputs?: WorkflowContractField[]
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** How root workflow triggers behave when the configured run limit is full. */
export type WorkflowConcurrencyMode = 'parallel' | 'skip' | 'queue'

/** Per-workflow root-run policy. `parallel` intentionally preserves legacy unlimited execution. */
export type WorkflowConcurrency = {
  mode?: WorkflowConcurrencyMode
  maxConcurrent?: number
  maxQueue?: number
}

/** Optional per-run execution budgets captured by drafts and published snapshots. */
export type WorkflowExecutionLimits = {
  /** Maximum wall-clock time for one active execution, in seconds. */
  maxDurationSec?: number
  /** Maximum graph-node visits, including loop iterations. */
  maxSteps?: number
}

export type WorkflowValueType = 'any' | 'string' | 'number' | 'boolean' | 'object' | 'array'

export type WorkflowContractField = {
  name: string
  label?: string
  type: WorkflowValueType
  required?: boolean
  description?: string
}

export type WorkflowStatus = 'enabled' | 'disabled'

export type CredentialKind = 'bearer' | 'api-key' | 'basic' | 'oauth2' | 'webhook-secret'

export type CredentialHealth = 'untested' | 'authorizing' | 'connected' | 'expiring' | 'expired' | 'error'

export type OAuth2ClientAuth = 'body' | 'basic' | 'none'

export type CredentialSummary = {
  id: string
  name: string
  kind: CredentialKind
  headerName?: string
  testUrl?: string
  authorizationUrl?: string
  tokenUrl?: string
  clientId?: string
  scopes?: string
  clientAuth?: OAuth2ClientAuth
  usePkce?: boolean
  extraAuthParams?: string
  extraTokenParams?: string
  status?: CredentialHealth
  statusMessage?: string
  lastCheckedAt?: string
  authorizedAt?: string
  expiresAt?: string
  createdAt: string
  updatedAt: string
}

export type ProjectVariableKind = 'plain' | 'secret'

export type ProjectVariableSummary = {
  id: string
  name: string
  kind: ProjectVariableKind
  description?: string
  value?: string
  createdAt: string
  updatedAt: string
}

export type ProjectVariableReference = {
  workflowId: string
  workflowName: string
  nodeId: string
  nodeLabel: string
  scope: 'draft' | 'published'
}

/** A flat control-plane grouping for workflows. It never affects execution. */
export type WorkflowFolder = {
  id: string
  name: string
  /** Monotonic folder record version used for rename/delete conflicts. */
  revision: number
  createdAt: string
  updatedAt: string
}

export type SavedWorkflow = {
  id: string
  name: string
  description?: string
  /** Optional control-plane folder. Draft and published documents remain unchanged. */
  folderId?: string
  status: WorkflowStatus
  /** Monotonic record version used for optimistic concurrency control. */
  revision: number
  /** Monotonic version of the editable draft document. */
  draftRevision: number
  /** Draft version currently deployed to schedules, when published. */
  publishedRevision?: number
  publishedAt?: string
  /** Immutable execution snapshot captured by the latest publish action. */
  publishedDoc?: WorkflowDocument
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  doc: WorkflowDocument
}

export type WorkflowVersionKind = 'created' | 'draft' | 'published' | 'disabled' | 'restored' | 'restored-published' | 'imported'

export type WorkflowVersion = {
  id: string
  workflowId: string
  revision: number
  draftRevision: number
  publishedRevision?: number
  kind: WorkflowVersionKind
  createdAt: string
  sourceVersionId?: string
  name: string
  description?: string
  status: WorkflowStatus
  doc: WorkflowDocument
  publishedAt?: string
  publishedDoc?: WorkflowDocument
}

export type WorkflowVersionNodeRef = {
  id: string
  kind: WorkflowNodeType
  label: string
}

export type WorkflowVersionNodeChange = WorkflowVersionNodeRef & {
  fields: string[]
}

export type WorkflowVersionEdgeRef = {
  id: string
  source: string
  target: string
}

export type WorkflowVersionDiff = {
  nameChanged: boolean
  descriptionChanged: boolean
  inputsChanged: boolean
  outputsChanged: boolean
  concurrencyChanged: boolean
  executionLimitsChanged: boolean
  addedNodes: WorkflowVersionNodeRef[]
  removedNodes: WorkflowVersionNodeRef[]
  changedNodes: WorkflowVersionNodeChange[]
  addedEdges: WorkflowVersionEdgeRef[]
  removedEdges: WorkflowVersionEdgeRef[]
  changedEdges: WorkflowVersionEdgeRef[]
}

export type WorkflowRunNode = {
  id: string
  kind: string
  status: 'running' | 'ok' | 'error' | 'skipped'
  input?: unknown
  output?: unknown
  logs?: string[]
  error?: string
  /** The node failed but its explicit error branch was invoked. */
  errorHandled?: boolean
  /** The manual debugger paused immediately before this node executed. */
  debugPaused?: boolean
  ms: number
  attempts?: number
  childRunId?: string
}

export type WorkflowRunStatus = 'queued' | 'running' | 'waiting' | 'ok' | 'handled' | 'error' | 'cancelled' | 'interrupted' | 'skipped'

/** Entry point that created a persisted root run. */
export type WorkflowRunTrigger = 'manual' | 'debug' | 'schedule' | 'webhook' | 'connector-trigger' | 'resume' | 'replay'

/** Payload retained only while a root run waits in the persistent concurrency queue. */
export type WorkflowQueuedRun = {
  trigger: WorkflowRunTrigger
  input?: unknown
  startNodeId?: string
  scheduleId?: string
  /** Manual draft runs may execute even when their workflow is not published. */
  requiresEnabled?: boolean
  /** Recovery metadata retained while a failed root run waits for a slot. */
  resumedFromRunId?: string
  resumeAfterNodeId?: string
  /** Continue a debug run by executing this paused node. */
  skipBreakpointNodeId?: string
  /** Stops again immediately after one node has completed. */
  debugStepAfterNodeId?: string
  /** Idempotency record claimed by an inbound Webhook trigger. */
  webhookIdempotencyId?: string
  priorNodes?: WorkflowRunNode[]
  rootRunId?: string
  subworkflowSnapshots?: Record<string, WorkflowExecutionSnapshot>
  executionLimits?: WorkflowExecutionLimits
}

export type WorkflowRunCheckpoint = {
  nodeId: string
  input: string
  updatedAt: string
}

export type WorkflowWaitpoint = {
  nodeId: string
  mode: 'delay' | 'callback' | 'approval' | 'debug' | 'child'
  createdAt: string
  input: string
  resumeAt?: string
  expiresAt?: string
  timeoutValue?: string
  tokenHash?: string
  /** `breakpoint` pauses before execution; `step` pauses after one linear node. */
  debugReason?: 'breakpoint' | 'step'
  /** The node that completed before a `step` pause, if any. */
  previousNodeId?: string
  /** Set when this wait belongs to a persisted child workflow run. */
  childRunId?: string
  /** Parent run and call node resumed after the child finishes. */
  parentRunId?: string
  parentNodeId?: string
}

export type WorkflowRunRecord = {
  id: string
  workflowId?: string
  scheduleId?: string
  name: string
  /** Time at which an item entered the persistent concurrency queue. */
  queuedAt?: string
  startedAt: string
  completedAt?: string
  nodeCount: number
  status: WorkflowRunStatus
  trigger?: WorkflowRunTrigger
  failed: number
  /** True when the configured workflow wall-clock budget aborted this run. */
  timedOut?: boolean
  /** Which execution budget ended the run, when a budget was reached. */
  limitReason?: 'duration' | 'steps'
  /** Number of failed nodes whose explicit error branch was invoked. */
  handledErrors?: number
  value?: unknown
  nodes: WorkflowRunNode[]
  checkpoint?: WorkflowRunCheckpoint
  waitpoint?: WorkflowWaitpoint
  /** Present only while status is queued; removed when execution starts. */
  queue?: WorkflowQueuedRun
  /** Why a run was skipped before execution, when status is skipped. */
  skipReason?: string
  snapshot?: WorkflowDocument
  resumable?: boolean
  resumedFromRunId?: string
  resumedByRunId?: string
  parentRunId?: string
  parentNodeId?: string
  rootRunId?: string
  depth?: number
  /** Hash-keyed idempotency record used by an inbound Webhook. */
  webhookIdempotencyId?: string
  /** Workflow stack used to validate nested calls after a persisted wait. */
  workflowStack?: string[]
  subworkflowSnapshots?: Record<string, WorkflowExecutionSnapshot>
  /** Root input retained only when the host determined it is safe to replay. */
  replayInput?: unknown
  /** Distinguishes an intentionally empty input from one that cannot be retained. */
  replayInputAvailable?: boolean
  /** Source run for an explicit full replay; recovery uses resumedFromRunId instead. */
  replayedFromRunId?: string
}

/** Lightweight run-history item returned by the list endpoint. */
export type WorkflowRunSummary = Pick<WorkflowRunRecord,
  'id' | 'workflowId' | 'scheduleId' | 'name' | 'queuedAt' | 'startedAt' | 'completedAt'
  | 'nodeCount' | 'status' | 'trigger' | 'failed' | 'resumable' | 'resumedFromRunId'
  | 'timedOut' | 'limitReason'
  | 'handledErrors'
  | 'resumedByRunId' | 'replayedFromRunId' | 'parentRunId' | 'parentNodeId' | 'rootRunId'
  | 'depth' | 'skipReason'
> & {
  waitpoint?: Pick<WorkflowWaitpoint, 'nodeId' | 'mode' | 'createdAt' | 'resumeAt' | 'expiresAt' | 'debugReason' | 'previousNodeId' | 'childRunId' | 'parentRunId' | 'parentNodeId'>
  replayable?: boolean
}

/** Control-plane action retained in the local workflow audit log. */
export type WorkflowAuditAction =
  | 'workflow.created'
  | 'workflow.moved'
  | 'workflow.published'
  | 'workflow.disabled'
  | 'workflow.deleted'
  | 'workflow.restored'
  | 'credential.created'
  | 'credential.updated'
  | 'credential.tested'
  | 'credential.authorization-started'
  | 'credential.authorized'
  | 'credential.authorization-cancelled'
  | 'credential.deleted'
  | 'variable.created'
  | 'variable.updated'
  | 'variable.deleted'
  | 'folder.created'
  | 'folder.renamed'
  | 'folder.deleted'
  | 'run.manual-started'
  | 'run.debug-started'
  | 'run.debug-stepped'
  | 'run.debug-continued'
  | 'run.debug-cancelled'
  | 'run.cancelled'
  | 'run.resumed'
  | 'run.replayed'
  | 'waitpoint.approved'
  | 'waitpoint.rejected'

export type WorkflowAuditTargetType = 'workflow' | 'credential' | 'variable' | 'folder' | 'run' | 'waitpoint'

/** A bounded, append-only, redacted control-plane audit event. */
export type WorkflowAuditEvent = {
  id: string
  at: string
  actor: 'local-user' | 'system'
  action: WorkflowAuditAction
  target: {
    type: WorkflowAuditTargetType
    id: string
    name?: string
  }
  details?: Record<string, string | number | boolean>
}

export type WorkflowExecutionSnapshot = {
  workflowId: string
  name: string
  publishedRevision?: number
  doc: WorkflowDocument
}

/** Default dimensions per node kind (px). */
export const NODE_SIZE: Record<WorkflowNodeType, { width: number; height: number }> = {
  trigger: { width: 224, height: 76 },
  webhook: { width: 224, height: 82 },
  schedule: { width: 224, height: 76 },
  'connector-trigger': { width: 224, height: 82 },
  agent: { width: 224, height: 82 },
  'call-workflow': { width: 224, height: 82 },
  connector: { width: 224, height: 82 },
  'data-store': { width: 224, height: 82 },
  wait: { width: 224, height: 82 },
  if: { width: 224, height: 96 },
  switch: { width: 224, height: 124 },
  loop: { width: 224, height: 104 },
  while: { width: 224, height: 104 },
  code: { width: 224, height: 82 },
  http: { width: 224, height: 82 },
  output: { width: 224, height: 82 },
  note: { width: 240, height: 116 },
}

/** Fresh node factory with a stable id. */
let seq = 0
export function createNode(kind: WorkflowNodeType, label: string, position: { x: number; y: number }): WorkflowNode {
  const size = NODE_SIZE[kind]
  // Agent / code default to a 120s runtime timeout (user may clear it for "no limit").
  const data: WorkflowNodeData = kind === 'agent' || kind === 'code'
    ? { kind, label, timeout: '120' }
    : kind === 'call-workflow'
      ? { kind, label, inputTemplate: '{{result}}' }
    : kind === 'connector-trigger'
      ? { kind, label, pollInterval: '60' }
    : kind === 'connector'
      ? { kind, label, timeout: '30', failOnHttpError: true }
    : kind === 'data-store'
      ? { kind, label, storeNamespace: 'default', storeOperation: 'get', storeKey: '', storeValue: '{{result}}', storePrefix: '' }
    : kind === 'wait'
      ? { kind, label, waitMode: 'delay', waitAmount: '5', waitUnit: 'minutes' }
    : kind === 'http'
      ? { kind, label, httpMethod: 'GET', timeout: '30', responseMode: 'auto', failOnHttpError: true }
      : kind === 'webhook'
        ? { kind, label, httpMethod: 'ANY', webhookToken: createWebhookToken(), webhookResponseMode: 'summary' }
        : { kind, label }
  return {
    id: `${kind}-${++seq}-${Date.now().toString(36)}`,
    type: 'workflow',
    position,
    data,
    // React Flow uses this size to position the connection handles on the
    // node's edges; the node card sets the same size so handle and card agree.
    style: { width: size.width, height: size.height },
  }
}

export function createWebhookToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? uuid.replaceAll('-', '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

export function refreshWebhookTokens(document: WorkflowDocument): WorkflowDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => node.data.kind === 'webhook'
      ? { ...node, data: { ...node.data, webhookToken: createWebhookToken(), lastRun: undefined } }
      : node),
  }
}

export function createBlankWorkflowDocument(name = '未命名工作流'): WorkflowDocument {
  return {
    version: 1,
    name,
    nodes: [
      {
        id: `trigger-${Date.now().toString(36)}`,
        type: 'workflow',
        position: { x: 80, y: 200 },
        data: { kind: 'trigger', label: '手动触发' },
        style: { width: NODE_SIZE.trigger.width, height: NODE_SIZE.trigger.height },
      },
    ],
    edges: [],
  }
}

/**
 * Flatten a canvas workflow into an ordered step list — the bridge to DSH's
 * `ctx.workflows`. Breadth-first from every trigger; conditions become
 * conditional steps with `then`/`else` targets derived from edges.
 */
export function toStepList(doc: WorkflowDocument): unknown[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const out: unknown[] = []
  const visited = new Set<string>()

  const emit = (id: string, branch?: string): void => {
    if (visited.has(id) || !byId.has(id)) return
    visited.add(id)
    const n = byId.get(id)!
    const d = n.data
    const step: Record<string, unknown> = { id: n.id, kind: d.kind, label: d.label }
    if (d.kind === 'trigger') {
      step.text = d.text
    } else if (d.kind === 'webhook') {
      step.httpMethod = d.httpMethod
      step.webhookToken = d.webhookToken
      step.credentialId = d.credentialId
      step.webhookSignatureHeader = d.webhookSignatureHeader
      step.webhookIdempotencyHeader = d.webhookIdempotencyHeader
      step.webhookIdempotencyTtl = d.webhookIdempotencyTtl
      step.webhookResponseMode = d.webhookResponseMode
      step.webhookResponseStatus = d.webhookResponseStatus
      step.webhookResponseHeaders = d.webhookResponseHeaders
      step.webhookResponseBody = d.webhookResponseBody
    } else if (d.kind === 'schedule') {
      step.text = d.text
      step.cron = d.cron
      step.timezone = d.timezone
    } else if (d.kind === 'connector-trigger') {
      step.connectorId = d.connectorId
      step.connectorTrigger = d.connectorTrigger
      step.connectorParams = d.connectorParams
      step.credentialId = d.credentialId
      step.pollInterval = d.pollInterval
    } else if (d.kind === 'agent') {
      step.prompt = d.prompt
      if (d.model) step.model = d.model
      if (d.timeout) step.timeout = d.timeout
      step.onError = d.onError
    } else if (d.kind === 'call-workflow') {
      step.workflowId = d.workflowId
      step.inputTemplate = d.inputTemplate
      step.onError = d.onError
    } else if (d.kind === 'connector') {
      step.connectorId = d.connectorId
      step.connectorAction = d.connectorAction
      step.connectorParams = d.connectorParams
      step.credentialId = d.credentialId
      if (d.timeout) step.timeout = d.timeout
      step.onError = d.onError
    } else if (d.kind === 'data-store') {
      step.storeNamespace = d.storeNamespace
      step.storeOperation = d.storeOperation
      step.storeKey = d.storeKey
      step.storeValue = d.storeValue
      step.storePrefix = d.storePrefix
      step.onError = d.onError
    } else if (d.kind === 'wait') {
      step.waitMode = d.waitMode
      step.waitAmount = d.waitAmount
      step.waitUnit = d.waitUnit
      step.waitTimeout = d.waitTimeout
      step.waitTimeoutValue = d.waitTimeoutValue
    } else if (d.kind === 'if') {
      step.condition = d.condition
    } else if (d.kind === 'switch') {
      step.condition = d.condition
      step.cases = d.cases
    } else if (d.kind === 'loop') {
      step.mode = d.mode
      step.itemsExpr = d.itemsExpr
      step.count = d.count
      step.maxIters = d.maxIters
    } else if (d.kind === 'while') {
      step.condition = d.condition
      step.maxIters = d.maxIters
    } else if (d.kind === 'code') {
      step.code = d.code
      step.language = d.language ?? 'typescript'
      if (d.timeout) step.timeout = d.timeout
      step.onError = d.onError
    } else if (d.kind === 'http') {
      step.httpMethod = d.httpMethod
      step.url = d.url
      step.headers = d.headers
      step.body = d.body
      step.credentialId = d.credentialId
      step.responseMode = d.responseMode
      step.failOnHttpError = d.failOnHttpError
      if (d.timeout) step.timeout = d.timeout
      step.onError = d.onError
    } else if (d.kind === 'output') {
      step.template = d.template
    }
    if (branch) step.branch = branch
    out.push(step)
    for (const e of doc.edges) {
      if (e.source === id) emit(e.target, e.sourceHandle === 'error' ? 'error' : e.data?.label)
    }
  }

  for (const n of doc.nodes) {
    if (n.data.kind === 'trigger' || n.data.kind === 'webhook' || n.data.kind === 'schedule' || n.data.kind === 'connector-trigger') emit(n.id)
  }
  return out
}

/**
 * A ready-made "fetch weather → agent organizes → output" workflow document,
 * loaded by the toolbar's "加载天气示例" button.
 */
export function buildWeatherExample(): WorkflowDocument {
  const nodes: WorkflowNode[] = [
    {
      id: 'w-trigger',
      type: 'workflow',
      position: { x: 40, y: 200 },
      data: { kind: 'trigger', label: '天气触发', text: '抓取上海实时天气，并整理成一句中文播报' },
    },
    {
      id: 'w-fetch',
      type: 'workflow',
      position: { x: 230, y: 200 },
      data: {
        kind: 'code',
        label: '拉取天气',
        language: 'typescript',
        code: [
          'const r = await dsh.fetch({ url: \'https://api.open-meteo.com/v1/forecast?latitude=31.23&longitude=121.47&current=temperature_2m,weather_code&timezone=Asia%2FShanghai\' })',
          'if (!r.ok) throw new Error(\'天气接口失败: HTTP \' + r.status)',
          'return JSON.stringify({ temp: r.json?.current?.temperature_2m, code: r.json?.current?.weather_code })',
        ].join('\n'),
      },
    },
    {
      id: 'w-agent',
      type: 'workflow',
      position: { x: 440, y: 200 },
      data: {
        kind: 'agent',
        label: '整理天气',
        prompt: '请把下面这段实时天气数据整理成一句简洁、自然的中文天气播报，包含温度和天气状况（天气代码含义：0=晴，1-2=多云，3=阴，45/48=雾，51-67=雨，71-77=雪，80-82=阵雨，95+=雷雨），不要罗列原始 JSON。',
      },
    },
    {
      id: 'w-output',
      type: 'workflow',
      position: { x: 720, y: 200 },
      data: { kind: 'output', label: '输出', template: '{{result}}' },
    },
  ]
  const edges: WorkflowEdge[] = [
    { id: 'we1', source: 'w-trigger', target: 'w-fetch' },
    { id: 'we2', source: 'w-fetch', target: 'w-agent' },
    { id: 'we3', source: 'w-agent', target: 'w-output' },
  ]
  return { version: 1, name: '天气示例', description: '拉取上海实时天气 → agent 整理 → 输出', nodes, edges }
}

/**
 * IF example: fetch Shanghai weather; if temperature > 25, delegate to an agent
 * to summarize; otherwise output a short note. Demonstrates real true/false
 * branch routing.
 */
/** 定时新闻摘要：schedule → python 拉取 AIHOT 热点 → agent 总结 → 输出。 */
const NEWS_PY = [
  'import json, urllib.request',
  "req = urllib.request.Request('https://aihot.virxact.com/api/v1/items?mode=selected&window=7d&limit=10', headers={'User-Agent': 'aihot-skill/1.5.4'})",
  'try:',
  '  with urllib.request.urlopen(req, timeout=20) as r:',
  '    data = json.load(r)',
  "  items = data.get('items') or data.get('data') or []",
  '  lines = []',
  '  for it in items[:8]:',
  "    t = it.get('title', '')",
  "    s = it.get('summary', '')",
  "    src = (it.get('source') or {}).get('name', '')",
  "    link = (it.get('links') or {}).get('aihot', '')",
  '    lines.append(f"[{src}] {t}\\n   {s}\\n   {link}")',
  "  print('\\n'.join(lines) or 'no data')",
  'except Exception as e:',
  "  print('news fetch failed: ' + str(e))",
].join('\n')

export function buildNewsExample(): WorkflowDocument {
  const nodes: WorkflowNode[] = [
    { id: 'n-trig', type: 'workflow', position: { x: 20, y: 220 }, data: { kind: 'schedule', label: '每日定时', cron: '30 8 * * *', text: '抓取今天 AI 热点并总结' } },
    { id: 'n-fetch', type: 'workflow', position: { x: 230, y: 220 }, data: { kind: 'code', label: '拉取新闻', language: 'python', code: NEWS_PY } },
    {
      id: 'n-agent', type: 'workflow', position: { x: 470, y: 220 },
      data: { kind: 'agent', label: '总结新闻', prompt: '请把下面的 AI 热点整理成一段简洁的中文简报，按重要度排序，每条只保留标题和一句摘要，不要罗列原始 JSON。' },
    },
    { id: 'n-out', type: 'workflow', position: { x: 730, y: 220 }, data: { kind: 'output', label: '输出', template: '{{result}}' } },
  ]
  const edges: WorkflowEdge[] = [
    { id: 'ne1', source: 'n-trig', target: 'n-fetch' },
    { id: 'ne2', source: 'n-fetch', target: 'n-agent' },
    { id: 'ne3', source: 'n-agent', target: 'n-out' },
  ]
  return { version: 1, name: '定时 · 新闻摘要', description: '每天 08:30 python 拉取 AIHOT 热点 → agent 总结 → 输出', nodes, edges }
}

/** 通用条件分流：code 生成一个数 → If >10 → true/false 两个输出。 */
export function buildBasicIfExample(): WorkflowDocument {
  const nodes: WorkflowNode[] = [
    { id: 'b-trig', type: 'workflow', position: { x: 20, y: 240 }, data: { kind: 'trigger', label: '入口', text: '判断一个数是否大于 10' } },
    { id: 'b-code', type: 'workflow', position: { x: 200, y: 240 }, data: { kind: 'code', label: '生成一个数', language: 'typescript', code: 'return JSON.stringify({ n: 15 })' } },
    { id: 'b-if', type: 'workflow', position: { x: 400, y: 240 }, data: { kind: 'if', label: '大于10?', condition: 'Number(JSON.parse(result).n) > 10' } },
    { id: 'b-true', type: 'workflow', position: { x: 620, y: 100 }, data: { kind: 'output', label: '大于10', template: '这个数 {{result}} 大于 10' } },
    { id: 'b-false', type: 'workflow', position: { x: 620, y: 360 }, data: { kind: 'output', label: '≤10', template: '这个数 {{result}} 小于等于 10' } },
  ]
  const edges: WorkflowEdge[] = [
    { id: 'be1', source: 'b-trig', target: 'b-code' },
    { id: 'be2', source: 'b-code', target: 'b-if' },
    { id: 'be3', source: 'b-if', target: 'b-true', sourceHandle: 'true' },
    { id: 'be4', source: 'b-if', target: 'b-false', sourceHandle: 'false' },
  ]
  return { version: 1, name: 'If 分流', description: '生成一个数，大于10 走 true、否则走 false（改 code 里的数字可测另一条分支）', nodes, edges }
}

/** AI 问答·判断：agent 回答后，If 判断回答是否提到 "AI" 走不同分支。 */
export function buildQaIfExample(): WorkflowDocument {
  const nodes: WorkflowNode[] = [
    { id: 'q-trig', type: 'workflow', position: { x: 20, y: 240 }, data: { kind: 'trigger', label: '问题', text: '请回答：最近 AI 有什么热点？' } },
    { id: 'q-agent', type: 'workflow', position: { x: 220, y: 240 }, data: { kind: 'agent', label: 'AI 回答', prompt: '用一句话回答用户的问题。' } },
    { id: 'q-if', type: 'workflow', position: { x: 470, y: 240 }, data: { kind: 'if', label: '提到AI?', condition: 'result.includes("AI")' } },
    { id: 'q-yes', type: 'workflow', position: { x: 700, y: 100 }, data: { kind: 'output', label: '提到AI', template: '回答提到 AI：{{result}}' } },
    { id: 'q-no', type: 'workflow', position: { x: 700, y: 360 }, data: { kind: 'output', label: '没提AI', template: '回答没提 AI：{{result}}' } },
  ]
  const edges: WorkflowEdge[] = [
    { id: 'qe1', source: 'q-trig', target: 'q-agent' },
    { id: 'qe2', source: 'q-agent', target: 'q-if' },
    { id: 'qe3', source: 'q-if', target: 'q-yes', sourceHandle: 'true' },
    { id: 'qe4', source: 'q-if', target: 'q-no', sourceHandle: 'false' },
  ]
  return { version: 1, name: 'AI 问答·判断', description: 'agent 回答后，if 判断是否提到 "AI" 并走不同分支', nodes, edges }
}

/** 日常 Switch：按当前时段（早上/下午/晚上）路由到不同问候。 */
export function buildDailySwitchExample(): WorkflowDocument {
  const nodes: WorkflowNode[] = [
    { id: 'd-trig', type: 'workflow', position: { x: 20, y: 240 }, data: { kind: 'trigger', label: '问候', text: '按当前时间给问候' } },
    { id: 'd-code', type: 'workflow', position: { x: 200, y: 240 }, data: { kind: 'code', label: '取时段', language: 'typescript', code: "const h = new Date().getHours(); const label = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; return label" } },
    { id: 'd-sw', type: 'workflow', position: { x: 420, y: 240 }, data: { kind: 'switch', label: '按时段', condition: 'result', cases: 'morning, afternoon, evening' } },
    { id: 'd-m', type: 'workflow', position: { x: 660, y: 60 }, data: { kind: 'output', label: '早上', template: '早上好 ☀️，新的一天开始啦' } },
    { id: 'd-a', type: 'workflow', position: { x: 660, y: 220 }, data: { kind: 'output', label: '下午', template: '下午好 ☕，继续加油' } },
    { id: 'd-e', type: 'workflow', position: { x: 660, y: 380 }, data: { kind: 'output', label: '晚上', template: '晚上好 🌙，今天辛苦了' } },
    { id: 'd-def', type: 'workflow', position: { x: 660, y: 520 }, data: { kind: 'output', label: '其它', template: '你好' } },
  ]
  const edges: WorkflowEdge[] = [
    { id: 'de1', source: 'd-trig', target: 'd-code' },
    { id: 'de2', source: 'd-code', target: 'd-sw' },
    { id: 'de3', source: 'd-sw', target: 'd-m', sourceHandle: 'morning' },
    { id: 'de4', source: 'd-sw', target: 'd-a', sourceHandle: 'afternoon' },
    { id: 'de5', source: 'd-sw', target: 'd-e', sourceHandle: 'evening' },
    { id: 'de6', source: 'd-sw', target: 'd-def', sourceHandle: 'default' },
  ]
  return { version: 1, name: 'Switch · 时段问候', description: '按当前时段（早上/下午/晚上）路由到不同问候', nodes, edges }
}

/** Loop 示例：遍历一批热点，按是否含 "AI" 分流到 agent 深入或直接跳过，并收集每轮结果。 */
export function buildLoopExample(): WorkflowDocument {
  const nodes: WorkflowNode[] = [
    { id: 'lp-trig', type: 'workflow', position: { x: 20, y: 240 }, data: { kind: 'trigger', label: '热点列表', text: '["AI 大模型再突破","芯片供应回暖","开源社区新进展"]' } },
    { id: 'lp-loop', type: 'workflow', position: { x: 220, y: 240 }, data: { kind: 'loop', label: '遍历热点', mode: 'items', itemsExpr: 'JSON.parse(result)', maxIters: '100', collect: true } },
    { id: 'lp-code', type: 'workflow', position: { x: 440, y: 240 }, data: { kind: 'code', label: '读取本条', language: 'typescript', code: ['const it = await dsh.input(null)', 'return String(it)'].join('\n') } },
    { id: 'lp-if', type: 'workflow', position: { x: 660, y: 240 }, data: { kind: 'if', label: '含AI?', condition: 'result.includes("AI")' } },
    {
      id: 'lp-agent', type: 'workflow', position: { x: 880, y: 120 },
      data: { kind: 'agent', label: '深入总结', prompt: '请把这条科技热点用一句话总结清楚，包含核心信息，不要罗列原始 JSON。' },
    },
    { id: 'lp-out-agent', type: 'workflow', position: { x: 1100, y: 120 }, data: { kind: 'output', label: 'AI 条目', template: 'AI → {{result}}' } },
    { id: 'lp-out-skip', type: 'workflow', position: { x: 880, y: 380 }, data: { kind: 'output', label: '跳过', template: '跳过(非AI) → {{result}}' } },
    { id: 'lp-out-done', type: 'workflow', position: { x: 220, y: 480 }, data: { kind: 'output', label: '全部结果', template: '{{result}}' } },
  ]
  const edges: WorkflowEdge[] = [
    { id: 'lpe1', source: 'lp-trig', target: 'lp-loop', targetHandle: 'in' },
    { id: 'lpe2', source: 'lp-loop', target: 'lp-code', sourceHandle: 'iterate' },
    { id: 'lpe3', source: 'lp-code', target: 'lp-if' },
    { id: 'lpe4', source: 'lp-if', target: 'lp-agent', sourceHandle: 'true' },
    { id: 'lpe5', source: 'lp-if', target: 'lp-out-skip', sourceHandle: 'false' },
    { id: 'lpe6', source: 'lp-agent', target: 'lp-out-agent' },
    { id: 'lpe7', source: 'lp-out-agent', target: 'lp-loop', targetHandle: 'back' },
    { id: 'lpe8', source: 'lp-out-skip', target: 'lp-loop', targetHandle: 'back' },
    { id: 'lpe9', source: 'lp-loop', target: 'lp-out-done', sourceHandle: 'done' },
  ]
  return { version: 1, name: 'Loop · 批量处理热点', description: '遍历热点列表 → 含 AI 的交 agent 深入、否则跳过 → 收集每轮结果', nodes, edges }
}

/** While 示例：用字符串状态（待处理→处理中→完成）做判断，直到状态变为"完成"才停。 */
export function buildWhileExample(): WorkflowDocument {
  const nodes: WorkflowNode[] = [
    { id: 'wh-trig', type: 'workflow', position: { x: 20, y: 240 }, data: { kind: 'trigger', label: '初始状态', text: '待处理' } },
    { id: 'wh-while', type: 'workflow', position: { x: 220, y: 240 }, data: { kind: 'while', label: '直到完成', condition: 'result !== "完成"', maxIters: '100', collect: true } },
    {
      id: 'wh-code', type: 'workflow', position: { x: 440, y: 240 },
      data: { kind: 'code', label: '状态机', language: 'typescript', code: ['const s = await dsh.input(null)', "if (s === '待处理') return '处理中'", "if (s === '处理中') return '完成'", 'return s'].join('\n') },
    },
    { id: 'wh-if', type: 'workflow', position: { x: 660, y: 240 }, data: { kind: 'if', label: '是否处理中?', condition: 'result === "处理中"' } },
    { id: 'wh-out', type: 'workflow', position: { x: 220, y: 480 }, data: { kind: 'output', label: '状态推进', template: '状态推进: {{result}}' } },
  ]
  const edges: WorkflowEdge[] = [
    { id: 'whe1', source: 'wh-trig', target: 'wh-while', targetHandle: 'in' },
    { id: 'whe2', source: 'wh-while', target: 'wh-code', sourceHandle: 'iterate' },
    { id: 'whe3', source: 'wh-code', target: 'wh-if' },
    { id: 'whe4', source: 'wh-if', target: 'wh-while', sourceHandle: 'true', targetHandle: 'back' },
    { id: 'whe5', source: 'wh-if', target: 'wh-while', sourceHandle: 'false', targetHandle: 'back' },
    { id: 'whe6', source: 'wh-while', target: 'wh-out', sourceHandle: 'done' },
  ]
  return { version: 1, name: 'While · 状态轮询', description: '用字符串状态(待处理→处理中→完成)判断，直到状态变为"完成"才停，收集每次推进', nodes, edges }
}

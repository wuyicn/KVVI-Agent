import type { WorkflowConcurrency, WorkflowConcurrencyMode, WorkflowRunRecord } from './model.js'

export const MAX_WORKFLOW_CONCURRENT_RUNS = 20
export const MAX_WORKFLOW_QUEUED_RUNS = 100

export type NormalizedWorkflowConcurrency = {
  mode: WorkflowConcurrencyMode
  maxConcurrent: number
  maxQueue: number
}

export type WorkflowConcurrencyDecision = {
  action: 'start' | 'queue' | 'skip'
  active: number
  queued: number
  reason?: string
}

const DEFAULT_CONCURRENCY: NormalizedWorkflowConcurrency = {
  mode: 'parallel',
  maxConcurrent: 1,
  maxQueue: 50,
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function queueInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Normalizes absent legacy settings to unlimited parallel starts. A configured
 * limit is intentionally bounded so a malformed imported document cannot turn
 * a single DSH process into an unbounded execution queue.
 */
export function normalizeWorkflowConcurrency(value?: WorkflowConcurrency): NormalizedWorkflowConcurrency {
  const mode = value?.mode === 'skip' || value?.mode === 'queue' ? value.mode : 'parallel'
  const maxConcurrent = positiveInteger(value?.maxConcurrent) ?? DEFAULT_CONCURRENCY.maxConcurrent
  const maxQueue = queueInteger(value?.maxQueue) ?? DEFAULT_CONCURRENCY.maxQueue
  return {
    mode,
    maxConcurrent: Math.min(maxConcurrent, MAX_WORKFLOW_CONCURRENT_RUNS),
    maxQueue: Math.min(maxQueue, MAX_WORKFLOW_QUEUED_RUNS),
  }
}

/** Reject invalid explicitly configured values before a draft can be published. */
export function validateWorkflowConcurrency(value?: WorkflowConcurrency): void {
  if (!value) return
  if (value.mode !== undefined && !['parallel', 'skip', 'queue'].includes(value.mode)) throw new Error('工作流并发策略无效')
  if (value.maxConcurrent !== undefined && (!positiveInteger(value.maxConcurrent) || value.maxConcurrent > MAX_WORKFLOW_CONCURRENT_RUNS)) {
    throw new Error(`最大并发必须是 1 到 ${MAX_WORKFLOW_CONCURRENT_RUNS} 的整数`)
  }
  if (value.maxQueue !== undefined && (!queueInteger(value.maxQueue) || value.maxQueue > MAX_WORKFLOW_QUEUED_RUNS)) {
    throw new Error(`最大排队数必须是 0 到 ${MAX_WORKFLOW_QUEUED_RUNS} 的整数`)
  }
}

/** A waiting root keeps exactly one slot; its continuation replaces that slot. */
export function isActiveWorkflowRootRun(run: WorkflowRunRecord, workflowId: string): boolean {
  if (run.workflowId !== workflowId || run.parentRunId) return false
  return run.status === 'running' || (run.status === 'waiting' && !run.resumedByRunId)
}

export function isQueuedWorkflowRootRun(run: WorkflowRunRecord, workflowId: string): boolean {
  return run.workflowId === workflowId && !run.parentRunId && run.status === 'queued' && Boolean(run.queue)
}

export function countActiveWorkflowRootRuns(runs: WorkflowRunRecord[], workflowId: string): number {
  return runs.filter((run) => isActiveWorkflowRootRun(run, workflowId)).length
}

export function countQueuedWorkflowRootRuns(runs: WorkflowRunRecord[], workflowId: string): number {
  return runs.filter((run) => isQueuedWorkflowRootRun(run, workflowId)).length
}

/** Decide whether a new root trigger starts now, persists in FIFO, or is skipped. */
export function decideWorkflowConcurrency(
  concurrency: WorkflowConcurrency | undefined,
  runs: WorkflowRunRecord[],
  workflowId: string,
): WorkflowConcurrencyDecision {
  const policy = normalizeWorkflowConcurrency(concurrency)
  const active = countActiveWorkflowRootRuns(runs, workflowId)
  const queued = countQueuedWorkflowRootRuns(runs, workflowId)
  if (policy.mode === 'parallel' || active < policy.maxConcurrent) return { action: 'start', active, queued }
  if (policy.mode === 'skip') return { action: 'skip', active, queued, reason: `已有 ${active}/${policy.maxConcurrent} 个运行占用并发槽位` }
  if (queued >= policy.maxQueue) return { action: 'skip', active, queued, reason: `排队已满（${queued}/${policy.maxQueue}）` }
  return { action: 'queue', active, queued }
}

/** A queued item may start whenever the current policy exposes a free slot. */
export function canStartQueuedWorkflowRun(
  concurrency: WorkflowConcurrency | undefined,
  runs: WorkflowRunRecord[],
  workflowId: string,
): boolean {
  const policy = normalizeWorkflowConcurrency(concurrency)
  return policy.mode === 'parallel' || countActiveWorkflowRootRuns(runs, workflowId) < policy.maxConcurrent
}

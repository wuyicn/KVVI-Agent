import { createHash, timingSafeEqual } from 'node:crypto'
import type { WorkflowDocument, WorkflowNodeData, WorkflowRunRecord, WorkflowWaitpoint } from './model.js'

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000

export class WorkflowWaitSignal extends Error {
  constructor(public readonly waitpoint: WorkflowWaitpoint) {
    super('workflow waiting')
    this.name = 'WorkflowWaitSignal'
  }
}

export function createDebugWaitpoint(
  nodeId: string,
  input: string,
  reason: 'breakpoint' | 'step',
  previousNodeId?: string,
  now = Date.now(),
): WorkflowWaitpoint {
  return {
    nodeId,
    mode: 'debug',
    createdAt: new Date(now).toISOString(),
    input,
    debugReason: reason,
    previousNodeId,
  }
}

export function waitpointTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

export function waitpointTokenMatches(waitpoint: WorkflowWaitpoint, token: string): boolean {
  if (!waitpoint.tokenHash || !token) return false
  const actual = Buffer.from(waitpointTokenHash(token))
  const expected = Buffer.from(waitpoint.tokenHash)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createWorkflowWaitpoint(data: WorkflowNodeData, nodeId: string, input: string, now = Date.now()): WorkflowWaitpoint {
  if (data.waitMode && !['delay', 'callback', 'approval'].includes(data.waitMode)) throw new Error('等待方式无效')
  const mode = data.waitMode === 'callback' || data.waitMode === 'approval' ? data.waitMode : 'delay'
  const createdAt = new Date(now).toISOString()
  if (mode === 'delay') {
    if (data.waitUnit && !['seconds', 'minutes', 'hours', 'days'].includes(data.waitUnit)) throw new Error('等待单位无效')
    const amount = Number(data.waitAmount)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('等待时长必须大于 0')
    const unit = data.waitUnit === 'seconds' ? 1000
      : data.waitUnit === 'hours' ? 60 * 60 * 1000
        : data.waitUnit === 'days' ? 24 * 60 * 60 * 1000
          : 60 * 1000
    const delay = amount * unit
    if (delay > MAX_DELAY_MS) throw new Error('单次等待不能超过 365 天')
    return { nodeId, mode, createdAt, input, resumeAt: new Date(now + delay).toISOString() }
  }
  const timeoutHours = Number(data.waitTimeout)
  if (data.waitTimeout?.trim() && (!Number.isFinite(timeoutHours) || timeoutHours <= 0 || timeoutHours * 60 * 60 * 1000 > MAX_DELAY_MS)) {
    throw new Error('等待超时必须在 0 到 8760 小时之间')
  }
  return {
    nodeId,
    mode,
    createdAt,
    input,
    expiresAt: timeoutHours > 0 ? new Date(now + timeoutHours * 60 * 60 * 1000).toISOString() : undefined,
    timeoutValue: data.waitTimeoutValue,
  }
}

export function validateWorkflowWaitpoints(document: WorkflowDocument): void {
  const waitNodes = document.nodes.filter((node) => node.data.kind === 'wait')
  if (waitNodes.length === 0) return
  for (const node of waitNodes) createWorkflowWaitpoint(node.data, node.id, '')
  const edgesFrom = (id: string) => document.edges.filter((edge) => edge.source === id)
  const reachesWait = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false
    seen.add(id)
    if (waitNodes.some((node) => node.id === id)) return true
    return edgesFrom(id).some((edge) => reachesWait(edge.target, seen))
  }
  const starts = document.nodes.filter((node) => ['trigger', 'schedule', 'webhook', 'connector-trigger'].includes(node.data.kind))
  if (starts.length !== 1) throw new Error('含 Wait 节点的工作流必须且只能有一个触发入口')
  for (const node of document.nodes) {
    const outgoing = edgesFrom(node.id)
    if (node.data.kind === 'wait' && outgoing.length > 1) throw new Error('Wait 节点只能连接一个下游分支')
    if (!['if', 'switch', 'loop', 'while'].includes(node.data.kind) && outgoing.length > 1 && outgoing.some((edge) => reachesWait(edge.target))) {
      throw new Error(`节点“${node.data.label}”在 Wait 之前不能扇出多个并行分支`)
    }
    if (node.data.kind === 'loop' || node.data.kind === 'while') {
      const iterate = outgoing.find((edge) => edge.sourceHandle === 'iterate')
      if (iterate && reachesWait(iterate.target, new Set([node.id]))) throw new Error('Wait 节点暂不能放在 Loop 或 While 内部')
    }
  }
}

/**
 * Debugger v1 deliberately accepts only a single, linear manual chain. This
 * makes a persisted "next step" unambiguous and keeps loops, fan-out and
 * external waits out of an interactive session.
 */
export function validateWorkflowDebugDocument(document: WorkflowDocument): void {
  const starts = document.nodes.filter((node) => node.data.kind === 'trigger')
  if (starts.length !== 1) throw new Error('调试运行必须且只能有一个手动 Trigger 入口')
  if (document.nodes.some((node) => ['webhook', 'schedule', 'connector-trigger', 'wait', 'if', 'switch', 'loop', 'while'].includes(node.data.kind))) {
    throw new Error('调试运行 v1 仅支持不含触发器分支、Wait、条件或循环节点的线性工作流')
  }
  const ids = new Set(document.nodes.map((node) => node.id))
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, string>()
  for (const edge of document.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || edge.sourceHandle === 'error') throw new Error('调试运行不支持错误分支或无效连线')
    if (outgoing.has(edge.source)) throw new Error('调试运行 v1 仅支持单一路径，不能包含汇合或扇出')
    outgoing.set(edge.source, edge.target)
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
  }
  for (const node of document.nodes) {
    if ((incoming.get(node.id) ?? 0) > 1 || node.data.onError === 'route') throw new Error('调试运行 v1 仅支持单一路径，不能包含汇合或错误分支')
  }
  if ((incoming.get(starts[0].id) ?? 0) > 0) throw new Error('调试运行入口不能有上游连线')
  const visited = new Set<string>()
  let current: string | undefined = starts[0].id
  while (current) {
    if (visited.has(current)) throw new Error('调试运行 v1 不支持循环图')
    visited.add(current)
    current = outgoing.get(current)
  }
  if (visited.size !== document.nodes.length) throw new Error('调试运行 v1 要求所有节点位于同一条从 Trigger 开始的路径上')
}

export function canResolveWaitpoint(run: WorkflowRunRecord, now = Date.now()): boolean {
  if (run.status !== 'waiting' || !run.snapshot || !run.waitpoint || run.resumedByRunId) return false
  if (!run.snapshot.nodes.some((node) => node.id === run.waitpoint?.nodeId)) return false
  return run.waitpoint.mode === 'delay' && Boolean(run.waitpoint.resumeAt && Date.parse(run.waitpoint.resumeAt) <= now)
}

export function releaseOrphanedWaitpointClaims(runs: WorkflowRunRecord[]): WorkflowRunRecord[] {
  const byId = new Map(runs.map((run) => [run.id, run]))
  return runs.map((run) => {
    if (run.status !== 'waiting' || !run.resumedByRunId) return run
    const continuation = byId.get(run.resumedByRunId)
    if (continuation && !(continuation.status === 'interrupted' && !continuation.resumable)) return run
    return { ...run, resumedByRunId: undefined, completedAt: undefined }
  })
}

export function waitpointTimedOut(waitpoint: WorkflowWaitpoint, now = Date.now()): boolean {
  return waitpoint.mode !== 'debug' && Boolean(waitpoint.expiresAt && Date.parse(waitpoint.expiresAt) <= now)
}

export function sanitizeWaitpointRun(run: WorkflowRunRecord): WorkflowRunRecord {
  if (!run.waitpoint?.tokenHash) return run
  return { ...run, waitpoint: { ...run.waitpoint, tokenHash: undefined } }
}

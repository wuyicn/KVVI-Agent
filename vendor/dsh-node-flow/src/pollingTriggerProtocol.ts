import { createHash } from 'node:crypto'
import type { WorkflowDocument, WorkflowNodeData } from './model.js'
import { extractNodeProjectVariableReferences } from './projectVariableStore.js'

export type PollingTriggerState = {
  id: string
  workflowId: string
  nodeId: string
  connectorId: string
  connectorVersion?: number
  triggerId: string
  configurationHash: string
  nextPollAt: string
  recentKeys: string[]
  initialized: boolean
  cursor?: string
  lastPolledAt?: string
  lastEventAt?: string
  lastError?: string
  claimedAt?: string
}

const MIN_POLL_SECONDS = 15
const MAX_POLL_SECONDS = 24 * 60 * 60
const MAX_RECENT_KEYS = 500

export function pollingTriggerId(workflowId: string, nodeId: string): string {
  return `workflow:${workflowId}:${nodeId}`
}

export function pollingTriggerConfigurationHash(data: WorkflowNodeData, variables: Record<string, string> = {}): string {
  const params = Object.entries(data.connectorParams ?? {}).sort(([left], [right]) => left.localeCompare(right))
  const variableHashes = extractNodeProjectVariableReferences(data).map((name) => [name, createHash('sha256').update(variables[name] ?? '').digest('hex')])
  return createHash('sha256').update(JSON.stringify({
    connectorId: data.connectorId ?? '',
    connectorVersion: data.connectorVersion ?? 1,
    connectorTrigger: data.connectorTrigger ?? '',
    credentialId: data.credentialId ?? '',
    params,
    variableHashes,
  })).digest('hex')
}

export function pollingIntervalMs(data: WorkflowNodeData): number {
  const seconds = Number(data.pollInterval ?? '60')
  if (!Number.isInteger(seconds) || seconds < MIN_POLL_SECONDS || seconds > MAX_POLL_SECONDS) {
    throw new Error(`轮询间隔必须在 ${MIN_POLL_SECONDS} 到 ${MAX_POLL_SECONDS} 秒之间`)
  }
  return seconds * 1000
}

export function createPollingTriggerState(workflowId: string, nodeId: string, data: WorkflowNodeData, now = Date.now(), variables: Record<string, string> = {}): PollingTriggerState {
  if (!data.connectorId || !data.connectorTrigger || !data.credentialId) throw new Error('应用触发器需要应用、事件和连接')
  return {
    id: pollingTriggerId(workflowId, nodeId),
    workflowId,
    nodeId,
    connectorId: data.connectorId,
    connectorVersion: data.connectorVersion,
    triggerId: data.connectorTrigger,
    configurationHash: pollingTriggerConfigurationHash(data, variables),
    nextPollAt: new Date(now).toISOString(),
    recentKeys: [],
    initialized: false,
  }
}

export function syncPollingTriggerStates(
  current: PollingTriggerState[],
  workflowId: string,
  document: WorkflowDocument | undefined,
  now = Date.now(),
  variables: Record<string, string> = {},
): PollingTriggerState[] {
  const retained = current.filter((state) => state.workflowId !== workflowId)
  if (!document) return retained
  for (const node of document.nodes) {
    if (node.data.kind !== 'connector-trigger') continue
    const next = createPollingTriggerState(workflowId, node.id, node.data, now, variables)
    const previous = current.find((state) => state.id === next.id
      && state.connectorId === next.connectorId
      && state.triggerId === next.triggerId
      && state.configurationHash === next.configurationHash)
    retained.push(previous ?? next)
  }
  return retained
}

export function claimDuePollingTriggers(states: PollingTriggerState[], now = Date.now()): { states: PollingTriggerState[]; claimed: PollingTriggerState[] } {
  const claimed: PollingTriggerState[] = []
  const next = states.map((state) => {
    if (state.claimedAt || Date.parse(state.nextPollAt) > now) return state
    const updated = { ...state, claimedAt: new Date(now).toISOString() }
    claimed.push(updated)
    return updated
  })
  return { states: next, claimed }
}

export function completePollingTrigger(
  state: PollingTriggerState,
  keys: string[],
  intervalMs: number,
  cursor: string | undefined,
  now = Date.now(),
): { state: PollingTriggerState; newKeys: string[] } {
  const uniqueKeys = [...new Set(keys.filter(Boolean))]
  const seen = new Set(state.recentKeys)
  const newKeys = state.initialized ? uniqueKeys.filter((key) => !seen.has(key)) : []
  const recentKeys = [...uniqueKeys, ...state.recentKeys.filter((key) => !uniqueKeys.includes(key))].slice(0, MAX_RECENT_KEYS)
  return {
    newKeys,
    state: {
      ...state,
      initialized: true,
      cursor,
      recentKeys,
      nextPollAt: new Date(now + intervalMs).toISOString(),
      lastPolledAt: new Date(now).toISOString(),
      lastEventAt: newKeys.length ? new Date(now).toISOString() : state.lastEventAt,
      lastError: undefined,
      claimedAt: undefined,
    },
  }
}

export function failPollingTrigger(state: PollingTriggerState, intervalMs: number, error: unknown, now = Date.now()): PollingTriggerState {
  return {
    ...state,
    nextPollAt: new Date(now + Math.max(intervalMs, 60_000)).toISOString(),
    lastPolledAt: new Date(now).toISOString(),
    lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    claimedAt: undefined,
  }
}

export function releaseOrphanedPollingClaims(states: PollingTriggerState[]): PollingTriggerState[] {
  return states.map((state) => state.claimedAt ? { ...state, claimedAt: undefined } : state)
}

export function validatePollingTriggerGraph(document: WorkflowDocument): void {
  const triggers = document.nodes.filter((node) => node.data.kind === 'connector-trigger')
  for (const node of triggers) {
    createPollingTriggerState('validate', node.id, node.data)
    pollingIntervalMs(node.data)
    if (document.edges.some((edge) => edge.target === node.id)) throw new Error(`应用触发器“${node.data.label}”不能有上游节点`)
    if (document.edges.filter((edge) => edge.source === node.id).length !== 1) throw new Error(`应用触发器“${node.data.label}”必须连接一个下游节点`)
  }
}

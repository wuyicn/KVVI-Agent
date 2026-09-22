export type WorkflowNodeSample = {
  input?: unknown
  output?: unknown
  at: string
}

type WorkflowSamples = Record<string, WorkflowNodeSample>

const STORAGE_PREFIX = 'dsh-node-flow:samples:v1:'
const MAX_SERIALIZED_LENGTH = 256 * 1024

function storageKey(workflowId: string): string {
  return `${STORAGE_PREFIX}${workflowId || 'standalone'}`
}

export function readWorkflowSamples(workflowId: string): WorkflowSamples {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(workflowId)) ?? '{}') as unknown
    return parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? parsed as WorkflowSamples : {}
  } catch {
    return {}
  }
}

export function saveWorkflowNodeSample(workflowId: string, nodeId: string, sample: WorkflowNodeSample): void {
  try {
    const current = readWorkflowSamples(workflowId)
    const next = { ...current, [nodeId]: sample }
    let serialized = JSON.stringify(next)
    if (serialized.length > MAX_SERIALIZED_LENGTH) {
      const recent = Object.entries(next)
        .sort(([, left], [, right]) => right.at.localeCompare(left.at))
        .slice(0, 12)
      serialized = JSON.stringify(Object.fromEntries(recent))
    }
    if (serialized.length <= MAX_SERIALIZED_LENGTH) localStorage.setItem(storageKey(workflowId), serialized)
  } catch {
  }
}

import type { WorkflowNodeData } from './model.js'

export type RetryPolicy = {
  retries: number
  delayMs: number
  backoff: 'fixed' | 'exponential'
}

export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(message)
    this.name = 'RetryExhaustedError'
  }
}

export function normalizeRetryPolicy(data: Pick<WorkflowNodeData, 'retryCount' | 'retryDelay' | 'retryBackoff'>): RetryPolicy {
  const retries = Math.min(10, Math.max(0, Math.floor(Number(data.retryCount)) || 0))
  const delaySeconds = Math.min(3600, Math.max(0, Number(data.retryDelay) || 0))
  return {
    retries,
    delayMs: Math.round(delaySeconds * 1000),
    backoff: data.retryBackoff === 'exponential' ? 'exponential' : 'fixed',
  }
}

export function retryDelayMilliseconds(policy: RetryPolicy, retryIndex: number): number {
  if (policy.delayMs <= 0) return 0
  const multiplier = policy.backoff === 'exponential' ? 2 ** Math.max(0, retryIndex - 1) : 1
  return Math.min(3_600_000, policy.delayMs * multiplier)
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('运行已取消')
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal)
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

export async function executeWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  data: Pick<WorkflowNodeData, 'retryCount' | 'retryDelay' | 'retryBackoff'>,
  signal?: AbortSignal,
): Promise<{ value: T; attempts: number }> {
  const policy = normalizeRetryPolicy(data)
  const maxAttempts = policy.retries + 1
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortError(signal)
    try {
      return { value: await operation(attempt), attempts: attempt }
    } catch (error) {
      if (signal?.aborted) throw abortError(signal)
      lastError = error
      if (attempt >= maxAttempts) {
        const message = error instanceof Error ? error.message : String(error)
        throw new RetryExhaustedError(message, attempt, error)
      }
      await waitForRetry(retryDelayMilliseconds(policy, attempt), signal)
    }
  }
  throw new RetryExhaustedError('节点执行失败', maxAttempts, lastError)
}

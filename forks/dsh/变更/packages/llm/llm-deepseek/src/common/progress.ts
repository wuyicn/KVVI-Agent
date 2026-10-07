/** Model-output progress deadline; network keepalives and usage are not output. */
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

function advances(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta': return chunk.text.length > 0
    case 'tool-call-delta': return chunk.argumentsDelta.length > 0 || chunk.name !== undefined
    case 'block-start':
    case 'block-end':
    case 'finish': return true
    default: return false
  }
}

/**
 * Count provider wait across metadata chunks, excluding consumer processing time.
 * @param upstream - request cancellation.
 * @param timeoutMs - validated maximum time without model output progress.
 * @returns one stream-owned controller and its serialized iterator demand.
 */
export function outputProgress(upstream: AbortSignal, timeoutMs: number) {
  const controller = new AbortController()
  const signal = AbortSignal.any([upstream, controller.signal])
  let remaining = timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    signal,
    async next(iterator: AsyncIterator<StreamChunk>): Promise<IteratorResult<StreamChunk>> {
      signal.throwIfAborted()
      const started = performance.now()
      timer = setTimeout(() => { controller.abort(new TimeoutReason('DEEPSEEK_PROGRESS', timeoutMs)) }, Math.max(1, remaining))
      try {
        const result = await iterator.next()
        signal.throwIfAborted()
        remaining = result.done || advances(result.value) ? timeoutMs : Math.max(0, remaining - (performance.now() - started))
        return result
      } finally { clearTimeout(timer); timer = undefined }
    },
    [Symbol.dispose]() { clearTimeout(timer); timer = undefined },
  }
}

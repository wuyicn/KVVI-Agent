import type { WorkflowNodeData } from './model.js'
import { renderResultJsonTemplate, renderResultTemplate } from './resultExpression.js'

export type HttpNodeResult = {
  status: number
  value: unknown
  output: string
  logs: string[]
}

export type PreparedHttpRequest = {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  responseMode?: string
  timeout?: string
  credentialId?: string
  failOnHttpError?: boolean
  validateResponse?: (value: unknown, status: number) => void
}

export class HttpNodeError extends Error {
  constructor(message: string, readonly result?: HttpNodeResult) {
    super(message)
    this.name = 'HttpNodeError'
  }
}

function parseHeaders(source: string | undefined, input: string, variables: Record<string, unknown>): Record<string, string> {
  if (!source?.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(renderResultJsonTemplate(source, input, variables))
  } catch {
    throw new Error('请求头必须是有效的 JSON 对象')
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('请求头必须是 JSON 对象')
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const name = key.trim()
    const text = String(value)
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(text)) throw new Error('请求头包含无效字符')
    headers[name] = text
  }
  return headers
}

function linkedSignal(timeoutSeconds: string | undefined, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const seconds = Math.max(0, Math.floor(Number(timeoutSeconds)) || 0)
  const timer = seconds > 0 ? setTimeout(() => controller.abort(new Error('HTTP 请求超时')), seconds * 1000) : undefined
  const abort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    clear: () => {
      if (timer) clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    },
  }
}

async function readLimitedText(response: Response, maxBytes = 5 * 1024 * 1024): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) throw new Error('HTTP 响应超过 5 MB 限制')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('HTTP 响应超过 5 MB 限制')
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}

export async function executeHttpNode(
  data: WorkflowNodeData,
  input: string,
  resolveHeaders: (credentialId: string, forceRefresh?: boolean) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>,
  parentSignal?: AbortSignal,
  variables: Record<string, unknown> = {},
): Promise<HttpNodeResult> {
  const renderedUrl = renderResultTemplate(data.url ?? '', input, variables).trim()
  if (!renderedUrl) throw new Error('HTTP URL 不能为空')
  let url: URL
  try { url = new URL(renderedUrl) } catch { throw new Error('HTTP URL 无效') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HTTP 节点仅支持 http/https URL')
  const method = (data.httpMethod || 'GET').toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) throw new Error('不支持的 HTTP 方法')
  const headers = parseHeaders(data.headers, input, variables)
  if (data.credentialId) Object.assign(headers, await resolveHeaders(data.credentialId))
  const bodySource = data.body?.trimStart() ?? ''
  const body = method === 'GET' || method === 'HEAD' || !data.body
    ? undefined
    : bodySource.startsWith('{') || bodySource.startsWith('[')
      ? renderResultJsonTemplate(data.body, input, variables)
      : renderResultTemplate(data.body, input, variables)
  return await executePreparedHttpRequest({
    method,
    url: url.toString(),
    headers,
    body,
    responseMode: data.responseMode,
    timeout: data.timeout,
    credentialId: data.credentialId,
    failOnHttpError: data.failOnHttpError,
  }, resolveHeaders, parentSignal, true)
}

export async function executePreparedHttpRequest(
  request: PreparedHttpRequest,
  resolveHeaders: (credentialId: string, forceRefresh?: boolean) => Record<string, string> | undefined | Promise<Record<string, string> | undefined>,
  parentSignal?: AbortSignal,
  credentialsResolved = false,
): Promise<HttpNodeResult> {
  let url: URL
  try { url = new URL(request.url) } catch { throw new Error('HTTP URL 无效') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('HTTP 节点仅支持 http/https URL')
  const method = request.method.toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) throw new Error('不支持的 HTTP 方法')
  const headers = { ...(request.headers ?? {}) }
  if (request.credentialId && !credentialsResolved) Object.assign(headers, await resolveHeaders(request.credentialId))
  const requestSignal = linkedSignal(request.timeout, parentSignal)
  try {
    let response = await fetch(url, { method, headers, body: request.body, signal: requestSignal.signal, redirect: 'error' })
    let refreshedAfterUnauthorized = false
    if (response.status === 401 && request.credentialId) {
      try {
        const refreshed = await resolveHeaders(request.credentialId, true)
        if (refreshed) {
          await response.body?.cancel().catch(() => {})
          Object.assign(headers, refreshed)
          response = await fetch(url, { method, headers, body: request.body, signal: requestSignal.signal, redirect: 'error' })
          refreshedAfterUnauthorized = true
        }
      } catch {
        // The original 401 remains the authoritative HTTP result; credential health records the refresh failure.
      }
    }
    const text = await readLimitedText(response)
    let value: unknown = text
    const responseMode = request.responseMode || 'auto'
    const parseJson = responseMode === 'json' || (responseMode === 'auto' && response.headers.get('content-type')?.includes('json'))
    if (parseJson && text) {
      try { value = JSON.parse(text) } catch { if (responseMode === 'json') throw new Error('HTTP 响应不是有效 JSON') }
    }
    const output = typeof value === 'string' ? value : JSON.stringify(value)
    const result = { status: response.status, value, output, logs: [...(refreshedAfterUnauthorized ? ['OAuth2 Token 已在 HTTP 401 后刷新'] : []), `HTTP ${response.status} ${response.statusText}`] }
    if (request.failOnHttpError !== false && !response.ok) throw new HttpNodeError(`HTTP ${response.status} ${response.statusText}`, result)
    try { request.validateResponse?.(value, response.status) } catch (error) { throw new HttpNodeError(error instanceof Error ? error.message : String(error), result) }
    return result
  } catch (error) {
    if (error instanceof HttpNodeError) throw error
    if (requestSignal.signal.aborted) throw new Error(parentSignal?.aborted ? '运行已取消' : 'HTTP 请求超时')
    throw error
  } finally {
    requestSignal.clear()
  }
}

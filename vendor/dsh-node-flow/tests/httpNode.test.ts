import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { executeHttpNode, HttpNodeError } from '../src/httpNode.js'

test('executes a templated HTTP request with server-side credential headers', async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ method: request.method, url: request.url, authorization: request.headers.authorization, input: request.headers['x-input'], body: Buffer.concat(chunks).toString('utf8') }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not expose a port')
    const result = await executeHttpNode({
      kind: 'http',
      label: 'Request',
      httpMethod: 'POST',
      url: `http://127.0.0.1:${address.port}/echo?id={{result.items[0].id}}`,
      headers: '{"content-type":"application/json","x-input":"{{result.user.name}}"}',
      body: '{"value":"{{result.user.name}}"}',
      credentialId: 'credential-a',
      responseMode: 'json',
      failOnHttpError: true,
      timeout: '2',
    }, '{"user":{"name":"hello"},"items":[{"id":42}]}', () => ({ Authorization: 'Bearer secret' }))
    assert.equal(result.status, 200)
    assert.deepEqual(result.value, { method: 'POST', url: '/echo?id=42', authorization: 'Bearer secret', input: 'hello', body: '{"value":"hello"}' })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('reports non-success responses with the parsed response attached', async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 422
    response.setHeader('content-type', 'application/json')
    response.end('{"reason":"invalid"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not expose a port')
    await assert.rejects(
      executeHttpNode({ kind: 'http', label: 'Request', url: `http://127.0.0.1:${address.port}/`, responseMode: 'auto', failOnHttpError: true }, '', () => ({})),
      (error: unknown) => error instanceof HttpNodeError && error.result?.status === 422 && (error.result.value as { reason: string }).reason === 'invalid',
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('refreshes an OAuth2 credential once after HTTP 401 and retries the request', async () => {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    const authorized = request.headers.authorization === 'Bearer refreshed'
    response.statusCode = authorized ? 200 : 401
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ authorized }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not expose a port')
    let refreshes = 0
    const result = await executeHttpNode({
      kind: 'http',
      label: 'OAuth request',
      url: `http://127.0.0.1:${address.port}/`,
      credentialId: 'oauth-credential',
      responseMode: 'json',
    }, '', async (_credentialId, forceRefresh) => {
      if (forceRefresh) refreshes += 1
      return { Authorization: forceRefresh ? 'Bearer refreshed' : 'Bearer stale' }
    })
    assert.deepEqual(result.value, { authorized: true })
    assert.equal(requests, 2)
    assert.equal(refreshes, 1)
    assert.match(result.logs.join('\n'), /401 后刷新/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('rejects unsafe protocols and honors caller cancellation', async () => {
  await assert.rejects(executeHttpNode({ kind: 'http', label: 'Request', url: 'file:///tmp/private' }, '', () => ({})), /仅支持 http\/https/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(executeHttpNode({ kind: 'http', label: 'Request', url: 'http://127.0.0.1:1/' }, '', () => ({}), controller.signal), /运行已取消/)
})

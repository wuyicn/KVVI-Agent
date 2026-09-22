import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deleteCredential, exchangeOAuthAuthorizationCode, listCredentialSummaries, resolveCredentialHeaders, resolveWebhookSecret, saveCredential, testCredentialConnection } from '../src/credentialStore.js'

test('encrypts credentials and exposes only summaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-node-flow-credentials-'))
  try {
    const saved = saveCredential(directory, { name: 'Service token', kind: 'bearer', secret: { value: 'plain-secret-value' } })
    assert.deepEqual(await resolveCredentialHeaders(directory, saved.id), { Authorization: 'Bearer plain-secret-value' })
    assert.equal(JSON.stringify(listCredentialSummaries(directory)).includes('plain-secret-value'), false)
    assert.equal(readFileSync(join(directory, 'credentials.json'), 'utf8').includes('plain-secret-value'), false)

    const renamed = saveCredential(directory, { id: saved.id, name: 'Renamed token', kind: 'bearer' })
    assert.equal(renamed.name, 'Renamed token')
    assert.deepEqual(await resolveCredentialHeaders(directory, saved.id), { Authorization: 'Bearer plain-secret-value' })
    assert.equal(deleteCredential(directory, saved.id), true)
    assert.equal(listCredentialSummaries(directory).length, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('builds API key and Basic Auth headers and rejects unsafe edits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-node-flow-credentials-'))
  try {
    const apiKey = saveCredential(directory, { name: 'API', kind: 'api-key', headerName: 'X-Service-Key', secret: { value: 'key-value' } })
    assert.deepEqual(await resolveCredentialHeaders(directory, apiKey.id), { 'X-Service-Key': 'key-value' })
    const basic = saveCredential(directory, { name: 'Basic', kind: 'basic', secret: { username: 'demo', password: 'pass' } })
    assert.deepEqual(await resolveCredentialHeaders(directory, basic.id), { Authorization: `Basic ${Buffer.from('demo:pass').toString('base64')}` })
    assert.throws(() => saveCredential(directory, { id: apiKey.id, name: 'Changed', kind: 'basic' }), /必须填写新的凭据内容/)
    assert.throws(() => saveCredential(directory, { name: 'Broken', kind: 'basic', secret: { username: 'demo', password: '' } }), /用户名和密码不能为空/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('encrypts dedicated webhook signing secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-node-flow-webhook-secret-'))
  try {
    const saved = saveCredential(directory, { name: 'Webhook signing', kind: 'webhook-secret', secret: { value: 'webhook-secret-value-123' } })
    assert.equal(saved.status, 'connected')
    assert.equal(resolveWebhookSecret(directory, saved.id), 'webhook-secret-value-123')
    assert.equal(readFileSync(join(directory, 'credentials.json'), 'utf8').includes('webhook-secret-value-123'), false)
    assert.throws(() => saveCredential(directory, { name: 'Short webhook secret', kind: 'webhook-secret', secret: { value: 'too-short' } }), /至少需要 16 个字符/)
    assert.throws(() => resolveWebhookSecret(directory, saveCredential(directory, { name: 'Bearer', kind: 'bearer', secret: { value: 'bearer-secret' } }).id), /必须使用 Webhook Secret/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('encrypts OAuth2 tokens and deduplicates concurrent refreshes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-node-flow-oauth-'))
  try {
    const saved = saveCredential(directory, {
      name: 'OAuth service',
      kind: 'oauth2',
      authorizationUrl: 'http://127.0.0.1:4100/authorize',
      tokenUrl: 'http://127.0.0.1:4100/token',
      clientId: 'client-id',
      clientAuth: 'body',
      usePkce: true,
      testUrl: 'http://127.0.0.1:4100/me',
      secret: { clientSecret: 'client-secret' },
    })
    const exchanged = await exchangeOAuthAuthorizationCode(directory, saved.id, 'code', 'http://127.0.0.1:3080/callback', 'verifier', saved.updatedAt, async () => new Response(JSON.stringify({
      access_token: 'initial-access',
      refresh_token: 'refresh-secret',
      expires_in: 0,
      token_type: 'Bearer',
    }), { headers: { 'content-type': 'application/json' } }))
    assert.equal(exchanged.status, 'expired')
    const storedSource = readFileSync(join(directory, 'credentials.json'), 'utf8')
    assert.equal(storedSource.includes('client-secret'), false)
    assert.equal(storedSource.includes('initial-access'), false)
    assert.equal(storedSource.includes('refresh-secret'), false)

    let refreshes = 0
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).endsWith('/token')) {
        refreshes += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return new Response('{"access_token":"refreshed-access","expires_in":3600,"token_type":"Bearer"}', { headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 204 })
    }
    const [left, right] = await Promise.all([
      resolveCredentialHeaders(directory, saved.id, fetcher),
      resolveCredentialHeaders(directory, saved.id, fetcher),
    ])
    assert.deepEqual(left, { Authorization: 'Bearer refreshed-access' })
    assert.deepEqual(right, left)
    assert.equal(refreshes, 1)
    const tested = await testCredentialConnection(directory, saved.id, fetcher)
    assert.equal(tested.status, 'connected')
    assert.match(tested.statusMessage ?? '', /HTTP 204/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

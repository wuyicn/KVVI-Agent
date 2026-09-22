import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const credentialName = `__oauth2_${suffix}`
const codes = new Map()
let authorizationRequests = 0
let codeExchanges = 0
let refreshes = 0
let resourceRequests = 0
let lastResourceAuthorization

const provider = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
  if (requestUrl.pathname === '/authorize') {
    authorizationRequests += 1
    if (requestUrl.searchParams.get('response_type') !== 'code'
      || requestUrl.searchParams.get('client_id') !== 'dsh-client'
      || requestUrl.searchParams.get('code_challenge_method') !== 'S256'
      || requestUrl.searchParams.get('prompt') !== 'consent') {
      response.statusCode = 400
      response.end('invalid authorization request')
      return
    }
    const code = `code-${suffix}`
    codes.set(code, requestUrl.searchParams.get('code_challenge'))
    const redirect = new URL(requestUrl.searchParams.get('redirect_uri'))
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', requestUrl.searchParams.get('state') || '')
    response.writeHead(302, { location: redirect.toString() })
    response.end()
    return
  }
  if (requestUrl.pathname === '/token') {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
    if (body.get('client_id') !== 'dsh-client' || body.get('client_secret') !== 'dsh-secret' || body.get('audience') !== 'dsh-api') {
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end('{"error":"invalid_client"}')
      return
    }
    if (body.get('grant_type') === 'authorization_code') {
      const expectedChallenge = codes.get(body.get('code'))
      const actualChallenge = createHash('sha256').update(body.get('code_verifier') || '').digest('base64url')
      if (!expectedChallenge || expectedChallenge !== actualChallenge) {
        response.statusCode = 400
        response.setHeader('content-type', 'application/json')
        response.end('{"error":"invalid_grant","error_description":"PKCE verification failed"}')
        return
      }
      codeExchanges += 1
      response.setHeader('content-type', 'application/json')
      response.end('{"access_token":"initial-token","refresh_token":"refresh-token","expires_in":3600,"token_type":"Bearer"}')
      return
    }
    if (body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'refresh-token') {
      refreshes += 1
      response.setHeader('content-type', 'application/x-www-form-urlencoded')
      response.end('access_token=refreshed-token&expires_in=3600&token_type=Bearer')
      return
    }
    response.statusCode = 400
    response.setHeader('content-type', 'application/json')
    response.end('{"error":"unsupported_grant_type"}')
    return
  }
  if (requestUrl.pathname === '/resource') {
    resourceRequests += 1
    const token = request.headers.authorization
    lastResourceAuthorization = token
    response.statusCode = token === 'Bearer refreshed-token' ? 200 : 401
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: response.statusCode === 200, token }))
    return
  }
  response.statusCode = 404
  response.end('not found')
})

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

async function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

async function cleanup() {
  const listed = await requestJson('/dsh-node-flow/credentials').catch(() => ({ credentials: [] }))
  for (const credential of listed.credentials || []) {
    if (credential.name === credentialName) await post('/dsh-node-flow/credentials', { action: 'delete', id: credential.id }).catch(() => {})
  }
}

await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
try {
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('OAuth2 provider did not expose a TCP port')
  const providerUrl = `http://127.0.0.1:${address.port}`
  const health = await requestJson('/dsh-node-flow/workflows')
  if (health.capabilities?.oauth2 !== true || health.capabilities?.connectionTesting !== true) throw new Error('Running backend does not expose OAuth2 capabilities')
  await cleanup()

  const saved = await post('/dsh-node-flow/credentials', {
    action: 'save',
    credential: {
      name: credentialName,
      kind: 'oauth2',
      authorizationUrl: `${providerUrl}/authorize`,
      tokenUrl: `${providerUrl}/token`,
      clientId: 'dsh-client',
      scopes: 'read offline_access',
      clientAuth: 'body',
      usePkce: true,
      extraAuthParams: '{"prompt":"consent"}',
      extraTokenParams: '{"audience":"dsh-api"}',
      testUrl: `${providerUrl}/resource`,
      secret: { clientSecret: 'dsh-secret' },
    },
  })
  const credentialId = saved.credential?.id
  if (!credentialId || JSON.stringify(saved).includes('dsh-secret')) throw new Error('OAuth2 credential save leaked a secret')

  const start = await post('/dsh-node-flow/oauth2/start', { id: credentialId })
  const authorizationUrl = new URL(start.authorizationUrl)
  if (authorizationUrl.searchParams.get('state')?.length < 32 || authorizationUrl.searchParams.get('code_challenge')?.length < 32) throw new Error('OAuth2 start did not create secure State and PKCE values')
  const providerResponse = await fetch(authorizationUrl, { redirect: 'manual' })
  const callbackLocation = providerResponse.headers.get('location')
  if (providerResponse.status !== 302 || !callbackLocation) throw new Error(`OAuth2 provider did not redirect: HTTP ${providerResponse.status}`)
  const callback = await fetch(callbackLocation)
  if (!callback.ok || !(await callback.text()).includes('授权成功')) throw new Error('OAuth2 callback did not complete')

  const afterAuthorization = await requestJson('/dsh-node-flow/credentials')
  const authorized = afterAuthorization.credentials?.find((credential) => credential.id === credentialId)
  const serialized = JSON.stringify(afterAuthorization)
  if (authorized?.status !== 'connected' || !authorized.authorizedAt) throw new Error(`OAuth2 credential was not authorized: ${serialized}`)
  if (['dsh-secret', 'initial-token', 'refresh-token'].some((secret) => serialized.includes(secret))) throw new Error('OAuth2 secret leaked through the credential API')

  const tested = await post('/dsh-node-flow/credentials', { action: 'test', id: credentialId })
  if (tested.credential?.status !== 'connected' || !String(tested.credential?.statusMessage).includes('HTTP 200')) throw new Error(`OAuth2 connection test failed: ${JSON.stringify(tested)}`)
  if (refreshes !== 1 || resourceRequests !== 2) throw new Error(`OAuth2 401 refresh behavior was unexpected: ${JSON.stringify({ refreshes, resourceRequests })}`)

  const nodeTest = await post('/dsh-node-flow/node-test', {
    node: {
      id: `oauth-http-${suffix}`,
      type: 'workflow',
      position: { x: 0, y: 0 },
      data: { kind: 'http', label: 'OAuth2 resource', url: `${providerUrl}/resource`, credentialId, responseMode: 'json', failOnHttpError: true },
    },
    input: '',
  })
  if (nodeTest.node?.status !== 'ok'
    || nodeTest.node?.output?.token !== '[redacted]'
    || lastResourceAuthorization !== 'Bearer refreshed-token'
    || JSON.stringify(nodeTest).includes('refreshed-token')) {
    throw new Error(`HTTP node did not reuse the refreshed OAuth2 token safely: ${JSON.stringify(nodeTest)}`)
  }
  if (refreshes !== 1 || resourceRequests !== 3) throw new Error('HTTP node refreshed a still-valid Token unexpectedly')

  const invalidState = await fetch(`${baseUrl}/dsh-node-flow/oauth2/callback?code=ignored&state=invalid`)
  if (invalidState.status !== 400 || !(await invalidState.text()).includes('State 无效')) throw new Error('OAuth2 callback accepted an invalid State')

  console.log(JSON.stringify({
    ok: true,
    authorizationRequests,
    codeExchanges,
    refreshes,
    resourceRequests,
    pkce: true,
    secretHidden: true,
  }, null, 2))
} finally {
  await cleanup().catch(() => {})
  await new Promise((resolve) => provider.close(() => resolve()))
}

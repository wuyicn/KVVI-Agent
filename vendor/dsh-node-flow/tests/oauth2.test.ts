import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAuthorizationCodeRequest,
  buildAuthorizationUrl,
  buildRefreshTokenRequest,
  parseTokenResponse,
  validateOAuthConfig,
} from '../src/oauth2.js'

const config = {
  authorizationUrl: 'http://127.0.0.1:4100/authorize',
  tokenUrl: 'http://127.0.0.1:4100/token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scopes: 'read write',
  clientAuth: 'body' as const,
  usePkce: true,
  extraAuthParams: '{"prompt":"consent"}',
  extraTokenParams: '{"audience":"dsh"}',
}

test('builds a PKCE authorization URL without allowing reserved overrides', () => {
  const url = new URL(buildAuthorizationUrl(config, 'http://127.0.0.1:3080/callback', 'state-value', 'verifier'))
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'client-id')
  assert.equal(url.searchParams.get('scope'), 'read write')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.throws(() => buildAuthorizationUrl({ ...config, extraAuthParams: '{"state":"override"}' }, 'http://127.0.0.1/callback', 'state'), /不能覆盖保留参数/)
})

test('builds authorization-code and refresh requests for body and basic client auth', () => {
  const codeRequest = buildAuthorizationCodeRequest(config, 'code-value', 'http://127.0.0.1/callback', 'verifier')
  const codeBody = new URLSearchParams(codeRequest.body)
  assert.equal(codeBody.get('grant_type'), 'authorization_code')
  assert.equal(codeBody.get('client_secret'), 'client-secret')
  assert.equal(codeBody.get('code_verifier'), 'verifier')
  assert.equal(codeBody.get('audience'), 'dsh')
  const refresh = buildRefreshTokenRequest({ ...config, clientAuth: 'basic' }, 'refresh-value')
  assert.match(refresh.headers.Authorization, /^Basic /)
  assert.equal(new URLSearchParams(refresh.body).has('client_secret'), false)
})

test('normalizes configuration and parses JSON or form token responses', () => {
  assert.equal(validateOAuthConfig(config).authorizationUrl, 'http://127.0.0.1:4100/authorize')
  assert.throws(() => validateOAuthConfig({ ...config, authorizationUrl: 'http://example.com/authorize' }), /必须使用 HTTPS/)
  const json = parseTokenResponse('{"access_token":"a","refresh_token":"r","expires_in":60,"token_type":"Bearer"}', 'application/json')
  assert.equal(json.accessToken, 'a')
  assert.equal(json.refreshToken, 'r')
  assert.ok(json.expiresAt)
  const form = parseTokenResponse('access_token=b&token_type=MAC', 'application/x-www-form-urlencoded', 'previous')
  assert.equal(form.tokenType, 'MAC')
  assert.equal(form.refreshToken, 'previous')
  assert.throws(() => parseTokenResponse('{"access_token":"bad\\nvalue"}', 'application/json'), /access_token 无效/)
})

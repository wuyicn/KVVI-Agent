import { createHash, randomBytes } from 'node:crypto'
import type { OAuth2ClientAuth } from './model.js'

export type OAuth2Config = {
  authorizationUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  scopes?: string
  clientAuth?: OAuth2ClientAuth
  usePkce?: boolean
  extraAuthParams?: string
  extraTokenParams?: string
}

export type OAuthTokenSet = {
  accessToken: string
  refreshToken?: string
  tokenType: string
  expiresAt?: string
  scope?: string
}

export type OAuthTokenRequest = {
  url: string
  headers: Record<string, string>
  body: string
}

const AUTH_RESERVED = new Set(['response_type', 'client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method'])
const TOKEN_RESERVED = new Set(['grant_type', 'code', 'redirect_uri', 'client_id', 'client_secret', 'code_verifier', 'refresh_token'])

export function validateOAuthUrl(value: string, label: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error(`${label} 无效`) }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error(`${label} 必须使用 HTTPS（本机回环地址除外）`)
  if (url.username || url.password) throw new Error(`${label} 不能包含用户名或密码`)
  return url.toString()
}

export function validateOAuthConfig(config: OAuth2Config): OAuth2Config {
  const clientId = config.clientId.trim()
  if (!clientId) throw new Error('OAuth2 Client ID 不能为空')
  const clientAuth = config.clientAuth ?? 'body'
  if (!['body', 'basic', 'none'].includes(clientAuth)) throw new Error('不支持的 OAuth2 客户端认证方式')
  if (clientAuth !== 'none' && !config.clientSecret) throw new Error('OAuth2 Client Secret 不能为空')
  parseOAuthParams(config.extraAuthParams, AUTH_RESERVED, '额外授权参数')
  parseOAuthParams(config.extraTokenParams, TOKEN_RESERVED, '额外 Token 参数')
  return {
    authorizationUrl: validateOAuthUrl(config.authorizationUrl, '授权 URL'),
    tokenUrl: validateOAuthUrl(config.tokenUrl, 'Token URL'),
    clientId,
    clientSecret: config.clientSecret,
    scopes: config.scopes?.trim().replace(/\s+/g, ' ') || undefined,
    clientAuth,
    usePkce: config.usePkce !== false,
    extraAuthParams: config.extraAuthParams?.trim() || undefined,
    extraTokenParams: config.extraTokenParams?.trim() || undefined,
  }
}

export function parseOAuthParams(source: string | undefined, reserved: Set<string>, label: string): Record<string, string> {
  if (!source?.trim()) return {}
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new Error(`${label}必须是有效的 JSON 对象`) }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(`${label}必须是 JSON 对象`)
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const normalizedKey = key.trim()
    if (!normalizedKey || reserved.has(normalizedKey)) throw new Error(`${label}不能覆盖保留参数 ${normalizedKey || key}`)
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`${label}中的 ${normalizedKey} 必须是字符串、数字或布尔值`)
    values[normalizedKey] = String(value)
  }
  return values
}

export function createPkceVerifier(): string {
  return randomBytes(48).toString('base64url')
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state).digest('hex')
}

export function buildAuthorizationUrl(config: OAuth2Config, redirectUri: string, state: string, verifier?: string): string {
  const normalized = validateOAuthConfig(config)
  const url = new URL(normalized.authorizationUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', normalized.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  if (normalized.scopes) url.searchParams.set('scope', normalized.scopes)
  if (verifier) {
    url.searchParams.set('code_challenge', pkceChallenge(verifier))
    url.searchParams.set('code_challenge_method', 'S256')
  }
  for (const [key, value] of Object.entries(parseOAuthParams(normalized.extraAuthParams, AUTH_RESERVED, '额外授权参数'))) url.searchParams.set(key, value)
  return url.toString()
}

function clientAuthentication(config: OAuth2Config, params: URLSearchParams, headers: Record<string, string>): void {
  const method = config.clientAuth ?? 'body'
  if (method === 'basic') {
    if (!config.clientSecret) throw new Error('OAuth2 Client Secret 不能为空')
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
    return
  }
  params.set('client_id', config.clientId)
  if (method === 'body') {
    if (!config.clientSecret) throw new Error('OAuth2 Client Secret 不能为空')
    params.set('client_secret', config.clientSecret)
  }
}

export function buildAuthorizationCodeRequest(config: OAuth2Config, code: string, redirectUri: string, verifier?: string): OAuthTokenRequest {
  const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  clientAuthentication(config, params, headers)
  if (verifier) params.set('code_verifier', verifier)
  for (const [key, value] of Object.entries(parseOAuthParams(config.extraTokenParams, TOKEN_RESERVED, '额外 Token 参数'))) params.set(key, value)
  return { url: validateOAuthUrl(config.tokenUrl, 'Token URL'), headers, body: params.toString() }
}

export function buildRefreshTokenRequest(config: OAuth2Config, refreshToken: string): OAuthTokenRequest {
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  clientAuthentication(config, params, headers)
  for (const [key, value] of Object.entries(parseOAuthParams(config.extraTokenParams, TOKEN_RESERVED, '额外 Token 参数'))) params.set(key, value)
  return { url: validateOAuthUrl(config.tokenUrl, 'Token URL'), headers, body: params.toString() }
}

export function parseTokenResponse(source: string, contentType: string | null, previousRefreshToken?: string): OAuthTokenSet {
  let parsed: Record<string, unknown>
  try {
    if (contentType?.includes('json') || source.trim().startsWith('{')) parsed = JSON.parse(source) as Record<string, unknown>
    else parsed = Object.fromEntries(new URLSearchParams(source))
  } catch {
    throw new Error('OAuth2 Token 响应无法解析')
  }
  const error = typeof parsed.error_description === 'string' ? parsed.error_description : typeof parsed.error === 'string' ? parsed.error : ''
  if (error) throw new Error(`OAuth2 Token 请求失败：${error}`)
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new Error('OAuth2 Token 响应缺少 access_token')
  const tokenType = typeof parsed.token_type === 'string' && parsed.token_type ? parsed.token_type : 'Bearer'
  const refreshToken = typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : previousRefreshToken
  if (parsed.access_token.length > 64 * 1024 || /[\r\n]/.test(parsed.access_token)) throw new Error('OAuth2 access_token 无效')
  if (tokenType.length > 128 || /[\r\n]/.test(tokenType)) throw new Error('OAuth2 token_type 无效')
  if (refreshToken && refreshToken.length > 64 * 1024) throw new Error('OAuth2 refresh_token 无效')
  const expiresIn = Number(parsed.expires_in)
  return {
    accessToken: parsed.access_token,
    refreshToken,
    tokenType,
    expiresAt: Number.isFinite(expiresIn) && expiresIn >= 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
  }
}

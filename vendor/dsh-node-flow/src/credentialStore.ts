import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { CredentialHealth, CredentialKind, CredentialSummary, OAuth2ClientAuth } from './model.js'
import {
  buildAuthorizationCodeRequest,
  buildRefreshTokenRequest,
  parseTokenResponse,
  validateOAuthConfig,
  validateOAuthUrl,
  type OAuth2Config,
  type OAuthTokenRequest,
  type OAuthTokenSet,
} from './oauth2.js'

export type OAuth2CredentialSecret = {
  clientSecret?: string
  accessToken?: string
  refreshToken?: string
  tokenType?: string
  tokenScope?: string
}

export type CredentialSecret =
  | { value: string }
  | { username: string; password: string }
  | OAuth2CredentialSecret

export type CredentialInput = {
  id?: string
  name: string
  kind: CredentialKind
  headerName?: string
  testUrl?: string
  authorizationUrl?: string
  tokenUrl?: string
  clientId?: string
  scopes?: string
  clientAuth?: OAuth2ClientAuth
  usePkce?: boolean
  extraAuthParams?: string
  extraTokenParams?: string
  secret?: CredentialSecret
}

type EncryptedValue = { iv: string; tag: string; data: string }
type StoredCredential = CredentialSummary & { secret: EncryptedValue }
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const refreshLocks = new Map<string, Promise<Record<string, string>>>()

function keyFile(dataDirectory: string): string {
  return join(dataDirectory, 'credentials.key')
}

function credentialsFile(dataDirectory: string): string {
  return join(dataDirectory, 'credentials.json')
}

function ensureDirectory(dataDirectory: string): void {
  mkdirSync(dataDirectory, { recursive: true })
}

function loadKey(dataDirectory: string): Buffer {
  ensureDirectory(dataDirectory)
  const file = keyFile(dataDirectory)
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32), { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* Windows ACLs are managed by the user profile. */ }
  }
  const key = readFileSync(file)
  if (key.byteLength !== 32) throw new Error('凭据密钥文件无效')
  return key
}

function readCredentials(dataDirectory: string): StoredCredential[] {
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile(dataDirectory), 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed as StoredCredential[] : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('无法读取凭据存储')
  }
}

function writeCredentials(dataDirectory: string, credentials: StoredCredential[]): void {
  ensureDirectory(dataDirectory)
  const file = credentialsFile(dataDirectory)
  const temporary = `${file}.tmp-${process.pid}`
  const contents = JSON.stringify(credentials, null, 2)
  writeFileSync(temporary, contents, { mode: 0o600 })
  try {
    renameSync(temporary, file)
  } catch {
    writeFileSync(file, contents, { mode: 0o600 })
    try { unlinkSync(temporary) } catch { /* Temporary file already moved or unavailable. */ }
  }
  try { chmodSync(file, 0o600) } catch { /* Windows ACLs are managed by the user profile. */ }
}

function encryptSecret(dataDirectory: string, secret: CredentialSecret): EncryptedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', loadKey(dataDirectory), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function decryptSecret(dataDirectory: string, encrypted: EncryptedValue): CredentialSecret {
  try {
    const decipher = createDecipheriv('aes-256-gcm', loadKey(dataDirectory), Buffer.from(encrypted.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()]).toString('utf8')
    return JSON.parse(plain) as CredentialSecret
  } catch {
    throw new Error('凭据无法解密')
  }
}

function summary(credential: StoredCredential): CredentialSummary {
  const { secret: _secret, ...value } = credential
  if (value.kind === 'oauth2' && value.status === 'authorizing' && value.lastCheckedAt && Date.now() - Date.parse(value.lastCheckedAt) > 10 * 60 * 1000) {
    return { ...value, status: 'error', statusMessage: 'OAuth2 授权窗口已过期，请重新授权' }
  }
  if (value.kind !== 'oauth2' || value.status === 'error' || value.status === 'untested') return value
  const expiresAt = value.expiresAt ? Date.parse(value.expiresAt) : Number.NaN
  if (!Number.isFinite(expiresAt)) return value
  const remaining = expiresAt - Date.now()
  if (remaining <= 0) return { ...value, status: 'expired', statusMessage: 'Access Token 已过期，将在下次使用时尝试刷新' }
  if (remaining <= 5 * 60 * 1000) return { ...value, status: 'expiring', statusMessage: 'Access Token 即将过期' }
  return value
}

function isValueSecret(secret: CredentialSecret | undefined): secret is { value: string } {
  return Boolean(secret && 'value' in secret)
}

function isBasicSecret(secret: CredentialSecret | undefined): secret is { username: string; password: string } {
  return Boolean(secret && 'username' in secret)
}

function oauthSecret(secret: CredentialSecret | undefined): OAuth2CredentialSecret {
  if (!secret || 'value' in secret || 'username' in secret) return {}
  return secret
}

function normalizeOptionalUrl(value: string | undefined, label: string): string | undefined {
  if (!value?.trim()) return undefined
  return validateOAuthUrl(value, label)
}

function replaceCredential(dataDirectory: string, credential: StoredCredential): void {
  const credentials = readCredentials(dataDirectory)
  if (!credentials.some((candidate) => candidate.id === credential.id)) throw new Error('凭据不存在')
  writeCredentials(dataDirectory, [...credentials.filter((candidate) => candidate.id !== credential.id), credential])
}

function oauthDetails(dataDirectory: string, id: string): { stored: StoredCredential; secret: OAuth2CredentialSecret; config: OAuth2Config } {
  const stored = readCredentials(dataDirectory).find((candidate) => candidate.id === id)
  if (!stored) throw new Error('引用的凭据不存在')
  if (stored.kind !== 'oauth2') throw new Error('凭据不是 OAuth2 连接')
  const secret = oauthSecret(decryptSecret(dataDirectory, stored.secret))
  const config = validateOAuthConfig({
    authorizationUrl: stored.authorizationUrl ?? '',
    tokenUrl: stored.tokenUrl ?? '',
    clientId: stored.clientId ?? '',
    clientSecret: secret.clientSecret,
    scopes: stored.scopes,
    clientAuth: stored.clientAuth,
    usePkce: stored.usePkce,
    extraAuthParams: stored.extraAuthParams,
    extraTokenParams: stored.extraTokenParams,
  })
  return { stored, secret, config }
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) throw new Error('OAuth2 Token 响应超过 1 MB 限制')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let source = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('OAuth2 Token 响应超过 1 MB 限制')
    }
    source += decoder.decode(chunk.value, { stream: true })
  }
  return source + decoder.decode()
}

async function requestOAuthToken(request: OAuthTokenRequest, previousRefreshToken: string | undefined, fetcher: Fetcher): Promise<OAuthTokenSet> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('OAuth2 Token 请求超时')), 20_000)
  try {
    const response = await fetcher(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: controller.signal, redirect: 'error' })
    const source = await readLimitedResponse(response, 1024 * 1024)
    try {
      const tokens = parseTokenResponse(source, response.headers.get('content-type'), previousRefreshToken)
      if (!response.ok) throw new Error(`OAuth2 Token 请求失败：HTTP ${response.status}`)
      return tokens
    } catch (error) {
      if (!response.ok && !(error instanceof Error && error.message.startsWith('OAuth2 Token 请求失败'))) {
        throw new Error(`OAuth2 Token 请求失败：HTTP ${response.status}`)
      }
      throw error
    }
  } finally {
    clearTimeout(timer)
  }
}

function saveTokenSet(dataDirectory: string, stored: StoredCredential, secret: OAuth2CredentialSecret, tokens: OAuthTokenSet): CredentialSummary {
  const current = readCredentials(dataDirectory).find((candidate) => candidate.id === stored.id)
  if (!current || current.updatedAt !== stored.updatedAt) throw new Error('OAuth2 配置已更改，请重新授权')
  const now = new Date().toISOString()
  const next: StoredCredential = {
    ...current,
    status: 'connected',
    statusMessage: undefined,
    authorizedAt: current.authorizedAt ?? now,
    expiresAt: tokens.expiresAt,
    secret: encryptSecret(dataDirectory, {
      ...secret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      tokenScope: tokens.scope,
    }),
  }
  replaceCredential(dataDirectory, next)
  return summary(next)
}

function setHealth(dataDirectory: string, id: string, status: CredentialHealth, statusMessage?: string, checked = false, expectedUpdatedAt?: string): CredentialSummary {
  const stored = readCredentials(dataDirectory).find((candidate) => candidate.id === id)
  if (!stored) throw new Error('凭据不存在')
  if (expectedUpdatedAt && stored.updatedAt !== expectedUpdatedAt) throw new Error('连接配置已更改，请重新测试')
  const next: StoredCredential = {
    ...stored,
    status,
    statusMessage: statusMessage?.slice(0, 500) || undefined,
    lastCheckedAt: checked ? new Date().toISOString() : stored.lastCheckedAt,
  }
  replaceCredential(dataDirectory, next)
  return summary(next)
}

function safeOAuthError(error: unknown, secret: OAuth2CredentialSecret): Error {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of [secret.clientSecret, secret.accessToken, secret.refreshToken]) {
    if (value && value.length >= 4) message = message.replaceAll(value, '[已隐藏]')
  }
  return new Error(message.slice(0, 500))
}

export function listCredentialSummaries(dataDirectory: string): CredentialSummary[] {
  return readCredentials(dataDirectory).map(summary).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

export function saveCredential(dataDirectory: string, input: CredentialInput): CredentialSummary {
  const name = input.name.trim()
  if (!name) throw new Error('凭据名称不能为空')
  if (!['bearer', 'api-key', 'basic', 'oauth2', 'webhook-secret'].includes(input.kind)) throw new Error('不支持的凭据类型')
  const credentials = readCredentials(dataDirectory)
  const existing = input.id ? credentials.find((credential) => credential.id === input.id) : undefined
  if (input.id && !existing) throw new Error('凭据不存在')
  if (existing && existing.kind !== input.kind && !input.secret && input.kind !== 'oauth2') throw new Error('切换认证类型时必须填写新的凭据内容')
  const existingSecret = existing ? decryptSecret(dataDirectory, existing.secret) : undefined
  const now = new Date().toISOString()
  const testUrlSource = input.kind === 'webhook-secret' ? undefined : input.testUrl === undefined ? existing?.testUrl : input.testUrl
  const testUrl = normalizeOptionalUrl(testUrlSource, '连接测试 URL')

  if (input.kind === 'oauth2') {
    const previousOAuthSecret = existing?.kind === 'oauth2' ? oauthSecret(existingSecret) : {}
    const suppliedOAuthSecret = oauthSecret(input.secret)
    const clientAuth = input.clientAuth ?? (existing?.kind === 'oauth2' ? existing.clientAuth : undefined) ?? 'body'
    const clientSecret = clientAuth === 'none' ? undefined : suppliedOAuthSecret.clientSecret || previousOAuthSecret.clientSecret
    const config = validateOAuthConfig({
      authorizationUrl: input.authorizationUrl ?? (existing?.kind === 'oauth2' ? existing.authorizationUrl : '') ?? '',
      tokenUrl: input.tokenUrl ?? (existing?.kind === 'oauth2' ? existing.tokenUrl : '') ?? '',
      clientId: input.clientId ?? (existing?.kind === 'oauth2' ? existing.clientId : '') ?? '',
      clientSecret,
      scopes: input.scopes === undefined && existing?.kind === 'oauth2' ? existing.scopes : input.scopes,
      clientAuth,
      usePkce: input.usePkce ?? (existing?.kind === 'oauth2' ? existing.usePkce : true),
      extraAuthParams: input.extraAuthParams === undefined && existing?.kind === 'oauth2' ? existing.extraAuthParams : input.extraAuthParams,
      extraTokenParams: input.extraTokenParams === undefined && existing?.kind === 'oauth2' ? existing.extraTokenParams : input.extraTokenParams,
    })
    const authChanged = !existing || existing.kind !== 'oauth2'
      || existing.authorizationUrl !== config.authorizationUrl
      || existing.tokenUrl !== config.tokenUrl
      || existing.clientId !== config.clientId
      || existing.scopes !== config.scopes
      || existing.clientAuth !== config.clientAuth
      || existing.usePkce !== config.usePkce
      || existing.extraAuthParams !== config.extraAuthParams
      || existing.extraTokenParams !== config.extraTokenParams
      || Boolean(suppliedOAuthSecret.clientSecret && suppliedOAuthSecret.clientSecret !== previousOAuthSecret.clientSecret)
    const testChanged = existing?.testUrl !== testUrl
    const secret: OAuth2CredentialSecret = authChanged ? { clientSecret: config.clientSecret } : { ...previousOAuthSecret, clientSecret: config.clientSecret }
    const stored: StoredCredential = {
      id: existing?.id ?? randomUUID(),
      name,
      kind: 'oauth2',
      testUrl,
      authorizationUrl: config.authorizationUrl,
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      scopes: config.scopes,
      clientAuth: config.clientAuth,
      usePkce: config.usePkce,
      extraAuthParams: config.extraAuthParams,
      extraTokenParams: config.extraTokenParams,
      status: authChanged || testChanged ? 'untested' : existing.status ?? 'untested',
      statusMessage: authChanged && existing ? 'OAuth2 配置已更新，请重新授权' : testChanged ? '测试 URL 已更新，请重新测试连接' : authChanged ? undefined : existing.statusMessage,
      lastCheckedAt: authChanged || testChanged ? undefined : existing.lastCheckedAt,
      authorizedAt: authChanged ? undefined : existing.authorizedAt,
      expiresAt: authChanged ? undefined : existing.expiresAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      secret: encryptSecret(dataDirectory, secret),
    }
    writeCredentials(dataDirectory, [...credentials.filter((credential) => credential.id !== stored.id), stored])
    return summary(stored)
  }

  if (!existing && !input.secret) throw new Error('必须填写凭据内容')
  if (input.kind === 'bearer' || input.kind === 'api-key' || input.kind === 'webhook-secret') {
    if (input.secret && (!isValueSecret(input.secret) || !input.secret.value)) throw new Error('凭据内容不能为空')
  }
  if (input.kind === 'webhook-secret' && input.secret && isValueSecret(input.secret) && input.secret.value.length < 16) {
    throw new Error('Webhook Secret 至少需要 16 个字符')
  }
  if (input.kind === 'basic' && input.secret && (!isBasicSecret(input.secret) || !input.secret.username || !input.secret.password)) {
    throw new Error('用户名和密码不能为空')
  }
  const secret = input.secret ?? existingSecret
  if (!secret) throw new Error('必须填写凭据内容')
  const headerName = input.kind === 'api-key'
    ? input.headerName?.trim() || (existing?.kind === 'api-key' ? existing.headerName : undefined) || 'X-API-Key'
    : undefined
  const changed = !existing || existing.kind !== input.kind || Boolean(input.secret) || existing.headerName !== headerName || existing.testUrl !== testUrl
  const stored: StoredCredential = {
    id: existing?.id ?? randomUUID(),
    name,
    kind: input.kind,
    headerName,
    testUrl,
    status: input.kind === 'webhook-secret' ? 'connected' : changed ? 'untested' : existing.status ?? 'untested',
    statusMessage: input.kind === 'webhook-secret' ? '密钥已加密保存' : undefined,
    lastCheckedAt: changed ? undefined : existing.lastCheckedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    secret: encryptSecret(dataDirectory, secret),
  }
  writeCredentials(dataDirectory, [...credentials.filter((credential) => credential.id !== stored.id), stored])
  return summary(stored)
}

export function deleteCredential(dataDirectory: string, id: string): boolean {
  const credentials = readCredentials(dataDirectory)
  const next = credentials.filter((credential) => credential.id !== id)
  if (next.length === credentials.length) return false
  writeCredentials(dataDirectory, next)
  return true
}

export function getOAuthAuthorizationConfig(dataDirectory: string, id: string): { summary: CredentialSummary; config: OAuth2Config; updatedAt: string } {
  const { stored, config } = oauthDetails(dataDirectory, id)
  return { summary: summary(stored), config, updatedAt: stored.updatedAt }
}

export function markCredentialAuthorizing(dataDirectory: string, id: string): CredentialSummary {
  return setHealth(dataDirectory, id, 'authorizing', '等待 OAuth2 服务商授权', true)
}

export function markCredentialAuthorizationFailed(dataDirectory: string, id: string, message: string): CredentialSummary {
  return setHealth(dataDirectory, id, 'error', message, true)
}

export function cancelCredentialAuthorization(dataDirectory: string, id: string): CredentialSummary {
  const stored = readCredentials(dataDirectory).find((candidate) => candidate.id === id)
  if (!stored) throw new Error('凭据不存在')
  if (stored.status !== 'authorizing') return summary(stored)
  return setHealth(dataDirectory, id, 'error', 'OAuth2 授权窗口已关闭', true)
}

export async function exchangeOAuthAuthorizationCode(
  dataDirectory: string,
  id: string,
  code: string,
  redirectUri: string,
  verifier: string | undefined,
  expectedUpdatedAt: string,
  fetcher: Fetcher = fetch,
): Promise<CredentialSummary> {
  const { stored, secret, config } = oauthDetails(dataDirectory, id)
  if (stored.updatedAt !== expectedUpdatedAt) throw new Error('OAuth2 配置已更改，请重新授权')
  try {
    const tokens = await requestOAuthToken(buildAuthorizationCodeRequest(config, code, redirectUri, verifier), secret.refreshToken, fetcher)
    return saveTokenSet(dataDirectory, stored, secret, tokens)
  } catch (error) {
    const safe = safeOAuthError(error, secret)
    if (!safe.message.includes('配置已更改')) setHealth(dataDirectory, id, 'error', safe.message)
    throw safe
  }
}

async function refreshOAuthCredential(dataDirectory: string, id: string, fetcher: Fetcher): Promise<Record<string, string>> {
  const { stored, secret, config } = oauthDetails(dataDirectory, id)
  if (!secret.refreshToken) {
    setHealth(dataDirectory, id, 'expired', 'Access Token 已过期且没有 Refresh Token，请重新授权')
    throw new Error('OAuth2 授权已过期，请重新授权')
  }
  try {
    const tokens = await requestOAuthToken(buildRefreshTokenRequest(config, secret.refreshToken), secret.refreshToken, fetcher)
    saveTokenSet(dataDirectory, stored, secret, tokens)
    return { Authorization: `${tokens.tokenType} ${tokens.accessToken}` }
  } catch (error) {
    const safe = safeOAuthError(error, secret)
    if (!safe.message.includes('配置已更改')) setHealth(dataDirectory, id, 'error', safe.message)
    throw safe
  }
}

export async function resolveCredentialHeaders(dataDirectory: string, id: string, fetcher: Fetcher = fetch, forceRefresh = false): Promise<Record<string, string> | undefined> {
  const credential = readCredentials(dataDirectory).find((candidate) => candidate.id === id)
  if (!credential) throw new Error('引用的凭据不存在')
  const secret = decryptSecret(dataDirectory, credential.secret)
  if (credential.kind === 'bearer' && isValueSecret(secret)) return forceRefresh ? undefined : { Authorization: `Bearer ${secret.value}` }
  if (credential.kind === 'api-key' && isValueSecret(secret)) return forceRefresh ? undefined : { [credential.headerName || 'X-API-Key']: secret.value }
  if (credential.kind === 'basic' && isBasicSecret(secret)) {
    return forceRefresh ? undefined : { Authorization: `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString('base64')}` }
  }
  if (credential.kind === 'oauth2') {
    const oauth = oauthSecret(secret)
    const expiresAt = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.POSITIVE_INFINITY
    if (!forceRefresh && oauth.accessToken && (!Number.isFinite(expiresAt) || expiresAt - Date.now() > 60_000)) {
      return { Authorization: `${oauth.tokenType || 'Bearer'} ${oauth.accessToken}` }
    }
    const lockKey = `${dataDirectory}\u0000${id}`
    const active = refreshLocks.get(lockKey)
    if (active) return active
    const refresh = refreshOAuthCredential(dataDirectory, id, fetcher).finally(() => refreshLocks.delete(lockKey))
    refreshLocks.set(lockKey, refresh)
    return refresh
  }
  throw new Error('凭据内容与类型不匹配')
}

export function resolveWebhookSecret(dataDirectory: string, id: string): string {
  const credential = readCredentials(dataDirectory).find((candidate) => candidate.id === id)
  if (!credential) throw new Error('引用的 Webhook Secret 不存在')
  if (credential.kind !== 'webhook-secret') throw new Error('Webhook 验签必须使用 Webhook Secret 凭据')
  const secret = decryptSecret(dataDirectory, credential.secret)
  if (!isValueSecret(secret) || secret.value.length < 16) throw new Error('Webhook Secret 凭据内容无效')
  return secret.value
}

export async function testCredentialConnection(dataDirectory: string, id: string, fetcher: Fetcher = fetch): Promise<CredentialSummary> {
  const credential = readCredentials(dataDirectory).find((candidate) => candidate.id === id)
  if (!credential) throw new Error('凭据不存在')
  if (credential.kind === 'webhook-secret') throw new Error('Webhook Secret 无需连接测试')
  if (!credential.testUrl) throw new Error('请先填写连接测试 URL')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('连接测试超时')), 20_000)
  try {
    const headers = await resolveCredentialHeaders(dataDirectory, id, fetcher)
    let response = await fetcher(credential.testUrl, { method: 'GET', headers, signal: controller.signal, redirect: 'error' })
    if (response.status === 401) {
      const refreshed = await resolveCredentialHeaders(dataDirectory, id, fetcher, true)
      if (refreshed) {
        await response.body?.cancel().catch(() => {})
        response = await fetcher(credential.testUrl, { method: 'GET', headers: refreshed, signal: controller.signal, redirect: 'error' })
      }
    }
    await response.body?.cancel().catch(() => {})
    if (!response.ok) throw new Error(`连接测试失败：HTTP ${response.status}`)
    return setHealth(dataDirectory, id, 'connected', `连接测试成功：HTTP ${response.status}`, true, credential.updatedAt)
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('配置已更改'))) {
      setHealth(dataDirectory, id, 'error', error instanceof Error ? error.message : String(error), true, credential.updatedAt)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

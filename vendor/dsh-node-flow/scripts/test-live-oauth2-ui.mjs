import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const credentialName = `__oauth2_ui_${suffix}`
const clientSecret = `ui-secret-${suffix}`
let authorizationRequests = 0
let codeExchanges = 0
let resourceRequests = 0

const provider = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
  if (requestUrl.pathname === '/authorize') {
    authorizationRequests += 1
    const redirect = new URL(requestUrl.searchParams.get('redirect_uri'))
    redirect.searchParams.set('code', `ui-code-${suffix}`)
    redirect.searchParams.set('state', requestUrl.searchParams.get('state') || '')
    response.writeHead(302, { location: redirect.toString() })
    response.end()
    return
  }
  if (requestUrl.pathname === '/token') {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
    if (body.get('grant_type') !== 'authorization_code' || body.get('client_secret') !== clientSecret) {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end('{"error":"invalid_grant"}')
      return
    }
    codeExchanges += 1
    response.setHeader('content-type', 'application/json')
    response.end(`{"access_token":"ui-access-${suffix}","refresh_token":"ui-refresh-${suffix}","expires_in":3600,"token_type":"Bearer"}`)
    return
  }
  if (requestUrl.pathname === '/me') {
    resourceRequests += 1
    const authorized = request.headers.authorization === `Bearer ui-access-${suffix}`
    response.statusCode = authorized ? 200 : 401
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ authorized }))
    return
  }
  response.statusCode = 404
  response.end('not found')
})

const executableCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const executablePath = executableCandidates.find(existsSync)
if (!executablePath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium-compatible browser')

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

let browser
const browserErrors = []
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
try {
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('OAuth2 UI provider did not expose a TCP port')
  const providerUrl = `http://127.0.0.1:${address.port}`
  const health = await requestJson('/dsh-node-flow/workflows')
  if (health.capabilities?.oauth2 !== true || health.capabilities?.connectionTesting !== true) throw new Error('Running DSH backend does not expose OAuth2 capabilities')
  await cleanup()

  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  else await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  const entry = page.locator('[data-dsh-node-flow-entry]')
  await entry.waitFor({ state: 'visible', timeout: 15_000 })
  await entry.click()
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('button', { name: '新建连接', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建连接' })
  await dialog.getByLabel('名称').fill(credentialName)
  await dialog.getByLabel('认证类型').selectOption('oauth2')
  if (await dialog.getByLabel('回调 URL').inputValue() !== `${baseUrl}/dsh-node-flow/oauth2/callback`) throw new Error('Live OAuth2 callback URL is incorrect')
  await dialog.getByLabel('授权 URL').fill(`${providerUrl}/authorize`)
  await dialog.getByLabel('Token URL').fill(`${providerUrl}/token`)
  await dialog.getByLabel('Client ID').fill(`ui-client-${suffix}`)
  await dialog.getByLabel('Client Secret').fill(clientSecret)
  await dialog.getByLabel('Scopes').fill('read offline_access')
  await dialog.getByLabel('连接测试 URL').fill(`${providerUrl}/me`)
  await dialog.getByRole('button', { name: '保存并授权' }).click()
  await page.getByText(credentialName, { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.wf-credential-health.is-connected').filter({ hasText: '连接正常' }).waitFor({ state: 'visible', timeout: 15_000 })
  if (authorizationRequests !== 1 || codeExchanges !== 1) throw new Error(`Live OAuth2 authorization failed: ${JSON.stringify({ authorizationRequests, codeExchanges })}`)

  const listed = await requestJson('/dsh-node-flow/credentials')
  const serialized = JSON.stringify(listed)
  if ([clientSecret, `ui-access-${suffix}`, `ui-refresh-${suffix}`].some((secret) => serialized.includes(secret))) throw new Error('Live OAuth2 secrets leaked through the API')
  await page.getByRole('button', { name: `测试 ${credentialName}` }).click()
  await page.getByText('连接测试成功：HTTP 200', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  if (resourceRequests !== 1) throw new Error(`Expected one live OAuth2 connection test, received ${resourceRequests}`)
  await page.getByRole('button', { name: `编辑 ${credentialName}` }).click()
  const editDialog = page.getByRole('dialog', { name: '编辑连接' })
  if (await editDialog.getByLabel('Client Secret').inputValue()) throw new Error('Live OAuth2 Client Secret was disclosed while editing')
  await editDialog.getByRole('button', { name: '关闭' }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Live OAuth2 page overflowed: ${JSON.stringify(metrics)}`)
  page.once('dialog', (confirmation) => confirmation.accept())
  await page.getByRole('button', { name: `删除 ${credentialName}` }).click()
  await page.getByText(credentialName, { exact: true }).waitFor({ state: 'hidden' })
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, authorizationRequests, codeExchanges, resourceRequests, secretHidden: true, mobileOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => {})
  await cleanup().catch(() => {})
  await new Promise((resolve) => provider.close(() => resolve()))
}

import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const name = `Live API Key ${Date.now()}`
const secret = `live-secret-${Date.now()}`
const browserErrors = []
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

async function openDshPage(page) {
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
}

async function cleanup() {
  const data = await requestJson('/dsh-node-flow/credentials')
  const matching = (data.credentials || []).filter((credential) => credential.name === name)
  for (const credential of matching) {
    await requestJson('/dsh-node-flow/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ action: 'delete', id: credential.id }),
    })
  }
}

let browser
try {
  const health = await requestJson('/dsh-node-flow/workflows')
  if (health.capabilities?.credentials !== true || health.capabilities?.nodeTesting !== true) {
    throw new Error('The running DSH node-flow backend does not expose integration capabilities')
  }
  await cleanup()
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await openDshPage(page)
  const entry = page.locator('[data-dsh-node-flow-entry]')
  await entry.waitFor({ state: 'visible', timeout: 15_000 })
  await entry.click()
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('heading', { name: '连接', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '新建连接', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '新建连接' })
  await dialog.getByLabel('名称').fill(name)
  await dialog.getByLabel('认证类型').selectOption('api-key')
  await dialog.getByLabel('Header 名称').fill('X-Live-Test-Key')
  await dialog.getByRole('textbox', { name: 'API Key' }).fill(secret)
  await dialog.getByRole('button', { name: '保存连接' }).click()
  await page.getByText(name, { exact: true }).waitFor({ state: 'visible' })
  if (await page.getByText(secret, { exact: true }).count()) throw new Error('Credential secret was rendered in the UI')
  const listed = await requestJson('/dsh-node-flow/credentials')
  if (JSON.stringify(listed).includes(secret)) throw new Error('Credential secret leaked through the API')
  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Credential page overflowed: ${JSON.stringify(metrics)}`)
  page.once('dialog', (confirmation) => confirmation.accept())
  await page.getByRole('button', { name: `删除 ${name}` }).click()
  await page.getByText(name, { exact: true }).waitFor({ state: 'hidden' })
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, credentialUi: true, secretHidden: true, mobileOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => {})
  await cleanup().catch(() => {})
}

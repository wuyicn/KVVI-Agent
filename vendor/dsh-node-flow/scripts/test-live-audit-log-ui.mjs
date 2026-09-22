import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const browserErrors = []
const requestedAuditUrls = []
const executableCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const executablePath = executableCandidates.find(existsSync)
if (!executablePath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium-compatible browser')

const events = [
  { id: 'audit-ui-workflow', at: '2026-09-05T00:00:00.000Z', actor: 'local-user', action: 'workflow.published', target: { type: 'workflow', id: 'workflow-ui', name: 'Audit UI Flow' }, details: { revision: 4, publishedRevision: 3 } },
  { id: 'audit-ui-variable', at: '2026-09-05T00:01:00.000Z', actor: 'system', action: 'variable.created', target: { type: 'variable', id: 'variable-ui', name: 'AUDIT_UI_FLAG' }, details: { kind: 'plain' } },
]

async function openDshPage(page) {
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
}

let browser
try {
  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await page.route('**/dsh-node-flow/audit-log**', async (route) => {
    const url = new URL(route.request().url())
    requestedAuditUrls.push(url.toString())
    const targetType = url.searchParams.get('targetType')
    const visible = targetType ? events.filter((event) => event.target.type === targetType) : events
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events: visible }) })
  })
  await openDshPage(page)
  const entry = page.locator('[data-dsh-node-flow-entry]')
  await entry.waitFor({ state: 'visible', timeout: 15_000 })
  if (await entry.count() !== 1) throw new Error(`Expected one node-flow entry, found ${await entry.count()}`)
  await entry.click()
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '审计日志', exact: true }).click()
  await page.getByRole('heading', { name: '审计日志', exact: true }).waitFor({ state: 'visible' })
  await page.getByText('发布工作流', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('Audit UI Flow', { exact: true }).waitFor({ state: 'visible' })
  await page.getByLabel('审计对象筛选').selectOption('variable')
  await page.getByText('创建变量', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('发布工作流', { exact: true }).waitFor({ state: 'hidden' })
  await page.getByLabel('筛选审计日志').fill('does-not-match')
  await page.getByText('没有匹配的审计记录', { exact: true }).waitFor({ state: 'visible' })
  await page.getByLabel('筛选审计日志').fill('AUDIT_UI_FLAG')
  await page.getByText('AUDIT_UI_FLAG', { exact: true }).waitFor({ state: 'visible' })
  const requestsBeforeRefresh = requestedAuditUrls.length
  const refreshRequest = page.waitForRequest((request) => {
    const url = new URL(request.url())
    return url.pathname === '/dsh-node-flow/audit-log' && url.searchParams.get('targetType') === 'variable'
  })
  await page.getByRole('button', { name: '刷新审计日志', exact: true }).click()
  await refreshRequest
  if (requestedAuditUrls.length <= requestsBeforeRefresh || !requestedAuditUrls.some((url) => url.includes('targetType=variable'))) {
    throw new Error(`Audit panel did not refresh/filter through the host endpoint: ${JSON.stringify(requestedAuditUrls)}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Audit page overflowed: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, auditNavigation: true, hostFilter: true, refresh: true, mobileOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
}

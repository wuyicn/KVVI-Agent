import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-resilience-ui-${suffix}`
const workflowName = `Live Resilience UI ${suffix}`
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

async function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

async function openDshPage(page) {
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
}

async function cleanup() {
  const data = await requestJson('/dsh-node-flow/workflows').catch(() => ({ workflows: [] }))
  const workflow = (data.workflows || []).find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => {})
}

let browser
try {
  await cleanup()
  const now = new Date().toISOString()
  await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: {
      id: workflowId,
      name: workflowName,
      status: 'disabled',
      revision: 0,
      draftRevision: 0,
      createdAt: now,
      updatedAt: now,
      doc: {
        version: 1,
        name: workflowName,
        nodes: [
          { id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: '开始' }, style: { width: 224, height: 76 } },
          { id: 'code', type: 'workflow', position: { x: 380, y: 180 }, data: { kind: 'code', label: '可靠代码', code: 'return "ok"', retryCount: '2', retryDelay: '1.5', retryBackoff: 'exponential', onError: 'route' }, style: { width: 224, height: 82 } },
          { id: 'output', type: 'workflow', position: { x: 680, y: 180 }, data: { kind: 'output', label: '映射输出', template: '用户：' }, style: { width: 224, height: 82 } },
        ],
        edges: [
          { id: 'edge', source: 'trigger', target: 'code', type: 'workflow' },
          { id: 'edge-output', source: 'code', target: 'output', type: 'workflow' },
          { id: 'edge-error', source: 'code', sourceHandle: 'error', target: 'output', type: 'workflow' },
        ],
      },
    },
  })

  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await openDshPage(page)
  const entry = page.locator('[data-dsh-node-flow-entry]')
  await entry.waitFor({ state: 'visible', timeout: 15_000 })
  if (await entry.count() !== 1) throw new Error(`Expected one node-flow entry, found ${await entry.count()}`)
  await entry.click()
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible' })
  await page.locator('.wf-workflow-name').filter({ hasText: workflowName }).click()
  const canvasPane = page.locator('.react-flow__pane')
  await canvasPane.waitFor({ state: 'visible' })
  if (await canvasPane.evaluate((element) => getComputedStyle(element).cursor) !== 'default') throw new Error('Canvas pointer was not visible on hover')
  const paneBox = await canvasPane.boundingBox()
  if (!paneBox) throw new Error('Canvas pane has no visible bounds')
  await page.mouse.move(paneBox.x + paneBox.width * 0.8, paneBox.y + paneBox.height * 0.8)
  await page.mouse.down()
  await page.mouse.move(paneBox.x + paneBox.width * 0.8 + 20, paneBox.y + paneBox.height * 0.8 + 10)
  if (await canvasPane.evaluate((element) => getComputedStyle(element).cursor) !== 'move') throw new Error('Canvas pointer disappeared while panning')
  await page.mouse.up()
  await page.locator('.react-flow__node').filter({ hasText: '可靠代码' }).click()
  if (await page.getByLabel('重试次数').inputValue() !== '2') throw new Error('Retry count was not rendered')
  if (await page.getByLabel('间隔（秒）').inputValue() !== '1.5') throw new Error('Retry delay was not rendered')
  if (await page.getByLabel('退避策略').inputValue() !== 'exponential') throw new Error('Retry backoff was not rendered')
  if (await page.getByLabel('失败时行为').inputValue() !== 'route') throw new Error('Error-route behavior was not rendered')
  const codeNode = page.locator('.react-flow__node[data-id="code"]')
  await codeNode.locator('.wf-handle--error').waitFor({ state: 'visible' })
  await page.getByLabel('失败时行为').selectOption('stop')
  await page.getByText('该节点保留了 error 连线，但当前策略不会执行它；切换回“路由到错误分支”后才会启用。', { exact: true }).waitFor({ state: 'visible' })
  await page.getByLabel('失败时行为').selectOption('route')
  await codeNode.locator('.wf-handle--error').waitFor({ state: 'visible' })
  await page.locator('.react-flow__node').filter({ hasText: '映射输出' }).click()
  const sample = JSON.stringify({ user: { id: 'live-user', active: true }, items: [{ sku: 'sku-live' }] })
  await page.getByLabel('测试输入').fill(sample)
  await page.getByRole('button', { name: '映射Template字段', exact: true }).click()
  await page.getByLabel('字段映射器', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.wf-mapper-field').filter({ hasText: 'result.user.id' }).click()
  if (await page.getByRole('textbox', { name: 'Template', exact: true }).inputValue() !== '用户：{{result.user.id}}') throw new Error('Nested field mapping did not insert into the live UI')
  await page.getByRole('button', { name: '关闭字段映射器' }).click()
  await page.getByRole('button', { name: '返回工作流' }).click()
  await page.getByRole('button', { name: '运行记录', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Run history overflowed: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, retryFields: true, errorRouteUI: true, nestedFieldMapping: true, mobileRunHistoryOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => {})
  await cleanup()
}

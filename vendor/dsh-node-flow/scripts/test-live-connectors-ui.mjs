import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-connector-ui-${suffix}`
const workflowName = `Live Connector UI ${suffix}`
const credentialName = `__connector_ui_${suffix}`
const browserErrors = []
const executableCandidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean)
const executablePath = executableCandidates.find(existsSync)
if (!executablePath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium-compatible browser')

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function post(path, body) {
  return requestJson(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify(body) })
}

async function currentWorkflow() {
  const data = await requestJson('/dsh-node-flow/workflows')
  return (data.workflows || []).find((workflow) => workflow.id === workflowId)
}

async function cleanup() {
  const workflow = await currentWorkflow().catch(() => undefined)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
  const listed = await requestJson('/dsh-node-flow/credentials').catch(() => ({ credentials: [] }))
  for (const credential of listed.credentials || []) if (credential.name === credentialName) await post('/dsh-node-flow/credentials', { action: 'delete', id: credential.id }).catch(() => undefined)
}

async function waitForConnector() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const workflow = await currentWorkflow()
    const node = workflow?.doc?.nodes?.find((candidate) => candidate.data?.kind === 'connector')
    if (node?.data?.connectorParams?.title === 'Issue {{result.user.id}}') return { workflow, node }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for connector configuration save')
}

async function waitForSlackConnector() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const workflow = await currentWorkflow()
    const node = workflow?.doc?.nodes?.find((candidate) => candidate.data?.kind === 'connector')
    if (node?.data?.connectorId === 'slack' && node.data.connectorParams?.channel === 'C2' && node.data.connectorParams?.text === 'dynamic message') return { workflow, node }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for dynamic connector configuration save')
}

async function waitForPollingTrigger() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const workflow = await currentWorkflow()
    const node = workflow?.doc?.nodes?.find((candidate) => candidate.data?.kind === 'connector-trigger')
    if (node?.data?.connectorParams?.repo === 'dsh-node-flow' && node.data.pollInterval === '30') return { workflow, node }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for polling trigger configuration save')
}

async function openDshPage(page) {
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  else await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
}

let browser
try {
  await cleanup()
  const health = await requestJson('/dsh-node-flow/workflows')
  if (health.capabilities?.connectors !== true || health.capabilities?.pollingTriggers !== true) throw new Error('Running backend does not expose connector trigger capabilities')
  const catalog = await requestJson('/dsh-node-flow/connectors')
  if (catalog.connectors?.length !== 16) throw new Error(`Expected 16 connectors, received ${catalog.connectors?.length}`)
  const credential = await post('/dsh-node-flow/credentials', { action: 'save', credential: { name: credentialName, kind: 'bearer', secret: { value: 'live-connector-secret' } } })
  const credentialId = credential.credential?.id
  if (!credentialId || JSON.stringify(credential).includes('live-connector-secret')) throw new Error('Connector credential save leaked a secret')
  const createdAt = new Date().toISOString()
  await post('/dsh-node-flow/workflows', {
    action: 'save', expectedRevision: 0,
    workflow: { id: workflowId, name: workflowName, status: 'disabled', revision: 0, draftRevision: 0, createdAt, updatedAt: createdAt, doc: { version: 1, name: workflowName, nodes: [{ id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: '开始' }, style: { width: 224, height: 76 } }], edges: [] } },
  })

  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.route('**/dsh-node-flow/connectors', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON()
    if (body?.fieldId !== 'channel') return route.continue()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ options: [{ value: 'C1', label: '#general' }, { value: 'C2', label: '#alerts' }] }) })
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  const openWorkflow = async () => {
    await openDshPage(page)
    const entry = page.locator('[data-dsh-node-flow-entry]')
    await entry.waitFor({ state: 'visible', timeout: 15_000 })
    if (await entry.count() !== 1) throw new Error(`Expected one node-flow entry, found ${await entry.count()}`)
    await entry.click()
    await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('.wf-workflow-name').filter({ hasText: workflowName }).click()
    await page.locator('.wf-name').waitFor({ state: 'visible' })
  }
  await openWorkflow()
  await page.getByRole('button', { name: /节点库/ }).first().click()
  await page.getByRole('button', { name: '应用连接器 调用 GitHub、Slack、Notion 等应用动作' }).click()
  await page.getByLabel('应用').selectOption('github')
  await page.getByLabel('连接', { exact: true }).selectOption(credentialId)
  await page.getByRole('textbox', { name: '仓库所有者', exact: true }).fill('luxi233')
  await page.getByRole('textbox', { name: '仓库名', exact: true }).fill('dsh-node-flow')
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('Issue ')
  await page.getByLabel('测试输入').fill('{"user":{"id":"live-42"}}')
  await page.getByRole('textbox', { name: '标题', exact: true }).press('End')
  await page.getByRole('button', { name: '映射标题字段', exact: true }).click()
  await page.locator('.wf-mapper-field').filter({ hasText: 'result.user.id' }).click()
  await page.getByRole('button', { name: '关闭字段映射器' }).click()
  const saved = await waitForConnector()
  if (saved.node.data.connectorId !== 'github' || saved.node.data.connectorVersion !== 1 || saved.node.data.connectorAction !== 'create-issue' || saved.node.data.credentialId !== credentialId) throw new Error('Versioned connector configuration was not persisted')
  await page.getByLabel('应用').selectOption('slack')
  await page.getByLabel('连接', { exact: true }).selectOption(credentialId)
  await page.getByRole('button', { name: '加载频道 ID选项', exact: true }).click()
  await page.getByText('2 个可用选项', { exact: true }).waitFor({ state: 'visible' })
  const channel = page.getByRole('combobox', { name: '频道 ID', exact: true })
  const options = await channel.evaluate((element) => Array.from(element.list?.options ?? []).map((option) => ({ value: option.value, label: option.label })))
  if (JSON.stringify(options) !== JSON.stringify([{ value: 'C1', label: '#general' }, { value: 'C2', label: '#alerts' }])) throw new Error(`Dynamic connector datalist was not populated: ${JSON.stringify(options)}`)
  await channel.fill('C2')
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('dynamic message')
  const slack = await waitForSlackConnector()
  if (slack.node.data.connectorVersion !== 1) throw new Error('Slack connector version was not pinned')

  await page.getByRole('button', { name: /节点库/ }).first().click()
  await page.getByRole('button', { name: '应用触发器 轮询应用并在新事件到达时运行' }).click()
  await page.getByText('App Trigger', { exact: true }).waitFor({ state: 'visible' })
  await page.getByLabel('应用').selectOption('github')
  await page.getByLabel('连接', { exact: true }).selectOption(credentialId)
  await page.getByRole('textbox', { name: '仓库所有者', exact: true }).fill('luxi233')
  await page.getByRole('textbox', { name: '仓库名', exact: true }).fill('dsh-node-flow')
  await page.getByLabel('轮询间隔（秒）').fill('30')
  if (await page.getByRole('button', { name: '测试此节点' }).count()) throw new Error('Polling trigger exposed a single-node test action')
  const polling = await waitForPollingTrigger()
  await page.getByText('尚未发布', { exact: true }).waitFor({ state: 'visible' })

  await openWorkflow()
  await page.locator(`.react-flow__node[data-id="${polling.node.id}"]`).evaluate((element) => element.click())
  await page.getByLabel('应用').locator('option[value="github"]').waitFor({ state: 'attached' })
  await page.getByRole('textbox', { name: '仓库名', exact: true }).waitFor({ state: 'visible' })
  if (await page.getByLabel('应用').inputValue() !== 'github' || await page.getByLabel('事件').inputValue() !== 'new-issue' || await page.getByRole('textbox', { name: '仓库名', exact: true }).inputValue() !== 'dsh-node-flow' || await page.getByLabel('轮询间隔（秒）').inputValue() !== '30') throw new Error('Polling trigger configuration did not survive reload')
  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Connector editor overflowed on mobile: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, connectors: catalog.connectors.length, actionsPersisted: true, connectorVersionPinned: true, dynamicOptions: true, pollingPersisted: true, mapped: true, secretHidden: true, mobileOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
  await cleanup().catch(() => undefined)
}

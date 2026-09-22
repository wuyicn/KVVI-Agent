import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-workflow-inputs-ui-${suffix}`
const workflowName = `Live Workflow Inputs UI ${suffix}`
const marker = `ui-customer-${suffix}`
const runIds = new Set()
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
  return { response, data }
}

function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

function documentOf() {
  return {
    version: 1,
    name: workflowName,
    inputs: [
      { name: 'customer', label: '客户', type: 'object', required: true },
      { name: 'count', label: '数量', type: 'number', required: true },
      { name: 'enabled', label: '启用', type: 'boolean', required: true },
      { name: 'labels', label: '标签', type: 'array' },
    ],
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 160 }, data: { kind: 'trigger', label: '开始' } },
      { id: 'output', type: 'workflow', position: { x: 390, y: 160 }, data: { kind: 'output', label: '输出', template: '{{result.customer.id}}|{{result.count}}|{{result.enabled}}|{{result.labels[0]}}' } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'output', type: 'workflow' }],
  }
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) {
    if (runIds.has(run.id) || run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  const workflow = workflows.data.workflows?.find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflow.id, expectedRevision: workflow.revision }).catch(() => undefined)
}

async function openDshPage(page) {
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  else await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
}

let browser
try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.data.capabilities?.directRun !== true || capabilities.data.capabilities?.workflowInputContracts !== true) throw new Error('Running backend does not expose workflow input contracts')
  const now = new Date().toISOString()
  const created = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: { id: workflowId, name: workflowName, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc: documentOf() },
  })
  if (!created.response.ok || !created.data.workflow) throw new Error(created.data.error || 'Could not create workflow input UI fixture')

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
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })

  const row = page.locator('.wf-workflow-row').filter({ hasText: workflowName })
  await row.waitFor({ state: 'visible' })
  await row.getByRole('button', { name: `运行 ${workflowName}`, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '运行工作流' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByText('使用当前草稿的输入契约', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: '开始运行', exact: true }).click()
  await dialog.getByRole('alert').getByText('缺少必填字段“客户”', { exact: false }).waitFor({ state: 'visible' })

  await dialog.getByLabel('运行输入 客户').fill(`{"id":"${marker}"}`)
  await dialog.getByLabel('运行输入 数量').fill('7')
  await dialog.getByLabel('运行输入 启用').selectOption('false')
  await dialog.getByLabel('运行输入 标签').fill('["priority"]')
  await dialog.getByRole('button', { name: '开始运行', exact: true }).click()
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 })

  const runs = await requestJson('/dsh-node-flow/runs')
  const completed = runs.data.runs?.find((run) => run.workflowId === workflowId)
  if (!completed || completed.status !== 'ok' || completed.value !== `${marker}|7|false|priority`) {
    throw new Error(`Input dialog did not submit typed values: ${JSON.stringify(completed)}`)
  }
  runIds.add(completed.id)

  await row.getByRole('button', { name: `运行 ${workflowName}`, exact: true }).click()
  await dialog.waitFor({ state: 'visible' })
  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Workflow input dialog overflowed on mobile: ${JSON.stringify(metrics)}`)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })

  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, requiredValidation: true, typedInput: true, mobileOverflow: false, oneEntry: true }, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
  await cleanup().catch(() => undefined)
}

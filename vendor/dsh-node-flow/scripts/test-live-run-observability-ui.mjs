import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-run-observability-ui-${suffix}`
const workflowName = `Live Run Observability UI ${suffix}`
const sourceRunId = `live-run-observability-source-${suffix}`
const marker = `observability-input-${suffix}`
const browserErrors = []
const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync)

if (!executablePath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium-compatible browser')

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

function documentOf(template = '{{result.label}}') {
  return {
    version: 1,
    name: workflowName,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: '开始' } },
      { id: 'output', type: 'workflow', position: { x: 380, y: 180 }, data: { kind: 'output', label: '输出', template } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'output', type: 'workflow' }],
  }
}

async function openDshPage(page) {
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  else await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ runs: [] }))
  for (const run of runs.runs ?? []) {
    if (run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ workflows: [] }))
  const workflow = workflows.workflows?.find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
}

let browser
try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.capabilities?.runDetails !== true || capabilities.capabilities?.runReplay !== true) {
    throw new Error('The running DSH node-flow backend does not expose run detail/replay capabilities')
  }

  const now = new Date().toISOString()
  const created = await post('/dsh-node-flow/workflows', {
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
      doc: documentOf(),
    },
  })
  const source = await post('/dsh-node-flow/workflows', {
    action: 'run',
    id: workflowId,
    runId: sourceRunId,
    input: { label: marker },
  })
  if (source.run?.status !== 'ok' || source.run?.value !== marker) throw new Error(`Could not create replayable source run: ${JSON.stringify(source.run)}`)

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
  await page.getByRole('button', { name: '运行记录', exact: true }).click()

  const row = page.locator('.wf-simple-row').filter({ hasText: workflowName })
  await row.waitFor({ state: 'visible' })
  if (await row.locator('pre').count()) throw new Error('Run list rendered detail payload before requesting details')
  await row.getByRole('button', { name: `查看 ${workflowName} 的运行详情`, exact: true }).click()
  const detailDialog = page.getByRole('dialog', { name: '运行详情' })
  await detailDialog.waitFor({ state: 'visible' })
  await detailDialog.getByText(marker, { exact: true }).waitFor({ state: 'visible' })
  await detailDialog.getByRole('button', { name: '关闭', exact: true }).last().click()

  await row.getByRole('button', { name: '重放', exact: true }).click()
  const replayDialog = page.getByRole('dialog', { name: '确认重放运行' })
  await replayDialog.waitFor({ state: 'visible' })
  await replayDialog.getByText('任何写入外部系统的节点都会再次执行。').waitFor({ state: 'visible' })
  await replayDialog.getByRole('button', { name: '取消', exact: true }).click()
  await replayDialog.waitFor({ state: 'hidden' })

  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, oneEntry: true, lazyRunDetails: true, replayConfirmation: true }, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
  await cleanup().catch(() => undefined)
}

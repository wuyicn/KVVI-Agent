import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const callbackId = `live-wait-ui-callback-${suffix}`
const approvalId = `live-wait-ui-approval-${suffix}`
const callbackName = `Live Wait Callback ${suffix}`
const approvalName = `Live Wait Approval ${suffix}`
const workflowIds = new Set([callbackId, approvalId])
const browserErrors = []
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync)
if (!executablePath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium-compatible browser')

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, init)
  const data = await response.json().catch(() => ({}))
  return { response, data }
}

function post(path, body) {
  return requestJson(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify(body) })
}

async function createAndRun(id, name, mode) {
  const now = new Date().toISOString()
  const doc = {
    version: 1,
    name,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'wait', type: 'workflow', position: { x: 340, y: 180 }, data: { kind: 'wait', label: mode === 'callback' ? 'Wait Callback' : 'Wait Approval', waitMode: mode } },
      { id: 'output', type: 'workflow', position: { x: 600, y: 180 }, data: { kind: 'output', label: 'Done', template: mode === 'callback' ? '{{result.event}}' : '{{result.decision}}:{{result.note}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'wait' }, { id: 'e2', source: 'wait', target: 'output' }],
  }
  const saved = await post('/dsh-node-flow/workflows', { action: 'save', expectedRevision: 0, workflow: { id, name, status: 'disabled', revision: 0, draftRevision: 0, createdAt: now, updatedAt: now, doc } })
  if (!saved.response.ok) throw new Error(saved.data.error || `Could not create ${name}`)
  const run = await post('/dsh-node-flow/workflows', { action: 'run', id, runId: `run-${id}`, input: 'live-ui' })
  if (!run.response.ok || run.data.run?.status !== 'waiting') throw new Error(`Could not wait ${name}: ${JSON.stringify(run.data)}`)
  return run.data.run
}

async function waitForRun(predicate, timeout = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const listed = await requestJson('/dsh-node-flow/runs')
    const found = listed.data.runs?.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error('Timed out waiting for UI waitpoint continuation')
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) if (workflowIds.has(run.workflowId)) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  for (const workflow of workflows.data.workflows ?? []) if (workflowIds.has(workflow.id)) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflow.id, expectedRevision: workflow.revision }).catch(() => undefined)
}

let browser
try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.data.capabilities?.waitpoints !== true) throw new Error('Running backend does not expose waitpoints')
  const callbackRun = await createAndRun(callbackId, callbackName, 'callback')
  const approvalRun = await createAndRun(approvalId, approvalName, 'approval')

  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  else await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  const entry = page.locator('[data-dsh-node-flow-entry]')
  await entry.waitFor({ state: 'visible', timeout: 15_000 })
  if (await entry.count() !== 1) throw new Error(`Expected one node-flow entry, found ${await entry.count()}`)
  await entry.click()
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: '运行记录', exact: true }).click()

  const approvalRow = page.locator('.wf-simple-row').filter({ hasText: approvalName })
  await approvalRow.getByText('等待中', { exact: true }).waitFor({ state: 'visible' })
  await approvalRow.getByRole('button', { name: '处理审批', exact: true }).click()
  const approvalDialog = page.getByRole('dialog', { name: '处理审批' })
  await approvalDialog.getByLabel('审批备注').fill('live-ok')
  await approvalDialog.getByRole('button', { name: '通过', exact: true }).click()
  const approved = await waitForRun((run) => run.resumedFromRunId === approvalRun.id && run.status === 'ok')
  if (approved.value !== 'approved:live-ok') throw new Error(`Approval UI returned ${JSON.stringify(approved.value)}`)

  const callbackRow = page.locator('.wf-simple-row').filter({ hasText: callbackName })
  await callbackRow.getByRole('button', { name: '回调凭证', exact: true }).click()
  const callbackDialog = page.getByRole('dialog', { name: '外部回调凭证' })
  const callbackUrlInput = callbackDialog.getByLabel('回调地址')
  const callbackTokenInput = callbackDialog.getByLabel('一次性 Token')
  await callbackUrlInput.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const inputs = [...document.querySelectorAll('[role="dialog"] input')]
    return inputs.some((input) => input.value.endsWith('/dsh-node-flow/waitpoint-callback'))
      && inputs.some((input) => input.type === 'password' && input.value.length >= 32)
  })
  const callbackUrl = await callbackUrlInput.inputValue()
  const callbackToken = await callbackTokenInput.inputValue()
  if (!callbackUrl.endsWith('/dsh-node-flow/waitpoint-callback') || callbackToken.length < 32) throw new Error('Callback credential dialog did not expose a valid one-time credential')
  const callback = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-wait-token': callbackToken }, body: '{"event":"ui-ready"}' })
  if (!callback.ok || (await callback.json()).status !== 'ok') throw new Error(`Callback from UI credential failed: ${callback.status}`)
  const callbackDone = await waitForRun((run) => run.resumedFromRunId === callbackRun.id && run.status === 'ok')
  if (callbackDone.value !== 'ui-ready') throw new Error(`Callback UI returned ${JSON.stringify(callbackDone.value)}`)

  await callbackDialog.getByRole('button', { name: '关闭', exact: true }).first().click()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '运行记录', exact: true }).click()
  await page.locator('.wf-simple-row').filter({ hasText: callbackName }).getByText('已继续', { exact: true }).waitFor({ state: 'visible' })
  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Waitpoint dashboard overflowed on mobile: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)

  console.log(JSON.stringify({ ok: true, approvalDialog: true, callbackCredential: true, callbackResolved: true, oneEntry: true, mobileOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
  await cleanup().catch(() => undefined)
}

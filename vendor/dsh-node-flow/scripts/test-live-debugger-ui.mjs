import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-debugger-ui-${suffix}`
const workflowName = `Live Debugger UI ${suffix}`
const browserErrors = []
const ignoredBrowserError = (message) => /\/ally\/(?:snapshot|cli-status)\?/.test(message)
const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync)

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
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'first', type: 'workflow', position: { x: 260, y: 0 }, data: { kind: 'output', label: 'First', breakpoint: false, template: 'first:{{result}}' } },
      { id: 'second', type: 'workflow', position: { x: 520, y: 0 }, data: { kind: 'output', label: 'Second', breakpoint: false, template: 'second:{{result}}' } },
      { id: 'third', type: 'workflow', position: { x: 780, y: 0 }, data: { kind: 'output', label: 'Third', template: 'third:{{result}}' } },
    ],
    edges: [
      { id: 'trigger-first', source: 'trigger', target: 'first', type: 'workflow' },
      { id: 'first-second', source: 'first', target: 'second', type: 'workflow' },
      { id: 'second-third', source: 'second', target: 'third', type: 'workflow' },
    ],
  }
}

async function cleanup() {
  const runs = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.data.runs ?? []) {
    if (run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ data: { workflows: [] } }))
  const workflow = (workflows.data.workflows ?? []).find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
}

async function openDshPage(page) {
  await page.goto(authUrl || baseUrl, { waitUntil: 'domcontentloaded' })
}

async function waitFor(check, message, timeout = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(message)
}

let browser
try {
  await cleanup()
  const created = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: {
      id: workflowId,
      name: workflowName,
      status: 'disabled',
      revision: 0,
      draftRevision: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      doc: documentOf(),
    },
  })
  if (!created.response.ok) throw new Error(created.data.error || 'Could not create debugger UI fixture')

  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const detail = `${message.text()} (${message.location().url})`
    if (!ignoredBrowserError(detail)) browserErrors.push(detail)
  })
  await openDshPage(page)
  const entry = page.locator('[data-dsh-node-flow-entry]')
  await entry.waitFor({ state: 'visible', timeout: 15000 })
  if (await entry.count() !== 1) throw new Error(`Expected one node-flow entry, found ${await entry.count()}`)
  await entry.click()
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible' })
  await page.locator('.wf-workflow-name').filter({ hasText: workflowName }).click()
  await page.locator('.wf-name').waitFor({ state: 'visible' })

  for (const id of ['first', 'second']) {
    await page.locator(`.react-flow__node[data-id="${id}"]`).click()
    await page.getByLabel('调试断点').check()
  }
  await waitFor(async () => {
    const result = await requestJson('/dsh-node-flow/workflows')
    const workflow = (result.data.workflows ?? []).find((candidate) => candidate.id === workflowId)
    return workflow?.doc?.nodes?.filter((node) => node.data.breakpoint).length === 2
  }, 'breakpoints were not saved')

  await page.getByRole('button', { name: '调试', exact: true }).click()
  const execution = page.locator('.wf-execution')
  await execution.waitFor({ state: 'visible' })
  await execution.getByText('暂停于「first」', { exact: true }).waitFor({ state: 'visible' })
  await execution.getByRole('button', { name: '继续', exact: true }).click()
  await execution.getByText('暂停于「second」', { exact: true }).waitFor({ state: 'visible' })
  await execution.getByRole('button', { name: '单步', exact: true }).click()
  await execution.getByText('暂停于「third」', { exact: true }).waitFor({ state: 'visible' })
  await execution.getByText('已暂停 · 单步', { exact: true }).waitFor({ state: 'visible' })
  await execution.getByRole('button', { name: '继续', exact: true }).click()
  await execution.getByText('执行完成', { exact: true }).waitFor({ state: 'visible' })

  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Debugger UI overflowed on mobile: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, breakpoints: true, continue: true, step: true, completion: true, mobileOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
  await cleanup().catch(() => undefined)
}

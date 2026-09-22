import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-error-route-ui-${suffix}`
const workflowName = `Live Error Route UI ${suffix}`
const runId = `live-error-route-ui-run-${suffix}`
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
  return { response, data }
}

function post(path, body) {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify(body),
  })
}

function documentOf(url) {
  return {
    version: 1,
    name: workflowName,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: '开始' } },
      {
        id: 'request',
        type: 'workflow',
        position: { x: 360, y: 180 },
        data: {
          kind: 'http',
          label: '不稳定请求',
          httpMethod: 'GET',
          url,
          responseMode: 'json',
          failOnHttpError: true,
          retryCount: '1',
          retryDelay: '0',
          onError: 'route',
        },
      },
      { id: 'handled-output', type: 'workflow', position: { x: 660, y: 300 }, data: { kind: 'output', label: '记录故障', template: '{{result.error.nodeKind}}:{{result.error.attempts}}' } },
    ],
    edges: [{ id: 'success', source: 'trigger', target: 'request', type: 'workflow' }],
  }
}

async function currentWorkflow() {
  const { data } = await requestJson('/dsh-node-flow/workflows')
  return data.workflows?.find((workflow) => workflow.id === workflowId)
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function cleanup() {
  const { data: runs } = await requestJson('/dsh-node-flow/runs').catch(() => ({ data: { runs: [] } }))
  for (const run of runs.runs ?? []) {
    if (run.id === runId || run.workflowId === workflowId) await post('/dsh-node-flow/runs', { action: 'delete', id: run.id }).catch(() => undefined)
  }
  const workflow = await currentWorkflow().catch(() => undefined)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflow.id, expectedRevision: workflow.revision }).catch(() => undefined)
}

async function openDshPage(page) {
  await page.goto(authUrl || baseUrl, { waitUntil: 'domcontentloaded' })
}

const upstream = createServer((_request, response) => {
  response.writeHead(503, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ token: 'response-body-must-not-reach-error-event', reason: 'outage' }))
})

let browser
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
try {
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Error route UI fixture did not expose a TCP port')
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.data.capabilities?.errorRoutes !== true) throw new Error('Running backend does not expose error-route capability')

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
      doc: documentOf(`http://127.0.0.1:${address.port}/unavailable`),
    },
  })
  if (!created.response.ok) throw new Error(created.data.error || 'Could not create error-route UI fixture')

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
  await page.locator('.wf-workflow-name').filter({ hasText: workflowName }).click()
  await page.locator('.wf-name').waitFor({ state: 'visible' })

  await page.locator('.react-flow__node[data-id="request"]').evaluate((element) => element.click())
  await page.getByLabel('失败时行为').selectOption('route')
  await page.getByText('还没有连接红色', { exact: false }).waitFor({ state: 'visible' })
  const sourceHandle = page.locator('.react-flow__node[data-id="request"] .wf-handle--error')
  const targetHandle = page.locator('.react-flow__node[data-id="handled-output"] .react-flow__handle-left')
  await sourceHandle.waitFor({ state: 'visible' })
  await targetHandle.waitFor({ state: 'visible' })
  const sourceBox = await sourceHandle.boundingBox()
  const targetBox = await targetHandle.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Could not locate error-route handles')
  const sourceX = sourceBox.x + sourceBox.width / 2
  const sourceY = sourceBox.y + sourceBox.height / 2
  const targetX = targetBox.x + targetBox.width / 2
  const targetY = targetBox.y + targetBox.height / 2
  await page.mouse.move(sourceX, sourceY)
  await page.mouse.down()
  await page.mouse.move(sourceX + 8, sourceY, { steps: 3 })
  await page.mouse.move(targetX, targetY, { steps: 18 })
  await page.mouse.up()
  await page.locator('.react-flow__edge.wf-edge--error').waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByText('还没有连接红色', { exact: false }).waitFor({ state: 'hidden' })

  const saved = await waitFor(async () => {
    const workflow = await currentWorkflow()
    return workflow?.doc?.edges?.find((edge) => edge.source === 'request' && edge.target === 'handled-output' && edge.sourceHandle === 'error') ? workflow : undefined
  }, 'saved error edge')
  if (saved.doc.nodes.find((node) => node.id === 'request')?.data.onError !== 'route') throw new Error('Error-route selection did not persist')

  const run = await post('/dsh-node-flow/workflows', { action: 'run', id: workflowId, runId, input: 'manual-input' })
  if (!run.response.ok || run.data.run?.status !== 'handled' || run.data.run?.handledErrors !== 1 || run.data.run?.failed !== 0) {
    throw new Error(`Error route did not finish as handled: ${JSON.stringify(run.data.run)}`)
  }

  await page.getByRole('button', { name: '返回工作流', exact: true }).click()
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '运行记录', exact: true }).click()
  const runRow = page.locator('.wf-simple-row').filter({ hasText: workflowName })
  await runRow.waitFor({ state: 'visible' })
  await runRow.getByText('错误已处理', { exact: true }).waitFor({ state: 'visible' })
  await runRow.getByText('1 已处理', { exact: false }).waitFor({ state: 'visible' })
  await runRow.getByRole('button', { name: `查看 ${workflowName} 的运行详情`, exact: true }).click()
  const detailDialog = page.getByRole('dialog', { name: '运行详情' })
  await detailDialog.waitFor({ state: 'visible' })
  await detailDialog.getByText('错误已路由', { exact: false }).waitFor({ state: 'visible' })
  await detailDialog.getByRole('button', { name: '关闭', exact: true }).last().click()

  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Error route UI overflowed on mobile: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, oneEntry: true, warning: true, errorEdge: true, handledRun: true, mobileOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
  await cleanup().catch(() => undefined)
  await new Promise((resolve) => upstream.close(() => resolve()))
}

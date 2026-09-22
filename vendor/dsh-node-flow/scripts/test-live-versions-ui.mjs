import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-version-ui-${suffix}`
const workflowName = `Live Version UI ${suffix}`
const browserErrors = []
const executableCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const executablePath = executableCandidates.find(existsSync)
if (!executablePath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium-compatible browser')

const documentOf = (outputLabel = '') => ({
  version: 1,
  name: workflowName,
  nodes: [
    { id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: '开始' }, style: { width: 224, height: 76 } },
    ...(outputLabel ? [{ id: 'output', type: 'workflow', position: { x: 380, y: 180 }, data: { kind: 'output', label: outputLabel, template: '{{result}}' }, style: { width: 224, height: 82 } }] : []),
  ],
  edges: outputLabel ? [{ id: 'edge', source: 'trigger', target: 'output', type: 'workflow' }] : [],
})

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

async function openDshPage(page) {
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
}

async function currentWorkflow() {
  const data = await requestJson('/dsh-node-flow/workflows')
  return (data.workflows || []).find((workflow) => workflow.id === workflowId)
}

async function waitForWorkflow(predicate, label) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const workflow = await currentWorkflow()
    if (workflow && predicate(workflow)) return workflow
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function cleanup() {
  const workflow = await currentWorkflow().catch(() => undefined)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
}

let browser
try {
  await cleanup()
  const createdAt = new Date().toISOString()
  let data = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: 0,
    workflow: {
      id: workflowId,
      name: workflowName,
      status: 'disabled',
      revision: 0,
      draftRevision: 0,
      createdAt,
      updatedAt: createdAt,
      doc: documentOf(),
    },
  })
  let workflow = data.workflow
  data = await post('/dsh-node-flow/workflows', {
    action: 'save',
    expectedRevision: workflow.revision,
    workflow: { ...workflow, doc: documentOf('已发布结果') },
  })
  workflow = data.workflow
  data = await post('/dsh-node-flow/workflows', {
    action: 'status',
    id: workflowId,
    status: 'enabled',
    expectedRevision: workflow.revision,
  })
  workflow = data.workflow

  const initialHistory = await requestJson(`/dsh-node-flow/workflow-versions?workflowId=${encodeURIComponent(workflowId)}`)
  if (initialHistory.versions?.length !== 3) throw new Error(`Expected 3 initial versions: ${JSON.stringify(initialHistory)}`)
  const createdVersion = initialHistory.versions.find((version) => version.kind === 'created')
  const draftVersion = initialHistory.versions.find((version) => version.kind === 'draft')
  if (!createdVersion || !draftVersion) throw new Error('Created and draft versions were not found')

  browser = await chromium.launch({ executablePath, headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('dialog', (dialog) => dialog.accept())
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await openDshPage(page)
  const entry = page.locator('[data-dsh-node-flow-entry]')
  await entry.waitFor({ state: 'visible', timeout: 15_000 })
  if (await entry.count() !== 1) throw new Error(`Expected one node-flow entry, found ${await entry.count()}`)
  await entry.click()
  await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: `查看 ${workflowName} 的版本历史` }).click()

  const dialog = page.getByRole('dialog', { name: `${workflowName} 版本历史` })
  await dialog.waitFor({ state: 'visible' })
  const compares = dialog.locator('.wf-version-compare select')
  await compares.nth(0).selectOption(createdVersion.id)
  await compares.nth(1).selectOption(draftVersion.id)
  await dialog.getByText('新增节点', { exact: true }).waitFor({ state: 'visible' })
  await dialog.getByText('新增连接', { exact: true }).waitFor({ state: 'visible' })

  const createdButton = dialog.getByRole('button', { name: new RegExp(`v${createdVersion.revision}\\b`) })
  await createdButton.click()
  await dialog.getByRole('button', { name: '恢复为草稿' }).click()
  workflow = await waitForWorkflow((candidate) => candidate.revision === 4, 'draft restore')
  if (workflow.doc.nodes.length !== 1) throw new Error('Draft restore did not restore the historical graph')
  if (workflow.publishedDoc?.nodes[1]?.data?.label !== '已发布结果') throw new Error('Draft restore changed the published snapshot')
  await dialog.getByText('v4', { exact: true }).first().waitFor({ state: 'visible' })

  const draftButton = dialog.getByRole('button', { name: new RegExp(`v${draftVersion.revision}\\b`) })
  await draftButton.click()
  await dialog.getByRole('button', { name: '恢复并发布' }).click()
  workflow = await waitForWorkflow((candidate) => candidate.revision === 5, 'historical publish')
  if (workflow.doc.nodes[1]?.data?.label !== '已发布结果' || workflow.publishedDoc?.nodes[1]?.data?.label !== '已发布结果') throw new Error('Restore-and-publish did not restore both snapshots')
  if (workflow.draftRevision !== workflow.publishedRevision) throw new Error('Restore-and-publish left unpublished changes')
  await dialog.getByText('v5', { exact: true }).first().waitFor({ state: 'visible' })

  const finalHistory = await requestJson(`/dsh-node-flow/workflow-versions?workflowId=${encodeURIComponent(workflowId)}`)
  if (finalHistory.versions?.length !== 5) throw new Error(`Expected 5 final versions: ${JSON.stringify(finalHistory)}`)
  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Version panel overflowed on mobile: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, versions: finalHistory.versions.length, diff: true, draftIsolation: true, historicalPublish: true, mobileOverflow: false }, null, 2))
  await context.close()
} finally {
  if (browser) await browser.close().catch(() => undefined)
  await cleanup()
}

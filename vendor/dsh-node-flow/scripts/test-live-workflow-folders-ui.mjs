import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const destinationName = `Folder destination ${suffix}`
const sourceName = `Folder source ${suffix}`
const renamedSourceName = `Folder source renamed ${suffix}`
const workflowId = `live-folder-ui-${suffix}`
const workflowName = `Live Folder UI ${suffix}`
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

function documentOf() {
  return {
    version: 1,
    name: workflowName,
    nodes: [
      { id: 'trigger', type: 'workflow', position: { x: 0, y: 0 }, data: { kind: 'trigger', label: 'Start' } },
      { id: 'output', type: 'workflow', position: { x: 240, y: 0 }, data: { kind: 'output', label: 'Output', template: '{{result}}' } },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'output' }],
  }
}

async function createFolder(name) {
  return (await post('/dsh-node-flow/workflow-folders', { action: 'create', name })).folder
}

async function cleanup() {
  const workflows = await requestJson('/dsh-node-flow/workflows').catch(() => ({ workflows: [] }))
  const workflow = workflows.workflows?.find((candidate) => candidate.id === workflowId)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflow.id, expectedRevision: workflow.revision }).catch(() => undefined)
  const folders = await requestJson('/dsh-node-flow/workflow-folders').catch(() => ({ folders: [] }))
  for (const folder of folders.folders ?? []) {
    if (![sourceName, renamedSourceName, destinationName].includes(folder.name)) continue
    await post('/dsh-node-flow/workflow-folders', { action: 'delete', id: folder.id, expectedRevision: folder.revision }).catch(() => undefined)
  }
}

async function openDshPage(page) {
  await page.goto(authUrl || baseUrl, { waitUntil: 'domcontentloaded' })
}

let browser
try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.capabilities?.workflowFolders !== true) throw new Error('The running DSH node-flow backend does not expose workflow folders')
  const destination = await createFolder(destinationName)
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
      doc: documentOf(),
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

  const folderNav = page.locator('.wf-folder-navigator')
  await folderNav.locator('.wf-folder-navigator__header').getByRole('button', { name: '新建文件夹', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '新建文件夹' })
  await createDialog.getByLabel('名称', { exact: true }).fill(sourceName)
  await createDialog.getByRole('button', { name: '创建文件夹', exact: true }).click()
  const sourceFolderItem = folderNav.locator('.wf-folder-navigator__item').filter({ hasText: sourceName })
  await sourceFolderItem.locator('.wf-folder-navigator__select').waitFor({ state: 'visible' })

  const allFolderButton = folderNav.locator('.wf-folder-navigator__list > button').filter({ hasText: '全部工作流' })
  await allFolderButton.click()
  const workflowRow = page.locator('.wf-workflow-row').filter({ hasText: workflowName })
  await workflowRow.waitFor({ state: 'visible' })
  await workflowRow.getByRole('button', { name: `移动 ${workflowName} 到文件夹`, exact: true }).click()
  const moveDialog = page.getByRole('dialog', { name: '移动工作流' })
  await moveDialog.getByLabel('移动工作流的目标文件夹', { exact: true }).selectOption({ label: sourceName })
  await moveDialog.getByRole('button', { name: '确认移动', exact: true }).click()
  await sourceFolderItem.locator('.wf-folder-navigator__select').click()
  await workflowRow.waitFor({ state: 'visible' })

  await page.getByRole('button', { name: `重命名 ${sourceName}`, exact: true }).click()
  const renameDialog = page.getByRole('dialog', { name: '重命名文件夹' })
  await renameDialog.getByLabel('名称', { exact: true }).fill(renamedSourceName)
  await renameDialog.getByRole('button', { name: '保存名称', exact: true }).click()
  const renamedSourceFolderItem = folderNav.locator('.wf-folder-navigator__item').filter({ hasText: renamedSourceName })
  await renamedSourceFolderItem.locator('.wf-folder-navigator__select').waitFor({ state: 'visible' })
  await workflowRow.locator('small').filter({ hasText: renamedSourceName }).waitFor({ state: 'visible' })

  await renamedSourceFolderItem.getByRole('button', { name: `删除 ${renamedSourceName}`, exact: true }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除文件夹' })
  await deleteDialog.getByLabel('移动到', { exact: true }).selectOption({ label: destinationName })
  await deleteDialog.getByRole('button', { name: '删除并移动', exact: true }).click()
  await page.locator('.wf-folder-navigator__item').filter({ hasText: destinationName }).locator('.wf-folder-navigator__select').click()
  await workflowRow.waitFor({ state: 'visible' })
  await page.getByText(renamedSourceName, { exact: true }).waitFor({ state: 'hidden' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('按文件夹筛选工作流', { exact: true }).waitFor({ state: 'visible' })
  await page.getByLabel('按文件夹筛选工作流', { exact: true }).selectOption({ value: destination.id })
  await workflowRow.waitFor({ state: 'visible' })
  const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Workflow folders overflowed on mobile: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, create: true, filter: true, move: true, rename: true, deleteMoves: true, mobileOverflow: false }, null, 2))
  await context.close()
} finally {
  await browser?.close().catch(() => undefined)
  await cleanup()
}

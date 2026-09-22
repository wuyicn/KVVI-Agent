import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const executableCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const executablePath = executableCandidates.find(existsSync)
if (!executablePath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a Chromium-compatible browser')

const clone = (value) => structuredClone(value)
const now = () => new Date().toISOString()
const documentOf = (name, outputLabel) => ({
  version: 1,
  name,
  nodes: [
    { id: 'trigger', type: 'workflow', position: { x: 80, y: 180 }, data: { kind: 'trigger', label: '开始' }, style: { width: 224, height: 76 } },
    ...(outputLabel ? [{ id: 'output', type: 'workflow', position: { x: 380, y: 180 }, data: { kind: 'output', label: outputLabel, template: '{{result}}' }, style: { width: 224, height: 82 } }] : []),
  ],
  edges: outputLabel ? [{ id: 'edge', source: 'trigger', target: 'output', type: 'workflow' }] : [],
})

const v1Doc = documentOf('版本测试', '')
const v2Doc = documentOf('版本测试', '已发布结果')
const v3Doc = documentOf('版本测试', '当前草稿结果')
let workflow = {
  id: 'version-ui-workflow',
  name: '版本测试',
  status: 'enabled',
  revision: 3,
  draftRevision: 3,
  publishedRevision: 2,
  publishedAt: now(),
  publishedDoc: clone(v2Doc),
  createdAt: now(),
  updatedAt: now(),
  doc: clone(v3Doc),
}
let versions = [
  { id: `${workflow.id}:r3`, workflowId: workflow.id, revision: 3, draftRevision: 3, publishedRevision: 2, kind: 'draft', createdAt: now(), name: workflow.name, status: 'enabled', doc: clone(v3Doc), publishedDoc: clone(v2Doc) },
  { id: `${workflow.id}:r2`, workflowId: workflow.id, revision: 2, draftRevision: 2, publishedRevision: 2, kind: 'published', createdAt: now(), name: workflow.name, status: 'enabled', doc: clone(v2Doc), publishedDoc: clone(v2Doc) },
  { id: `${workflow.id}:r1`, workflowId: workflow.id, revision: 1, draftRevision: 1, kind: 'created', createdAt: now(), name: workflow.name, status: 'disabled', doc: clone(v1Doc) },
]
let restoreRequests = 0
const browserErrors = []

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite test server did not expose a TCP port')
const baseUrl = `http://127.0.0.1:${address.port}`

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

await context.route('**/dsh-node-flow/workflows', async (route) => {
  if (route.request().method() === 'GET') return json(route, 200, { workflows: [clone(workflow)], capabilities: { workflowRevisions: true, workflowVersions: true } })
  return json(route, 400, { error: 'unsupported action' })
})
await context.route('**/dsh-node-flow/workflow-versions*', async (route) => {
  const request = route.request()
  if (request.method() === 'GET') return json(route, 200, { workflow: clone(workflow), versions: clone(versions) })
  const body = request.postDataJSON()
  if (body.action !== 'restore') return json(route, 400, { error: 'unsupported action' })
  restoreRequests += 1
  if (Number(body.expectedRevision) !== workflow.revision) return json(route, 409, { error: 'workflow revision conflict', latest: clone(workflow) })
  const source = versions.find((version) => version.id === body.versionId)
  if (!source) return json(route, 404, { error: 'workflow version not found' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const draftRevision = workflow.draftRevision + 1
  workflow = {
    ...workflow,
    name: source.name,
    revision: workflow.revision + 1,
    draftRevision,
    updatedAt: now(),
    doc: clone(source.doc),
    ...(body.publish ? { status: 'enabled', publishedRevision: draftRevision, publishedAt: now(), publishedDoc: clone(source.doc) } : {}),
  }
  const restored = {
    id: `${workflow.id}:r${workflow.revision}`,
    workflowId: workflow.id,
    revision: workflow.revision,
    draftRevision: workflow.draftRevision,
    publishedRevision: workflow.publishedRevision,
    kind: body.publish ? 'restored-published' : 'restored',
    createdAt: workflow.updatedAt,
    sourceVersionId: source.id,
    name: workflow.name,
    status: workflow.status,
    doc: clone(workflow.doc),
    publishedDoc: clone(workflow.publishedDoc),
  }
  versions = [restored, ...versions]
  return json(route, 200, { workflow: clone(workflow), version: clone(restored) })
})
await context.route('**/dsh-node-flow/runs?*', (route) => json(route, 200, { runs: [], writable: true }))
await context.route('**/dsh-node-flow/runs', (route) => json(route, 200, { runs: [], writable: true }))

try {
  const page = await context.newPage()
  page.on('dialog', (dialog) => dialog.accept())
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '查看 版本测试 的版本历史' }).click()
  const dialog = page.getByRole('dialog', { name: '版本测试 版本历史' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByRole('button', { name: /v1/ }).click()
  await dialog.getByText('新增节点', { exact: true }).waitFor({ state: 'visible' })
  const restoreDraft = dialog.getByRole('button', { name: '恢复为草稿' })
  await restoreDraft.evaluate((button) => { button.click(); button.click() })
  await dialog.getByText('v4', { exact: true }).first().waitFor({ state: 'visible' })
  if (restoreRequests !== 1) throw new Error(`Draft restore was submitted ${restoreRequests} times`)
  if (workflow.doc.nodes.length !== 1 || workflow.publishedDoc.nodes.length !== 2 || workflow.publishedRevision !== 2) throw new Error('Draft restore changed the live snapshot')

  await dialog.getByRole('button', { name: /v2/ }).click()
  await dialog.getByRole('button', { name: '恢复并发布' }).click()
  await dialog.getByText('v5', { exact: true }).first().waitFor({ state: 'visible' })
  if (restoreRequests !== 2) throw new Error(`Published restore count mismatch: ${restoreRequests}`)
  if (workflow.doc.nodes[1]?.data.label !== '已发布结果' || workflow.publishedDoc.nodes[1]?.data.label !== '已发布结果') throw new Error('Published restore did not deploy the historical graph')
  if (workflow.publishedRevision !== workflow.draftRevision) throw new Error('Published restore left unpublished changes')

  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Version panel overflowed on mobile: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)
  console.log(JSON.stringify({ ok: true, versions: versions.length, restoreRequests, draftIsolation: true, publishedRestore: true, mobileOverflow: false }, null, 2))
} finally {
  await context.close()
  await browser.close()
  await vite.close()
}

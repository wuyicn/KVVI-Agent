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

const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
await vite.listen()
const address = vite.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite test server did not expose a TCP port')

const browser = await chromium.launch({ executablePath, headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const workflows = []
const credentials = []
const projectVariables = []
const runs = []
const browserErrors = []
let saveRequests = 0
let statusRequests = 0
let conflictResponses = 0
let resumeRequests = 0
let oauthAuthorizationRequests = 0
let connectionTestRequests = 0
let pollingRequests = 0

const clone = (value) => structuredClone(value)
const isoNow = () => new Date().toISOString()
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const waitUntil = async (predicate, label, timeout = 10_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}

await context.route('**/dsh-node-flow/workflows', async (route) => {
  const request = route.request()
  if (request.method() === 'GET') {
    return json(route, 200, { workflows: clone(workflows), capabilities: { directRun: true, runWrites: true, workflowRevisions: true, credentials: true, webhooks: true, nodeTesting: true, runCancellation: true, projectVariables: true, projectSecrets: true } })
  }
  const body = request.postDataJSON()
  const index = workflows.findIndex((workflow) => workflow.id === body.id || workflow.id === body.workflow?.id)
  const existing = index >= 0 ? workflows[index] : undefined

  if (body.action === 'save') {
    saveRequests += 1
    if ((!existing && Number(body.expectedRevision) !== 0) || (existing && Number(body.expectedRevision) !== existing.revision)) {
      conflictResponses += 1
      return json(route, 409, { error: 'workflow revision conflict', latest: clone(existing) })
    }
    const incoming = body.workflow
    const saved = existing
      ? { ...existing, name: incoming.name, description: incoming.description, revision: existing.revision + 1, draftRevision: existing.draftRevision + 1, updatedAt: isoNow(), doc: clone(incoming.doc) }
      : { ...incoming, revision: 1, draftRevision: 1, status: incoming.status === 'enabled' ? 'enabled' : 'disabled', updatedAt: isoNow() }
    if (index >= 0) workflows[index] = saved
    else workflows.push(saved)
    return json(route, 200, { workflow: clone(saved) })
  }

  if (body.action === 'status') {
    statusRequests += 1
    if (!existing) return json(route, 404, { error: 'workflow not found' })
    if (Number(body.expectedRevision) !== existing.revision) {
      conflictResponses += 1
      return json(route, 409, { error: 'workflow revision conflict', latest: clone(existing) })
    }
    const saved = body.status === 'enabled'
      ? { ...existing, status: 'enabled', revision: existing.revision + 1, publishedRevision: existing.draftRevision, publishedAt: isoNow(), publishedDoc: clone(existing.doc) }
      : { ...existing, status: 'disabled', revision: existing.revision + 1 }
    workflows[index] = saved
    return json(route, 200, { workflow: clone(saved) })
  }

  if (body.action === 'delete') {
    if (!existing) return json(route, 404, { error: 'workflow not found' })
    if (Number(body.expectedRevision) !== existing.revision) return json(route, 409, { error: 'workflow revision conflict', latest: clone(existing) })
    workflows.splice(index, 1)
    return json(route, 200, { ok: true })
  }

  return json(route, 400, { error: 'unsupported action' })
})
await context.route('**/dsh-node-flow/runs?*', async (route) => {
  const request = route.request()
  if (request.method() !== 'GET') return route.fallback()
  const url = new URL(request.url())
  if (url.searchParams.get('view') === 'summary') return json(route, 200, { runs: clone(runs), writable: true })
  const id = url.searchParams.get('id')
  const run = id ? runs.find((candidate) => candidate.id === id) : undefined
  return json(route, run ? 200 : 404, run ? { run: clone(run), writable: true } : { error: 'run not found' })
})
await context.route('**/dsh-node-flow/runs', async (route) => {
  const request = route.request()
  if (request.method() === 'GET') return json(route, 200, { runs: clone(runs), writable: true })
  const body = request.postDataJSON()
  if (body.action === 'resume') {
    resumeRequests += 1
    const previous = runs.find((run) => run.id === body.id)
    if (!previous || !previous.resumable || previous.resumedByRunId) return json(route, 409, { error: 'run is no longer resumable' })
    previous.resumable = false
    previous.resumedByRunId = body.runId
    await new Promise((resolve) => setTimeout(resolve, 120))
    const resumed = {
      ...clone(previous),
      id: body.runId,
      status: 'ok',
      failed: 0,
      startedAt: isoNow(),
      completedAt: isoNow(),
      resumable: false,
      resumedFromRunId: previous.id,
      resumedByRunId: undefined,
      checkpoint: undefined,
      nodes: previous.nodes.map((node) => ({ ...node, status: 'ok', error: undefined, attempts: 2 })),
    }
    runs.unshift(resumed)
    return json(route, 200, { ok: true, run: clone(resumed) })
  }
  if (body.action === 'save') {
    const index = runs.findIndex((run) => run.id === body.run.id)
    if (index >= 0) runs[index] = clone(body.run)
    else runs.unshift(clone(body.run))
    return json(route, 200, { ok: true, run: clone(body.run) })
  }
  return json(route, 400, { error: 'unsupported run action' })
})
await context.route('**/dsh-node-flow/schedules', (route) => json(route, 200, { schedules: [] }))
await context.route('**/dsh-node-flow/models', (route) => json(route, 200, { models: [] }))
await context.route('**/dsh-node-flow/connectors', (route) => json(route, 200, { connectors: [{
  id: 'github', version: 1, name: 'GitHub', description: 'Issue、评论与仓库自动化', category: '开发', color: '#24292f', origins: ['https://api.github.com'], credentialKinds: ['bearer', 'oauth2'], authHint: 'GitHub Token 或 OAuth2 连接',
  actions: [
    { id: 'create-issue', label: '创建 Issue', description: '在仓库中创建 Issue', fields: [
      { id: 'owner', label: '仓库所有者', type: 'text', required: true },
      { id: 'repo', label: '仓库名', type: 'text', required: true },
      { id: 'title', label: '标题', type: 'text', required: true },
      { id: 'body', label: '正文', type: 'textarea' },
      { id: 'labels', label: '标签 JSON', type: 'json', defaultValue: '["bug"]' },
    ] },
    { id: 'add-comment', label: '添加 Issue 评论', description: '向 Issue 添加评论', fields: [] },
  ],
  triggers: [
    { id: 'new-issue', label: '新 Issue', description: '检测仓库中新创建或更新的 Issue', fields: [
      { id: 'owner', label: '仓库所有者', type: 'text', required: true },
      { id: 'repo', label: '仓库名', type: 'text', required: true },
    ] },
  ],
}] }))
await context.route('**/dsh-node-flow/polling-triggers', (route) => {
  const request = route.request()
  const triggerNodes = workflows.flatMap((workflow) => (workflow.publishedDoc?.nodes ?? [])
    .filter((node) => node.data.kind === 'connector-trigger')
    .map((node) => ({ workflow, node })))
  const summaries = triggerNodes.map(({ workflow, node }) => ({
    id: `workflow:${workflow.id}:${node.id}`,
    initialized: true,
    nextPollAt: new Date(Date.now() + 60_000).toISOString(),
    lastPolledAt: isoNow(),
    lastEventAt: undefined,
    active: false,
  }))
  if (request.method() === 'GET') return json(route, 200, { triggers: summaries })
  const body = request.postDataJSON()
  if (body.action !== 'poll') return json(route, 400, { error: 'unsupported polling trigger action' })
  pollingRequests += 1
  return json(route, 200, { trigger: summaries.find((trigger) => trigger.id === body.id) })
})
const variableSummary = (variable) => {
  const references = []
  for (const workflow of workflows) {
    for (const [scope, document] of [['draft', workflow.doc], ['published', workflow.publishedDoc]]) {
      for (const node of document?.nodes ?? []) {
        if (!JSON.stringify(node.data).includes(`vars.${variable.name}`)) continue
        references.push({ workflowId: workflow.id, workflowName: workflow.name, nodeId: node.id, nodeLabel: node.data.label, scope })
      }
    }
  }
  return { id: variable.id, name: variable.name, kind: variable.kind, description: variable.description, value: variable.kind === 'plain' ? variable.storedValue : undefined, createdAt: variable.createdAt, updatedAt: variable.updatedAt, references }
}
await context.route('**/dsh-node-flow/project-variables', (route) => {
  const request = route.request()
  if (request.method() === 'GET') return json(route, 200, { variables: projectVariables.map(variableSummary) })
  const body = request.postDataJSON()
  if (body.action === 'save') {
    const incoming = body.variable
    const index = projectVariables.findIndex((variable) => variable.id === incoming.id)
    const existing = index >= 0 ? projectVariables[index] : undefined
    if (existing && body.expectedUpdatedAt && existing.updatedAt !== body.expectedUpdatedAt) return json(route, 409, { error: '项目变量已被其他操作更新，请刷新后重试' })
    const now = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updatedAt) + 1 : 0)).toISOString()
    const saved = {
      id: existing?.id ?? `variable-${projectVariables.length + 1}`,
      name: String(incoming.name).trim().toUpperCase(),
      kind: incoming.kind === 'secret' ? 'secret' : 'plain',
      description: incoming.description || undefined,
      storedValue: incoming.value || existing?.storedValue,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (index >= 0) projectVariables[index] = saved
    else projectVariables.push(saved)
    return json(route, 200, { variable: variableSummary(saved) })
  }
  if (body.action === 'delete') {
    const index = projectVariables.findIndex((variable) => variable.id === body.id)
    if (index < 0) return json(route, 404, { error: '项目变量不存在' })
    const references = variableSummary(projectVariables[index]).references
    if (references.length) return json(route, 409, { error: `项目变量仍被 ${references.length} 个节点引用`, references })
    projectVariables.splice(index, 1)
    return json(route, 200, { ok: true })
  }
  return json(route, 400, { error: 'unsupported project variable action' })
})
await context.route('**/dsh-node-flow/credentials', (route) => {
  const request = route.request()
  if (request.method() === 'GET') return json(route, 200, { credentials: clone(credentials) })
  const body = request.postDataJSON()
  if (body.action === 'save') {
    const existing = credentials.find((credential) => credential.id === body.credential.id)
    const now = isoNow()
    const saved = {
      id: existing?.id ?? `credential-${credentials.length + 1}`,
      name: body.credential.name,
      kind: body.credential.kind,
      headerName: body.credential.kind === 'api-key' ? body.credential.headerName : undefined,
      testUrl: body.credential.testUrl || undefined,
      authorizationUrl: body.credential.kind === 'oauth2' ? body.credential.authorizationUrl : undefined,
      tokenUrl: body.credential.kind === 'oauth2' ? body.credential.tokenUrl : undefined,
      clientId: body.credential.kind === 'oauth2' ? body.credential.clientId : undefined,
      scopes: body.credential.kind === 'oauth2' ? body.credential.scopes : undefined,
      clientAuth: body.credential.kind === 'oauth2' ? body.credential.clientAuth : undefined,
      usePkce: body.credential.kind === 'oauth2' ? body.credential.usePkce : undefined,
      extraAuthParams: body.credential.kind === 'oauth2' ? body.credential.extraAuthParams : undefined,
      extraTokenParams: body.credential.kind === 'oauth2' ? body.credential.extraTokenParams : undefined,
      status: existing?.status ?? 'untested',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const index = credentials.findIndex((credential) => credential.id === saved.id)
    if (index >= 0) credentials[index] = saved
    else credentials.push(saved)
    return json(route, 200, { credential: clone(saved) })
  }
  if (body.action === 'test') {
    connectionTestRequests += 1
    const index = credentials.findIndex((credential) => credential.id === body.id)
    credentials[index] = { ...credentials[index], status: 'connected', statusMessage: '连接测试成功：HTTP 200', lastCheckedAt: isoNow() }
    return json(route, 200, { credential: clone(credentials[index]) })
  }
  if (body.action === 'cancel-authorize') {
    const index = credentials.findIndex((credential) => credential.id === body.id)
    credentials[index] = { ...credentials[index], status: 'error', statusMessage: 'OAuth2 授权窗口已关闭' }
    return json(route, 200, { credential: clone(credentials[index]) })
  }
  if (body.action === 'delete') {
    const index = credentials.findIndex((credential) => credential.id === body.id)
    if (index >= 0) credentials.splice(index, 1)
    return json(route, 200, { ok: true })
  }
  return json(route, 400, { error: 'unsupported credential action' })
})
await context.route('**/dsh-node-flow/oauth2/start', (route) => {
  oauthAuthorizationRequests += 1
  const body = route.request().postDataJSON()
  const index = credentials.findIndex((credential) => credential.id === body.id)
  const callbackUrl = `http://127.0.0.1:${address.port}/dsh-node-flow/oauth2/callback`
  if (index < 0 || body.callbackUrl !== callbackUrl) return json(route, 400, { error: 'invalid OAuth2 start request' })
  credentials[index] = { ...credentials[index], status: 'authorizing', statusMessage: '等待 OAuth2 服务商授权' }
  return json(route, 200, { authorizationUrl: `http://127.0.0.1:${address.port}/mock-oauth-provider?id=${body.id}`, callbackUrl, expiresAt: new Date(Date.now() + 600_000).toISOString() })
})
await context.route('**/mock-oauth-provider*', (route) => {
  const id = new URL(route.request().url()).searchParams.get('id')
  const index = credentials.findIndex((credential) => credential.id === id)
  credentials[index] = { ...credentials[index], status: 'connected', statusMessage: undefined, authorizedAt: isoNow(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }
  return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Authorized</title><p>Authorized</p><script>setTimeout(()=>window.close(),100)</script>' })
})
await context.route('**/dsh-node-flow/node-test', (route) => {
  const body = route.request().postDataJSON()
  const output = { received: body.input, credentialId: body.node?.data?.credentialId }
  return json(route, 200, {
    ok: true,
    runId: 'test-run',
    node: { id: body.node.id, kind: body.node.data.kind, status: 'ok', output, logs: ['HTTP 200 OK'], ms: 12, attempts: 3 },
  })
})

const openDashboard = async (page) => {
  page.on('pageerror', (error) => browserErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('409')) browserErrors.push(message.text())
  })
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: '工作流' }).waitFor({ state: 'visible', timeout: 10_000 })
}

try {
  const pageOne = await context.newPage()
  await openDashboard(pageOne)
  const baseName = `__revision_${Date.now()}`
  await pageOne.getByRole('button', { name: /新建工作流/ }).first().click()
  await pageOne.getByLabel('工作流名称').fill(baseName)
  await pageOne.getByRole('button', { name: '创建并打开' }).click()
  await pageOne.locator('.wf-name').waitFor({ state: 'visible' })
  await waitUntil(() => workflows.length === 1, 'create workflow')

  const pageTwo = await context.newPage()
  await openDashboard(pageTwo)
  await pageTwo.locator('.wf-workflow-name').filter({ hasText: baseName }).click()
  await pageTwo.locator('.wf-name').waitFor({ state: 'visible' })

  const serverName = `${baseName}_server`
  await pageOne.locator('.wf-name').fill(serverName)
  await waitUntil(() => workflows[0]?.doc?.name === serverName && workflows[0]?.revision === 2, 'first writer save')

  const localName = `${baseName}_local`
  await pageTwo.locator('.wf-name').fill(localName)
  await pageTwo.getByRole('dialog', { name: '工作流版本冲突' }).waitFor({ state: 'visible', timeout: 10_000 })
  if (workflows[0].doc.name !== serverName || conflictResponses !== 1) throw new Error('Stale writer overwrote the server workflow')

  const copyButton = pageTwo.getByRole('button', { name: '另存为副本' })
  await copyButton.evaluate((button) => { button.click(); button.click() })
  await waitUntil(() => workflows.length === 2, 'conflict copy creation')
  const original = workflows.find((workflow) => workflow.name === serverName)
  const copyWorkflow = workflows.find((workflow) => workflow.id !== original?.id)
  if (!copyWorkflow || copyWorkflow.doc.name !== `${localName} - 本地副本`) throw new Error('Conflict copy did not preserve the local draft')

  await pageTwo.getByRole('button', { name: '发布并启用工作流' }).click()
  await waitUntil(() => workflows.find((workflow) => workflow.id === copyWorkflow.id)?.status === 'enabled', 'publish copy')
  const firstPublishedName = workflows.find((workflow) => workflow.id === copyWorkflow.id).publishedDoc.name

  const draftName = `${baseName}_draft_after_publish`
  await pageTwo.locator('.wf-name').fill(draftName)
  await waitUntil(() => workflows.find((workflow) => workflow.id === copyWorkflow.id)?.doc?.name === draftName, 'save published draft')
  const stale = workflows.find((workflow) => workflow.id === copyWorkflow.id)
  await pageTwo.getByRole('button', { name: '发布工作流更新' }).waitFor({ state: 'visible', timeout: 10_000 })
  if (stale.publishedDoc.name !== firstPublishedName || stale.publishedRevision === stale.draftRevision) throw new Error('Draft changed the published snapshot')

  await pageTwo.getByRole('button', { name: '发布工作流更新' }).click()
  await waitUntil(() => workflows.find((workflow) => workflow.id === copyWorkflow.id)?.publishedDoc?.name === draftName, 'republish draft')
  await pageTwo.getByRole('button', { name: '停用工作流' }).waitFor({ state: 'visible', timeout: 10_000 })

  await pageTwo.getByRole('button', { name: '返回工作流' }).click()
  await pageTwo.getByRole('heading', { name: '工作流' }).waitFor({ state: 'visible' })
  await pageTwo.getByRole('button', { name: '连接' }).click()
  await pageTwo.getByRole('heading', { name: '连接' }).waitFor({ state: 'visible' })
  await pageTwo.getByRole('button', { name: '新建连接' }).click()
  const credentialDialog = pageTwo.getByRole('dialog', { name: '新建连接' })
  await credentialDialog.getByLabel('名称').fill('E2E API')
  await credentialDialog.getByLabel('认证类型').selectOption('api-key')
  await credentialDialog.getByLabel('Header 名称').fill('X-E2E-Key')
  await credentialDialog.getByRole('textbox', { name: 'API Key' }).fill('not-stored-in-workflow')
  await credentialDialog.getByRole('button', { name: '保存连接' }).click()
  await waitUntil(() => credentials.length === 1, 'credential creation')
  await pageTwo.getByText('E2E API', { exact: true }).waitFor({ state: 'visible' })
  if (await pageTwo.getByText('not-stored-in-workflow', { exact: true }).count()) throw new Error('Credential secret was rendered in the dashboard')

  await pageTwo.getByRole('button', { name: '新建连接' }).click()
  const oauthDialog = pageTwo.getByRole('dialog', { name: '新建连接' })
  await oauthDialog.getByLabel('名称').fill('E2E OAuth2')
  await oauthDialog.getByLabel('认证类型').selectOption('oauth2')
  const callbackUrl = `http://127.0.0.1:${address.port}/dsh-node-flow/oauth2/callback`
  if (await oauthDialog.getByLabel('回调 URL').inputValue() !== callbackUrl) throw new Error('OAuth2 callback URL did not use the current page origin')
  await oauthDialog.getByLabel('授权 URL').fill('https://provider.example.test/oauth/authorize')
  await oauthDialog.getByLabel('Token URL').fill('https://provider.example.test/oauth/token')
  await oauthDialog.getByLabel('Client ID').fill('e2e-client-id')
  await oauthDialog.getByLabel('Client Secret').fill('e2e-client-secret')
  await oauthDialog.getByLabel('Scopes').fill('read offline_access')
  await oauthDialog.getByLabel('连接测试 URL').fill('https://api.example.test/me')
  await oauthDialog.getByText('高级 OAuth2 参数').click()
  await oauthDialog.getByLabel('额外授权参数 JSON').fill('{"prompt":"consent"}')
  await oauthDialog.getByLabel('额外 Token 参数 JSON').fill('{"audience":"api"}')
  const saveAndAuthorize = oauthDialog.getByRole('button', { name: '保存并授权' })
  await saveAndAuthorize.evaluate((button) => { button.click(); button.click() })
  await waitUntil(() => credentials.length === 2, 'OAuth2 credential creation')
  await pageTwo.getByText('E2E OAuth2', { exact: true }).waitFor({ state: 'visible' })
  try {
    await pageTwo.locator('.wf-credential-health.is-connected').filter({ hasText: '连接正常' }).waitFor({ state: 'visible', timeout: 10_000 })
  } catch {
    throw new Error(`OAuth2 UI did not reach connected state: ${JSON.stringify({ credentials, oauthAuthorizationRequests, pages: context.pages().map((page) => page.url()) })}`)
  }
  if (oauthAuthorizationRequests !== 1) throw new Error(`Expected one OAuth2 authorization request, received ${oauthAuthorizationRequests}`)
  if (await pageTwo.getByText('e2e-client-secret', { exact: true }).count()) throw new Error('OAuth2 Client Secret was rendered in the dashboard')
  await pageTwo.getByRole('button', { name: '测试 E2E OAuth2' }).click()
  await pageTwo.getByText('连接测试成功：HTTP 200', { exact: true }).waitFor({ state: 'visible' })
  if (connectionTestRequests !== 1) throw new Error(`Expected one connection test request, received ${connectionTestRequests}`)
  await pageTwo.getByRole('button', { name: '编辑 E2E OAuth2' }).click()
  const oauthEditDialog = pageTwo.getByRole('dialog', { name: '编辑连接' })
  if (await oauthEditDialog.getByLabel('Client Secret').inputValue()) throw new Error('OAuth2 Client Secret was disclosed when editing')
  await oauthEditDialog.getByRole('button', { name: '关闭' }).click()

  await pageTwo.getByRole('button', { name: '变量', exact: true }).click()
  await pageTwo.getByRole('heading', { name: '项目变量', exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByRole('button', { name: '新建变量', exact: true }).click()
  const plainVariableDialog = pageTwo.getByRole('dialog', { name: '新建项目变量' })
  await plainVariableDialog.getByLabel('变量名').fill('api_host')
  await plainVariableDialog.getByLabel('说明').fill('E2E API host')
  await plainVariableDialog.getByLabel('变量值', { exact: true }).fill('https://api.variable.test')
  await plainVariableDialog.getByRole('button', { name: '保存变量', exact: true }).click()
  await pageTwo.getByText('API_HOST', { exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByRole('button', { name: '新建变量', exact: true }).click()
  const secretVariableDialog = pageTwo.getByRole('dialog', { name: '新建项目变量' })
  await secretVariableDialog.getByLabel('变量名').fill('api_secret')
  await secretVariableDialog.getByLabel('类型').selectOption('secret')
  await secretVariableDialog.getByLabel('变量值', { exact: true }).fill('e2e-variable-secret')
  await secretVariableDialog.getByRole('button', { name: '保存变量', exact: true }).click()
  await pageTwo.getByText('API_SECRET', { exact: true }).waitFor({ state: 'visible' })
  if (await pageTwo.getByText('e2e-variable-secret', { exact: true }).count()) throw new Error('Project Secret was rendered in the dashboard')
  await pageTwo.getByRole('button', { name: '编辑 API_SECRET' }).click()
  const secretEditDialog = pageTwo.getByRole('dialog', { name: '编辑项目变量' })
  if (await secretEditDialog.getByLabel('变量值', { exact: true }).inputValue()) throw new Error('Project Secret was disclosed when editing')
  await secretEditDialog.getByRole('button', { name: '关闭' }).click()

  await pageTwo.getByRole('button', { name: '工作流' }).click()
  await pageTwo.locator('.wf-workflow-name').filter({ hasText: draftName }).click()
  await pageTwo.getByRole('button', { name: /节点库/ }).first().click()
  const httpItem = pageTwo.getByRole('button', { name: 'HTTP 请求 从 DSH 主机调用 HTTP API' })
  await httpItem.click()
  await pageTwo.getByText('HTTP Request', { exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByLabel('失败时行为').selectOption('route')
  const errorRouteNode = pageTwo.locator('.react-flow__node').filter({ has: pageTwo.locator('.wf-node--http') }).last()
  await errorRouteNode.locator('.wf-handle--error').waitFor({ state: 'visible' })
  await pageTwo.getByRole('textbox', { name: 'URL', exact: true }).fill('')
  await pageTwo.getByRole('button', { name: '映射URL字段', exact: true }).click()
  await pageTwo.getByLabel('样本来源').selectOption({ label: '项目变量' })
  await pageTwo.locator('.wf-mapper-field').filter({ hasText: 'vars.API_HOST' }).click()
  await pageTwo.getByRole('button', { name: '关闭字段映射器' }).click()
  await pageTwo.getByRole('textbox', { name: 'URL', exact: true }).fill('{{vars.API_HOST}}/items/')
  await pageTwo.getByRole('textbox', { name: '请求头 JSON', exact: true }).fill('{"X-Secret":"')
  await pageTwo.getByRole('button', { name: '映射请求头 JSON字段', exact: true }).click()
  await pageTwo.getByLabel('样本来源').selectOption({ label: '项目变量' })
  await pageTwo.locator('.wf-mapper-field').filter({ hasText: 'vars.API_SECRET' }).click()
  await pageTwo.getByRole('button', { name: '关闭字段映射器' }).click()
  await pageTwo.getByRole('textbox', { name: '请求头 JSON', exact: true }).fill('{"X-Secret":"{{vars.API_SECRET}}"}')
  await pageTwo.locator('select[aria-label="连接"]').first().selectOption(credentials[0].id)
  await pageTwo.getByLabel('重试次数').fill('2')
  await pageTwo.getByLabel('间隔（秒）').fill('0')
  await pageTwo.getByLabel('退避策略').selectOption('exponential')
  const mappingSample = JSON.stringify({ user: { id: 'user-42', active: true }, items: [{ sku: 'sku-1' }] })
  await pageTwo.getByLabel('测试输入').fill(mappingSample)
  await pageTwo.getByRole('button', { name: '映射URL字段', exact: true }).click()
  await pageTwo.getByLabel('字段映射器', { exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByLabel('样本来源').selectOption({ label: '当前测试输入' })
  await pageTwo.locator('.wf-mapper-field').filter({ hasText: 'result.user.id' }).click()
  if (await pageTwo.getByRole('textbox', { name: 'URL', exact: true }).inputValue() !== '{{vars.API_HOST}}/items/{{result.user.id}}') throw new Error('Template field mapping did not insert at the caret')
  await pageTwo.getByRole('button', { name: '关闭字段映射器' }).click()
  await pageTwo.getByRole('button', { name: '测试此节点' }).click()
  await pageTwo.getByRole('tab', { name: /输出/ }).waitFor({ state: 'visible' })
  await pageTwo.locator('textarea.wf-run__box').first().waitFor({ state: 'visible' })
  await pageTwo.locator('.wf-result__logs').waitFor({ state: 'visible' })
  const runText = await pageTwo.locator('.wf-result__logs').textContent()
  if (!runText?.includes('HTTP 200 OK')) throw new Error(`HTTP node logs were not shown: ${runText}`)
  await pageTwo.getByText('执行了 3 次后完成', { exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByRole('tab', { name: '配置' }).click()
  await pageTwo.getByRole('button', { name: /节点库/ }).first().click()
  await pageTwo.getByRole('button', { name: '应用连接器 调用 GitHub、Slack、Notion 等应用动作' }).click()
  await pageTwo.getByText('App Connector', { exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByLabel('应用').selectOption('github')
  if (await pageTwo.getByLabel('动作').inputValue() !== 'create-issue') throw new Error('Connector did not select its first action')
  const connectorCredentials = await pageTwo.getByLabel('连接', { exact: true }).locator('option').allTextContents()
  if (connectorCredentials.some((label) => label.includes('E2E Key')) || !connectorCredentials.some((label) => label.includes('E2E OAuth2'))) throw new Error(`Connector credential filtering failed: ${JSON.stringify(connectorCredentials)}`)
  await pageTwo.getByLabel('连接', { exact: true }).selectOption(credentials[1].id)
  await pageTwo.getByRole('textbox', { name: '仓库所有者', exact: true }).fill('luxi233')
  await pageTwo.getByRole('textbox', { name: '仓库名', exact: true }).fill('dsh-node-flow')
  await pageTwo.getByRole('textbox', { name: '标题', exact: true }).fill('Issue ')
  await pageTwo.getByLabel('测试输入').fill(mappingSample)
  await pageTwo.getByRole('textbox', { name: '标题', exact: true }).press('End')
  await pageTwo.getByRole('button', { name: '映射标题字段', exact: true }).click()
  await pageTwo.getByLabel('样本来源').selectOption({ label: '当前测试输入' })
  await pageTwo.locator('.wf-mapper-field').filter({ hasText: 'result.user.id' }).click()
  if (await pageTwo.getByRole('textbox', { name: '标题', exact: true }).inputValue() !== 'Issue {{result.user.id}}') throw new Error('Connector field mapping did not insert at the caret')
  await pageTwo.getByRole('button', { name: '关闭字段映射器' }).click()
  await waitUntil(() => workflows.find((workflow) => workflow.id === copyWorkflow.id)?.doc.nodes.some((node) => node.data.kind === 'connector'
    && node.data.connectorId === 'github'
    && node.data.connectorAction === 'create-issue'
    && node.data.credentialId === credentials[1].id
    && node.data.connectorParams?.owner === 'luxi233'
    && node.data.connectorParams?.title === 'Issue {{result.user.id}}'), 'connector configuration save')
  await pageTwo.getByRole('button', { name: /节点库/ }).first().click()
  await pageTwo.getByRole('button', { name: '应用触发器 轮询应用并在新事件到达时运行' }).click()
  await pageTwo.getByText('App Trigger', { exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByLabel('应用').selectOption('github')
  if (await pageTwo.getByLabel('事件').inputValue() !== 'new-issue') throw new Error('Polling trigger did not select its first event')
  await pageTwo.getByLabel('连接', { exact: true }).selectOption(credentials[1].id)
  await pageTwo.getByRole('textbox', { name: '仓库所有者', exact: true }).fill('luxi233')
  await pageTwo.getByRole('textbox', { name: '仓库名', exact: true }).fill('dsh-node-flow')
  await pageTwo.getByLabel('轮询间隔（秒）').fill('30')
  if (await pageTwo.getByRole('button', { name: '测试此节点' }).count()) throw new Error('Polling trigger exposed a single-node test action')
  await waitUntil(() => workflows.find((workflow) => workflow.id === copyWorkflow.id)?.doc.nodes.some((node) => node.data.kind === 'connector-trigger'
    && node.data.connectorId === 'github'
    && node.data.connectorTrigger === 'new-issue'
    && node.data.credentialId === credentials[1].id
    && node.data.connectorParams?.repo === 'dsh-node-flow'
    && node.data.pollInterval === '30'), 'polling trigger configuration save')
  const pollingWorkflow = workflows.find((workflow) => workflow.id === copyWorkflow.id)
  pollingWorkflow.publishedDoc = clone(pollingWorkflow.doc)
  await pageTwo.getByText('监听中', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await pageTwo.getByRole('button', { name: '立即轮询' }).click()
  await waitUntil(() => pollingRequests === 1, 'manual polling request')
  await pageTwo.getByRole('button', { name: /节点库/ }).first().click()
  await pageTwo.getByRole('button', { name: '等待 延迟、等待外部回调或人工审批' }).click()
  await pageTwo.getByText('Wait', { exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByLabel('等待方式').selectOption('approval')
  await pageTwo.getByLabel('超时（小时，可选）').fill('24')
  if (await pageTwo.getByRole('button', { name: '测试此节点' }).count()) throw new Error('Wait node exposed a single-node test action')
  await waitUntil(() => workflows.find((workflow) => workflow.id === copyWorkflow.id)?.doc.nodes.some((node) => node.data.kind === 'wait'
    && node.data.waitMode === 'approval'
    && node.data.waitTimeout === '24'), 'waitpoint configuration save')
  await pageTwo.getByRole('button', { name: /节点库/ }).first().click()
  await pageTwo.getByRole('button', { name: 'If 分支 根据布尔条件走不同路径' }).click()
  await pageTwo.getByLabel('测试输入').fill(mappingSample)
  await pageTwo.getByLabel('测试输入').press('End')
  await pageTwo.getByRole('button', { name: '映射Condition字段', exact: true }).click()
  await pageTwo.getByLabel('样本来源').selectOption({ label: '当前测试输入' })
  const activeField = pageTwo.locator('.wf-mapper-field').filter({ hasText: 'result.user.active' })
  try {
    await activeField.waitFor({ state: 'visible', timeout: 5_000 })
  } catch {
    const sources = await pageTwo.getByLabel('样本来源').locator('option').allTextContents()
    const fields = await pageTwo.locator('.wf-mapper-field__path').allTextContents()
    throw new Error(`Condition mapper sample missing: input=${JSON.stringify(await pageTwo.getByLabel('测试输入').inputValue())}, sources=${JSON.stringify(sources)}, fields=${JSON.stringify(fields)}`)
  }
  await activeField.click()
  if (await pageTwo.getByRole('textbox', { name: 'Condition', exact: true }).inputValue() !== 'result.user.active') throw new Error('Expression field mapping inserted template syntax')
  await pageTwo.getByRole('button', { name: '关闭字段映射器' }).click()
  await waitUntil(() => workflows.find((workflow) => workflow.id === copyWorkflow.id)?.doc.nodes.some((node) => node.data.kind === 'http'
    && node.data.credentialId === credentials[0].id
    && node.data.url === '{{vars.API_HOST}}/items/{{result.user.id}}'
     && node.data.headers === '{"X-Secret":"{{vars.API_SECRET}}"}'
     && node.data.retryCount === '2'
     && node.data.retryDelay === '0'
     && node.data.retryBackoff === 'exponential'
     && node.data.onError === 'route'), 'HTTP retry policy and error route save')
  const savedJson = JSON.stringify(workflows.find((workflow) => workflow.id === copyWorkflow.id))
  if (savedJson.includes('not-stored-in-workflow')) throw new Error('Credential secret leaked into workflow JSON')
  const savedWorkflow = workflows.find((workflow) => workflow.id === copyWorkflow.id)
  const savedHttpNode = savedWorkflow.doc.nodes.find((node) => node.data.kind === 'http')
  runs.push({
    id: 'mapping-history-run',
    workflowId: savedWorkflow.id,
    name: savedWorkflow.name,
    startedAt: isoNow(),
    completedAt: isoNow(),
    status: 'ok',
    nodeCount: 1,
    failed: 0,
    nodes: [{ id: savedHttpNode.id, kind: 'http', status: 'ok', input: mappingSample, output: { mapped: true }, ms: 12, attempts: 1 }],
  })

  await pageTwo.reload({ waitUntil: 'domcontentloaded' })
  await pageTwo.getByRole('heading', { name: '工作流' }).waitFor({ state: 'visible', timeout: 10_000 })
  await pageTwo.locator('.wf-workflow-name').filter({ hasText: draftName }).click()
  await pageTwo.locator(`.react-flow__node[data-id="${savedHttpNode.id}"]`).evaluate((element) => element.click())
  if (await pageTwo.getByLabel('失败时行为').inputValue() !== 'route') throw new Error('HTTP error route did not persist after reload')
  await pageTwo.locator(`.react-flow__node[data-id="${savedHttpNode.id}"] .wf-handle--error`).waitFor({ state: 'visible' })
  await pageTwo.getByRole('button', { name: '映射URL字段', exact: true }).click()
  await pageTwo.getByLabel('样本来源').selectOption({ label: '当前节点 · 已保存输入' })
  await pageTwo.locator('.wf-mapper-field').filter({ hasText: 'result.items[0].sku' }).waitFor({ state: 'visible' })
  const historyOption = pageTwo.getByLabel('样本来源').locator('option').filter({ hasText: '历史输入' }).first()
  await historyOption.waitFor({ state: 'attached' })
  await pageTwo.getByLabel('样本来源').selectOption(await historyOption.getAttribute('value'))
  await pageTwo.locator('.wf-mapper-field').filter({ hasText: 'result.user.active' }).waitFor({ state: 'visible' })
  await pageTwo.getByRole('button', { name: '关闭字段映射器' }).click()

  runs.push({
    id: 'interrupted-run',
    workflowId: savedWorkflow.id,
    name: savedWorkflow.name,
    startedAt: isoNow(),
    completedAt: isoNow(),
    status: 'interrupted',
    nodeCount: 1,
    failed: 1,
    nodes: [{ id: savedHttpNode.id, kind: 'http', status: 'error', input: 'sample-input', error: 'process interrupted', ms: 12, attempts: 1 }],
    checkpoint: { nodeId: savedHttpNode.id, input: 'sample-input', updatedAt: isoNow() },
    snapshot: clone(savedWorkflow.doc),
    resumable: true,
  })

  await pageTwo.setViewportSize({ width: 390, height: 844 })
  const mobileMetrics = await pageTwo.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (mobileMetrics.scrollWidth > mobileMetrics.width) throw new Error(`Mobile editor overflowed: ${JSON.stringify(mobileMetrics)}`)
  await pageTwo.getByRole('button', { name: '返回工作流' }).click()
  await pageTwo.getByRole('button', { name: '运行记录' }).click()
  await pageTwo.getByText('已中断', { exact: true }).waitFor({ state: 'visible' })
  const resumeButton = pageTwo.getByRole('button', { name: '从失败处恢复', exact: true })
  await resumeButton.click()
  await pageTwo.getByText('恢复运行', { exact: true }).waitFor({ state: 'visible' })
  await pageTwo.getByText('已恢复', { exact: true }).waitFor({ state: 'visible' })
  if (resumeRequests !== 1) throw new Error(`Expected one resume request, received ${resumeRequests}`)
  await pageTwo.getByRole('button', { name: '连接' }).click()
  const mobileDashboardMetrics = await pageTwo.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (mobileDashboardMetrics.scrollWidth > mobileDashboardMetrics.width) throw new Error(`Mobile credential page overflowed: ${JSON.stringify(mobileDashboardMetrics)}`)
  await pageTwo.getByRole('button', { name: '变量', exact: true }).click()
  await pageTwo.getByText('1 个工作流 · 2 处引用', { exact: true }).first().waitFor({ state: 'visible' })
  if (!(await pageTwo.getByRole('button', { name: '删除 API_SECRET' }).isDisabled())) throw new Error('Referenced project variable deletion was not protected in the UI')
  const mobileVariableMetrics = await pageTwo.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (mobileVariableMetrics.scrollWidth > mobileVariableMetrics.width) throw new Error(`Mobile variable page overflowed: ${JSON.stringify(mobileVariableMetrics)}`)

  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join('\n')}`)
  console.log(JSON.stringify({ ok: true, saveRequests, statusRequests, conflictResponses, credentials: credentials.length, variables: projectVariables.length, resumeRequests, oauthAuthorizationRequests, connectionTestRequests, pollingRequests }, null, 2))
} finally {
  await context.close()
  await browser.close()
  await vite.close()
}

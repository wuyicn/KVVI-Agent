import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const baseUrl = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const authUrl = process.env.DSH_AUTH_URL
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const workflowId = `live-webhook-ui-${suffix}`
const workflowName = `Live Webhook UI ${suffix}`
const credentialName = `__webhook_ui_${suffix}`
const secretValue = `webhook-ui-secret-${suffix}`
const browserErrors = []
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean).find(existsSync)
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

async function currentWorkflow() {
  const data = await requestJson('/dsh-node-flow/workflows')
  return data.workflows?.find((workflow) => workflow.id === workflowId)
}

async function cleanup() {
  const workflow = await currentWorkflow().catch(() => undefined)
  if (workflow) await post('/dsh-node-flow/workflows', { action: 'delete', id: workflowId, expectedRevision: workflow.revision }).catch(() => undefined)
  const listed = await requestJson('/dsh-node-flow/credentials').catch(() => ({ credentials: [] }))
  for (const credential of listed.credentials ?? []) if (credential.name === credentialName) await post('/dsh-node-flow/credentials', { action: 'delete', id: credential.id }).catch(() => undefined)
}

async function waitForWebhookConfiguration() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const workflow = await currentWorkflow()
    const data = workflow?.doc?.nodes?.find((node) => node.id === 'webhook')?.data
    if (data?.webhookSignatureHeader === 'x-live-signature' && data?.webhookIdempotencyHeader === 'idempotency-key' && data?.webhookIdempotencyTtl === '3600' && data?.webhookResponseStatus === '202' && data?.webhookResponseBody === '{"event":"{{result.event}}"}') return { workflow, data }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Timed out waiting for Webhook configuration save')
}

async function openDshPage(page) {
  if (authUrl) await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  else await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
}

let browser
try {
  await cleanup()
  const capabilities = await requestJson('/dsh-node-flow/workflows')
  if (capabilities.capabilities?.webhookSignatures !== true || capabilities.capabilities?.webhookResponses !== true) throw new Error('Running DSH backend does not expose advanced Webhook capabilities')

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
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.getByRole('button', { name: '新建连接', exact: true }).click()
  const credentialDialog = page.getByRole('dialog', { name: '新建连接' })
  await credentialDialog.getByLabel('名称').fill(credentialName)
  await credentialDialog.getByLabel('认证类型').selectOption('webhook-secret')
  await credentialDialog.getByLabel('签名密钥').fill(secretValue)
  if (await credentialDialog.getByLabel('连接测试 URL').count()) throw new Error('Webhook Secret form exposed an outbound connection test')
  await credentialDialog.getByRole('button', { name: '保存连接', exact: true }).click()
  await page.getByText(credentialName, { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.wf-credential-health').filter({ hasText: '密钥已保存' }).waitFor({ state: 'visible' })

  const listedCredentials = await requestJson('/dsh-node-flow/credentials')
  const credentialId = listedCredentials.credentials?.find((credential) => credential.name === credentialName)?.id
  if (!credentialId || JSON.stringify(listedCredentials).includes(secretValue)) throw new Error('Webhook Secret was not stored securely')

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
      doc: {
        version: 1,
        name: workflowName,
        nodes: [{ id: 'webhook', type: 'workflow', position: { x: 180, y: 180 }, data: { kind: 'webhook', label: 'Webhook', httpMethod: 'POST', webhookToken: `uitoken${suffix.replaceAll('-', '')}abcdef`, webhookResponseMode: 'summary' }, style: { width: 224, height: 76 } }],
        edges: [],
      },
    },
  })

  const openWebhook = async () => {
    await openDshPage(page)
    const entry = page.locator('[data-dsh-node-flow-entry]')
    await entry.waitFor({ state: 'visible', timeout: 15_000 })
    if (await entry.count() !== 1) throw new Error(`Expected one node-flow entry, found ${await entry.count()}`)
    await entry.click()
    await page.getByRole('heading', { name: '工作流', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('.wf-workflow-name').filter({ hasText: workflowName }).click()
    await page.locator('.wf-name').waitFor({ state: 'visible' })
    await page.locator('.react-flow__node[data-id="webhook"]').evaluate((element) => element.click())
    await page.getByLabel('Webhook Secret').waitFor({ state: 'visible' })
  }

  await openWebhook()
  await page.getByLabel('Webhook Secret').selectOption(credentialId)
  await page.getByLabel('签名 Header').fill('x-live-signature')
  await page.getByLabel('幂等键 Header').fill('idempotency-key')
  await page.getByLabel('幂等记录保留').fill('3600')
  await page.getByLabel('响应模式').selectOption('custom')
  await page.getByLabel('状态码').fill('202')
  await page.getByRole('textbox', { name: '响应 Headers JSON', exact: true }).fill('{"content-type":"application/json","x-event":"{{result.event}}"}')
  await page.getByRole('textbox', { name: '响应 Body', exact: true }).fill('{"event":"{{result.event}}"}')
  const saved = await waitForWebhookConfiguration()
  if (saved.data.credentialId !== credentialId || saved.data.webhookResponseMode !== 'custom' || saved.data.webhookIdempotencyHeader !== 'idempotency-key') throw new Error('Webhook security configuration was not persisted')

  await openWebhook()
  await page.waitForFunction((expectedCredentialId) => {
    const select = [...document.querySelectorAll('select')].find((element) => element.labels?.[0]?.textContent?.includes('Webhook Secret'))
    return select?.value === expectedCredentialId
  }, credentialId)
  if (await page.getByLabel('Webhook Secret').inputValue() !== credentialId) throw new Error('Webhook Secret selection did not survive reload')
  if (await page.getByLabel('幂等键 Header').inputValue() !== 'idempotency-key' || await page.getByLabel('幂等记录保留').inputValue() !== '3600') throw new Error('Webhook idempotency configuration did not survive reload')
  if (await page.getByLabel('响应模式').inputValue() !== 'custom' || await page.getByRole('textbox', { name: '响应 Body', exact: true }).inputValue() !== '{"event":"{{result.event}}"}') throw new Error('Webhook response configuration did not survive reload')
  await page.setViewportSize({ width: 390, height: 844 })
  const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  if (metrics.scrollWidth > metrics.width) throw new Error(`Webhook editor overflowed on mobile: ${JSON.stringify(metrics)}`)
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`)

  console.log(JSON.stringify({ ok: true, credentialPersisted: true, responsePersisted: true, secretHidden: true, mobileOverflow: false }, null, 2))
} finally {
  await browser?.close().catch(() => undefined)
  await cleanup().catch(() => undefined)
}

/** Built-client UI check over isolated fixtures; never connects to the pilot service. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { signModeHeaders } from '../../../packages/host/kvvi-mode-router/src/index.ts'

it('loads the publish tool with its build-intent schema and refuses unattended submission', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'kvvi-publish-composition-'))
  const overlay = join(folder, 'publish.yml')
  await writeFile(overlay, `- insert:
    - id: kvvi-mode-router
      name: '@deepseek-ai/dsh-host-kvvi-mode-router'
      config:
        secret: test-composition-secret
    - id: kvvi-publish
      name: '@deepseek-ai/dsh-tool-kvvi-publish'
      config:
        platformUrl: http://127.0.0.1:1
        contextSecret: test-composition-secret
`)
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  try {
    const schema = scaffold.ctx.tools.schemas().find(tool => tool.name === 'publish_submit')
    expect(schema).toBeDefined()
    expect(JSON.stringify(schema)).toContain('buildIntentId')
    const result = await scaffold.ctx.tools.execute({
      callId: ToolCallId('unattended-publish'), name: 'publish_submit', arguments: { system: 'new_form' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('KVVI_PLATFORM_UNREACHABLE')
  } finally { await scaffold.close(); await rm(folder, { recursive: true, force: true }) }
}, 120_000)

it('renders the Harness business layout and submits through the authorized record API', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'kvvi-business-fixture-'))
  const overlay = join(folder, 'ui.yml')
  await writeFile(overlay, '- insert:\n    - id: kvvi-panel\n      name: "@deepseek-ai/dsh-client-kvvi-panel"\n')
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1440, height: 1000 })
    const tripwire = watchConsole(page)
    const fields = [{ field_code: 'name', label: 'Customer name', type: 'short_text' }, { field_code: 'secret', label: 'Hidden amount' }]
    const system = { systemId: 'fixture', assetId: 'customer', name: 'Customer registration', schemaCode: 'customer', publishedAt: '2026-10-08' }
    const runtime = { system, models: { customer: { fields } }, views: { customer: { name: 'Customer form', view_type: 'FORM', componentsTree: [{ id: 'root', componentName: 'FormPage', children: [{ id: 'name', componentName: 'ShortTextField', props: { fieldBinding: { fieldRef: 'name' } } }] }] } }, workflows: {} }
    const rows = [{ recordId: 'r1', rowVersion: 1, recordNo: 'R1', data: { name: 'Alice' } }]
    let creates = 0
    let gateway = 'USER'
    const groups: { groupId: string; name: string; position: number; version: number }[] = []
    let archived = false
    await page.route('**/auth/session', route => route.fulfill({ json: { gateway, allowedGateways: ['USER', 'BUILDER'], companyId: 'fixture-company', userId: 'fixture-user', sessionId: 'fixture-login', login: 'fixture-builder', companyName: 'UI test' } }))
    await page.route('**/auth/enter-builder', async (route) => {
      expect(route.request().method()).toBe('POST')
      expect(route.request().headers()['x-kvvi-builder-intent']).toBe('1')
      gateway = 'BUILDER'
      await route.fulfill({ json: { gateway, sessionId: 'fixture-builder-session' } })
    })
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      let json: unknown = { items: [system] }
      if (path.endsWith('/business-directory')) json = { groups, forms: archived === new URL(request.url()).searchParams.has('archived') ? [{ ...system, groupId: null, archived, version: 0, actions: ['read', 'create'] }] : [] }
      else if (path.endsWith('/business-groups')) {
        expect(request.method()).toBe('POST')
        expect(request.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u)
        groups.push({ groupId: 'fixture-group', name: request.postDataJSON().name, position: 0, version: 1 })
        json = { result: groups[0], auditPending: false }
      }
      else if (path.endsWith('/archive') || path.endsWith('/restore')) {
        expect(request.postDataJSON().confirmed).toBe(true)
        archived = path.endsWith('/archive'); json = { result: { assetId: 'customer', archived }, auditPending: false }
      }
      else if (path.endsWith('/runtime')) json = runtime
      else if (path.endsWith('/capabilities')) json = { role: 'builder' }
      else if (path.endsWith('/fields')) json = { fields: [fields[0]] }
      else if (path.endsWith('/records')) {
        if (request.method() === 'POST') {
          expect(request.postDataJSON()).toEqual({ data: { name: 'Bob' } })
          creates++
          rows.push({ recordId: 'r2', rowVersion: 1, recordNo: 'R2', data: { name: 'Bob' } })
          json = { recordId: 'r2', rowVersion: 1 }
        } else json = { items: rows, fieldVisibility: { name: 'VISIBLE', secret: 'HIDDEN' } }
      }
      await route.fulfill({ json })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Business', exact: true }).click()
    await page.getByRole('heading', { name: 'Customer form', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Open business', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'New group', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'New form', exact: true }).click()
    await page.getByRole('dialog', { name: 'New business' }).waitFor()
    expect(new URL(page.url()).pathname).toBe('/')
    expect(creates).toBe(0)
    expect(await page.getByLabel('Save location', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Choose folder', exact: true }).count()).toBe(0)
    expect(await page.getByLabel('Requirements', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Start building', exact: true }).isEnabled()).toBe(true)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'New group', exact: true }).click()
    await page.getByLabel('Group name', { exact: true }).fill('Sales team')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.getByRole('button', { name: 'Sales team', exact: true }).waitFor()
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Business', exact: true }).click()
    await page.getByRole('button', { name: 'Sales team', exact: true }).waitFor()
    await page.getByRole('heading', { name: 'Customer form', exact: true }).waitFor()
    expect(await page.getByRole('columnheader', { name: 'Hidden amount' }).count()).toBe(0)
    await page.getByRole('textbox', { name: 'Search current form records' }).fill('Alice')
    await page.getByRole('button', { name: 'New record', exact: true }).click()
    await page.getByLabel('name', { exact: true }).fill('Bob')
    await page.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    await page.getByRole('textbox', { name: 'Search current form records' }).fill('')
    await page.getByRole('button', { name: 'Bob', exact: true }).waitFor()
    expect(creates).toBe(1)
    await page.screenshot({ path: '../../.superpowers/grouped-business-built-fixture.png' })
    await page.getByRole('button', { name: 'Archive form', exact: true }).click()
    expect(archived).toBe(false)
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Customer form', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Archived', exact: true }).click()
    await page.getByRole('button', { name: 'Restore form', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(() => archived).toBe(false)
    await page.getByRole('button', { name: 'Active forms', exact: true }).click()
    await page.getByRole('button', { name: 'Bob', exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
    await rm(folder, { recursive: true, force: true })
  }
}, 120_000)

it('allocates managed builder storage through the real authenticated HTTP composition', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'kvvi-managed-http-'))
  const overlay = join(folder, 'ui.yml')
  const secret = 'managed-builder-test'
  await writeFile(overlay, `- insert:\n    - id: kvvi-mode-router\n      name: '@deepseek-ai/dsh-host-kvvi-mode-router'\n      config:\n        secret: ${secret}\n`)
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  const path = '/api/kvvi-business-directory/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const identity = { companyId: 'test-company', userId: 'test-builder', sessionId: 'test-login', gateway: 'BUILDER' as const }
  try {
    expect((await scaffold.hostFetch(path, { method: 'POST' })).status).toBe(401)
    expect((await scaffold.hostFetch(path, { method: 'POST', headers: signModeHeaders({ ...identity, gateway: 'USER' }, secret) })).status).toBe(403)
    const create = () => scaffold.hostFetch(path, { method: 'POST', headers: signModeHeaders(identity, secret) })
    const first = await create()
    expect(first.status).toBe(200)
    const value = await first.json() as { path: string }
    expect(value.path.startsWith(join(scaffold.harnessHome, 'business-workspaces'))).toBe(true)
    expect(await (await create()).json()).toEqual(value)
    expect((await scaffold.hostFetch(path, { headers: signModeHeaders(identity, secret) })).status).toBe(405)
  } finally { await scaffold.close(); await rm(folder, { recursive: true, force: true }) }
}, 120_000)

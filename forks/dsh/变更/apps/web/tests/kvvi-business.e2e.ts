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
    await page.route('**/kvvi/builder/login', route => route.fulfill({ contentType: 'text/html', body: '<h1>Builder login</h1>' }))
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
    await page.waitForURL('**/kvvi/builder/login')
    expect(creates).toBe(0)
    gateway = 'BUILDER'
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Business', exact: true }).click()
    await page.getByRole('button', { name: 'New form', exact: true }).click()
    await page.getByRole('dialog', { name: 'New business' }).waitFor()
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

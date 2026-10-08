/** Built-client UI check over isolated fixtures; never connects to the pilot service. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

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
    await page.route('**/auth/session', route => route.fulfill({ json: { gateway, allowedGateways: ['USER', 'BUILDER'], login: 'fixture-builder', companyName: 'UI test' } }))
    await page.route('**/kvvi/builder/login', route => route.fulfill({ contentType: 'text/html', body: '<h1>Builder login</h1>' }))
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      let json: unknown = { items: [system] }
      if (path.endsWith('/runtime')) json = runtime
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
    await page.getByRole('button', { name: 'Open business', exact: true }).waitFor()
    await page.getByRole('button', { name: 'New business', exact: true }).click()
    await page.waitForURL('**/kvvi/builder/login')
    expect(creates).toBe(0)
    gateway = 'BUILDER'
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Business', exact: true }).click()
    await page.getByRole('button', { name: 'New business', exact: true }).click()
    await page.getByRole('dialog', { name: 'New business' }).waitFor()
    await page.keyboard.press('Escape')
    expect(await page.getByRole('columnheader').allTextContents()).toEqual(['Business name', 'Contents', 'Status', 'Actions'])
    await page.screenshot({ path: '/tmp/kvvi-prototype-proof-home.png' })
    await page.getByRole('button', { name: 'Open business', exact: true }).click()
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
    await page.screenshot({ path: '/tmp/kvvi-prototype-proof-records.png' })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
    await rm(folder, { recursive: true, force: true })
  }
}, 120_000)

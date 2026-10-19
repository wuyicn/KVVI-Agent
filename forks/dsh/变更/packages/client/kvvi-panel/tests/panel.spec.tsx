// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KvviTranslate } from '../src/client/Panel.tsx'
import { KvviPanel } from '../src/client/Panel.tsx'
import { zh } from '../src/client/locales.ts'
import {businessFetch} from './record-write-server.ts'

/**
 * The dictionary as a plain function, as the slot renderer supplies it.
 *
 * Asserted rather than annotated: this looks the key up in `zh`, while the
 * renderer's `t` is typed to the namespace's key union. The assertion is the
 * test's whole point (no real renderer here), and a wrong key still shows up
 * as the key itself rather than as a compile error.
 */
const t = ((key: string, params?: Readonly<Record<string, unknown>>): string => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ''))
}) as KvviTranslate
const caps = (role: string | null) => ({
  role, canManageMembers: role !== null, canManageRoles: role !== null,
  canManagePlatformRoles: role === 'owner', canManageBuilder: role === 'owner',
  dimensions: ['FORM', 'FIELD', 'FLOW', 'DATA'], dataScopes: ['SELF'], fieldVisibilities: ['VISIBLE'],
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('business panel navigation', () => {
  it('withholds administration while capabilities load and for an employee', async () => {
    let answer: (value: Response) => void = () => {}
    vi.stubGlobal('fetch', businessFetch((url: string) => url.endsWith('/capabilities')
      ? new Promise<Response>(resolve => { answer = resolve })
      : Promise.resolve(new Response(JSON.stringify({ items: [] })))))
    render(<KvviPanel t={t} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: zh['admin.title'] })).toBeNull()
    answer(new Response(JSON.stringify(caps(null))))
    await screen.findByText(zh['systems.empty'])
    expect(screen.queryByRole('button', { name: zh['admin.title'] })).toBeNull()
  })

  it.each(['owner', 'admin'])('keeps administration accessible to %s', async role => {
    vi.stubGlobal('fetch', businessFetch((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.endsWith('/capabilities') ? caps(role) : { items: [] },
    )))))
    render(<KvviPanel t={t} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['admin.title'] }))
    await screen.findByRole('button', { name: zh['admin.tab.members'] })
    expect(screen.queryByText(zh['admin.noPermission'])).toBeNull()
  })

  it('keeps business usable when capabilities fail and lets the user retry', async () => {
    let unavailable = true
    vi.stubGlobal('fetch', businessFetch((url: string) => {
      if (url.endsWith('/capabilities') && unavailable) return Promise.reject(new Error('offline'))
      return Promise.resolve(new Response(JSON.stringify(url.endsWith('/capabilities') ? caps('owner') : { items: [] })))
    }))
    render(<KvviPanel t={t} onClose={() => {}} />)
    await screen.findByText(zh['systems.empty'])
    expect(screen.queryByRole('button', { name: zh['admin.title'] })).toBeNull()
    unavailable = false
    fireEvent.click(await screen.findByRole('button', { name: '重新检查权限' }))
    await screen.findByRole('button', { name: zh['admin.title'] })
  })

  it('closes with Escape and exposes a modal dialog', async () => {
    vi.stubGlobal('fetch', businessFetch((url: string) => Promise.resolve(new Response(JSON.stringify(
      url.endsWith('/capabilities') ? caps(null) : { items: [] },
    )))))
    const close = vi.fn()
    render(<KvviPanel t={t} onClose={close} />)
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
    await waitFor(() => { expect(screen.getByText(zh['systems.empty'])).toBeTruthy() })
  })
})

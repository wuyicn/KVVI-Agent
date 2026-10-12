// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { BuilderPreview } from '../src/client/BuilderPreview.tsx'
import { createBusinessStore } from '../src/client/business-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const intent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const copy = (key: keyof typeof zh, p?: Record<string, unknown>) => Object.entries(p ?? {}).reduce<string>((s, [k, v]) => s.replace(`{${k}}`, String(v)), zh[key])
const draft = {
  intentId: intent, assetId: 'shop', digest: 'sha256:1', validation: 'not_checked', canSubmit: false,
  model: { schema_code: 'shop', name: '店铺', fields: [
    { field_code: 'account', label: '店铺账号', type: 'short_text', required: true, constraints: { trim: true, min_length: 3 } },
    { field_code: 'platform', label: '平台', type: 'single_select', required: true, type_config: { options: [{ code: 'taobao', label: '淘宝', enabled: true }] } },
    { field_code: 'date', label: '开店日期', type: 'date', required: false },
    { field_code: 'notes', label: '备注', type: 'long_text', required: false },
  ] },
  view: { view_code: 'shop_form', name: '店铺登记', view_type: 'FORM', componentsTree: [{ id: 'page', componentName: 'FormPage', children: [
    { id: 'account', componentName: 'ShortTextField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'account' } } },
    { id: 'platform', componentName: 'SingleSelectField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'platform' } } },
    { id: 'date', componentName: 'DateField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'date' } } },
    { id: 'notes', componentName: 'LongTextField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'notes' } } },
  ] }] }, uniqueRules: [['account']],
}
function props() {
  const store = createBusinessStore().create()
  return { intentId: intent, running: false, t: copy,
    useStore: (f: (s: ReturnType<typeof store.getSnapshot>) => unknown) =>
      f(useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())),
    actions: store.actions,
  } as Parameters<typeof BuilderPreview>[0]
}
it('previews an unpublished real draft and checks required and duplicate example values without writing records', async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url === '/auth/session'
    ? { companyId: 'c', userId: 'u', sessionId: 'login', gateway: 'BUILDER' } : draft))
  vi.stubGlobal('fetch', fetcher)
  render(<BuilderPreview {...props()}/>)
  await screen.findByRole('heading', { name: '店铺登记' })
  expect(screen.getByRole('button', { name: '确认提交' }).hasAttribute('disabled')).toBe(true)
  await vi.waitFor(() =>{  expect(screen.getByRole('button', { name: '检查试填' })).toHaveProperty('disabled', false) })
  fireEvent.click(screen.getByRole('button', { name: '检查试填' }))
  expect(screen.getByRole('alert').textContent).toContain('店铺账号')
  fireEvent.change(screen.getByLabelText('account'), { target: { value: 'shop001' } })
  fireEvent.change(screen.getByLabelText('platform'), { target: { value: 'taobao' } })
  fireEvent.click(screen.getByRole('button', { name: '检查试填' }))
  expect(await screen.findByText(/试填通过/u)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '检查试填' }))
  expect(screen.getByRole('alert').textContent).toContain('重复')
  expect(fetcher.mock.calls.every(([, init]) => init === undefined || (init).method === 'GET')).toBe(true)
  expect(fetcher.mock.calls.some(([url]) => url.includes('/records') || url.includes('/publish'))).toBe(false)
})
it('does not read a draft for an employee and reports an explicit failure', async () => {
  const fetcher = vi.fn(async () => Response.json({ gateway: 'USER', companyId: 'c', userId: 'u', sessionId: 'login' }))
  vi.stubGlobal('fetch', fetcher)
  render(<BuilderPreview {...props()}/>)
  expect((await screen.findByRole('alert')).textContent).toContain('搭建者')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('discards a late preview after navigating to a different intent', async () => {
  let finish: (response: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/auth/session'
    ? Response.json({ gateway: 'BUILDER', companyId: 'c', userId: 'u', sessionId: 'login' })
    : url.endsWith(intent) ? new Promise<Response>((r) => { finish = r }) : Response.json({ error: 'KVVI_PREVIEW_UNAVAILABLE' }, { status: 404 })))
  const p = props(), view = render(<BuilderPreview {...p}/>)
  await vi.waitFor(() =>{  expect(vi.mocked(fetch).mock.calls.length).toBe(2) })
  view.rerender(<BuilderPreview {...p} intentId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"/>)
  await screen.findByRole('alert')
  finish(Response.json(draft))
  await vi.waitFor(() =>{  expect(screen.queryByRole('heading', { name: '店铺登记' })).toBeNull() })
})

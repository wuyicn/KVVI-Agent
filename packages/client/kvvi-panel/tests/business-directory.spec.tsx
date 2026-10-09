// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BusinessPage, BusinessSession, type BusinessSessionProps, type BusinessPageProps } from '../src/client/BusinessPage.tsx'
import { createBusinessStore } from '../src/client/business-store.ts'
import { zh } from '../src/client/locales.ts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const form = (assetId = 'customer', actions = ['read']) => ({ assetId, systemId: assetId, name: assetId, schemaCode: assetId, publishedAt: '', groupId: 'g1' as string | null, archived: false, version: 0, actions })
function fixture(gateway = 'BUILDER', forms = [form()]) {
  let groups = [{ groupId: 'g1', name: '客户管理', version: 1, position: 0 }]
  let archived = false
  const store = createBusinessStore().create()
  const requests: { url: string; init?: RequestInit | undefined }[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    if (url === '/auth/session') return Response.json({ gateway, allowedGateways: [gateway], companyId: 'c1', userId: 'u1', sessionId: 's1' })
    if (url.includes('/business-directory')) return Response.json({ groups, forms: forms.filter(f => f.archived === url.endsWith('archived=true')) })
    if (url.endsWith('/business-groups')) { groups = [...groups, { groupId: 'g2', name: JSON.parse(String(init?.body)).name, version: 1, position: 0 }]; return Response.json({ result: groups[1], auditPending: false }) }
    if (url.endsWith('/archive') || url.endsWith('/restore')) { archived = !archived; forms[0]!.archived = archived; return Response.json({ result: { assetId: forms[0]!.assetId }, auditPending: false }) }
    return Response.json({ role: null, items: forms })
  })
  vi.stubGlobal('fetch', fetch)
  const props = {
    t: (key: string) => (zh as Record<string, string>)[key] ?? key,
    useStore: (select: (s: ReturnType<typeof store.getSnapshot>) => unknown) =>
      select(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    actions: store.actions,
    useSessions: (s: (v: unknown) => unknown) => s({ byId: {} }), useWorkspaces: (s: (v: unknown) => unknown) => s({ items: [] }),
    SessionProvider: ({ children }: { children: ReactNode }) => children,
    renderSlot: (_seat: string, p: { address: string }) => <output aria-label="当前地址">{p.address}</output>,
    bindBusiness: vi.fn(async () => ({ sessionId: 's1', release: vi.fn() })), back: vi.fn(), manage: vi.fn(),
  } as unknown as BusinessPageProps
  return { props, requests, fetch, store }
}
it('opens the first server form directly, searches the whole directory, and hides management for employees', async () => {
  const f = fixture('USER', [form(), { ...form('orders'), groupId: null }]); render(<BusinessPage {...f.props}/>)
  expect(await screen.findByLabelText('当前地址')).toHaveProperty('textContent', 'dsh-resource://kvvi-business/customer/records')
  expect(screen.queryByRole('button', { name: '进入业务' })).toBeNull()
  expect(screen.queryByRole('button', { name: '新增分组' })).toBeNull()
  expect(screen.queryByRole('button', { name: '归档表单' })).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: '搜索表单' }), { target: { value: 'orders' } })
  fireEvent.click(screen.getByRole('button', { name: 'orders' }))
  await vi.waitFor(() => expect(screen.getByLabelText('当前地址').textContent).toContain('/orders/records'))
  expect(screen.queryByRole('button', { name: 'customer' })).toBeNull()
})
it('opens create-only forms in fill mode without a record list request', async () => {
  const f = fixture('USER', [form('customer', ['create'])]); render(<BusinessPage {...f.props}/>)
  expect(await screen.findByLabelText('当前地址')).toHaveProperty('textContent', 'dsh-resource://kvvi-business/customer/form')
  expect(f.requests.some(r => r.url.endsWith('/records'))).toBe(false)
})
it('does not open record content or bind an AI session for a management-only builder', async () => {
  const f = fixture('BUILDER', [form('customer', [])]); render(<BusinessPage {...f.props}/>)
  await screen.findByText('你可以管理此表单，但没有记录使用权限。')
  expect(f.props.bindBusiness).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('当前地址')).toBeNull()
})
it('creates a group on the server and requires archive and restore confirmation', async () => {
  const f = fixture(); render(<BusinessPage {...f.props}/>); await screen.findByLabelText('当前地址')
  fireEvent.click(screen.getByRole('button', { name: '新增分组' }))
  fireEvent.change(screen.getByLabelText('分组名称'), { target: { value: '销售' } })
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认' }))
  await screen.findByRole('button', { name: '销售' })
  const write = f.requests.find(r => r.url.endsWith('/business-groups'))!
  expect(write.init?.headers).toEqual(expect.objectContaining({ 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/u) }))
  fireEvent.click(screen.getByRole('button', { name: '归档表单' }))
  expect(f.requests.some(r => r.url.endsWith('/archive'))).toBe(false)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认' }))
  await vi.waitFor(() => expect(screen.queryByLabelText('当前地址')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '已归档' }))
  fireEvent.click(await screen.findByRole('button', { name: '恢复表单' }))
  expect(f.requests.some(r => r.url.endsWith('/restore'))).toBe(false)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认' }))
  await vi.waitFor(() => expect(f.requests.some(r => r.url.endsWith('/restore'))).toBe(true))
})
it('discards a late session binding after selecting another form', async () => {
  const f = fixture('USER', [form(), form('orders')])
  let resolve!: (v: { sessionId: string; release: () => void }) => void
  const release = vi.fn()
  f.props.bindBusiness = vi.fn(s => s.assetId === 'customer' ? new Promise((r) => { resolve = r }) : Promise.resolve({ sessionId: 'orders', release: vi.fn() })) as BusinessPageProps['bindBusiness']
  render(<BusinessPage {...f.props}/>); fireEvent.click(await screen.findByRole('button', { name: 'orders' }))
  await screen.findByLabelText('当前地址')
  await act(async () => { resolve({ sessionId: 'late', release }) })
  expect(release).toHaveBeenCalledOnce()
  expect(screen.getByLabelText('当前地址').textContent).toContain('/orders/records')
})
it('clears drafts and an open builder dialog when the authenticated company changes', async () => {
  const f = fixture(); render(<BusinessPage {...f.props}/>); await screen.findByLabelText('当前地址')
  act(() => { f.store.actions.change('customer', { private: 'old company draft' }) })
  fireEvent.click(screen.getByRole('button', { name: '新增表单' }))
  fireEvent.change(screen.getByLabelText('业务需求'), { target: { value: 'private company requirements' } })
  f.fetch.mockImplementation(async (url: string) => url === '/auth/session'
    ? Response.json({ gateway: 'USER', allowedGateways: ['USER'], companyId: 'c2', userId: 'u2', sessionId: 's2' })
    : Response.json({ groups: [], forms: [], role: null }))
  fireEvent.click(screen.getByRole('button', { name: '刷新目录' }))
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'customer' })).toBeNull())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.store.getSnapshot().drafts).toEqual({})
})
it('reports an invalid directory response as a failure, not an empty directory or an exception', async () => {
  const { loadDirectory } = await import('../src/client/business-directory-api.ts')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ groups: [], forms: [{}] })))
  expect(await loadDirectory({})).toEqual({ ok: false, code: 'KVVI_BAD_RESPONSE', status: 200 })
})
it('refreshes after a version conflict, preserving the form and requiring renewed confirmation', async () => {
  const f = fixture(); const original = f.fetch.getMockImplementation()!
  f.fetch.mockImplementation(async (url, init) => url.endsWith('/archive') ? Response.json({ error: 'KVVI_DIRECTORY_VERSION_CONFLICT' }, { status: 409 }) : original(url, init))
  render(<BusinessPage {...f.props}/>); await screen.findByLabelText('当前地址')
  fireEvent.click(screen.getByRole('button', { name: '归档表单' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认' }))
  await screen.findByText('目录已更新，请关闭窗口，核对最新状态后重新操作。')
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: '确认' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'customer' })).toBeTruthy()
})
it('clears the retained session store before displaying a different authenticated identity', async () => {
  const f = fixture()
  f.store.actions.identify('old-login'); f.store.actions.change('customer', { name: 'old-company' })
  f.fetch.mockImplementation(async () => Response.json({ error: 'KVVI_NOT_ALLOWED' }, { status: 403 }))
  const props = { ...f.props, identity: 'new-login', address: 'dsh-resource://kvvi-business/customer/form', navigate: vi.fn(),
    usePanelInfo: (s: (v: unknown) => unknown) => s({ activePanelId: 'kvvi-business' }),
    useSession: (s: (v: unknown) => unknown) => s({ openState: 'open' }),
    useConversation: (s: (v: unknown) => unknown) => s({ views: { get: () => undefined } }),
  } as unknown as BusinessSessionProps
  render(<BusinessSession {...props}/>)
  await vi.waitFor(() => expect(f.store.getSnapshot().drafts).toEqual({}))
})
it('ignores a previous identity write completion instead of modifying the new identity draft', () => {
  const store = createBusinessStore().create()
  store.actions.identify('old'); store.actions.begin('customer')
  store.actions.identify('new'); store.actions.change('customer', { name: 'same value' })
  store.actions.finish('customer', { busy: false, error: 'old error' }, false, 'old')
  store.actions.invalidate('customer', 'old')
  store.actions.clearIfUnchanged('customer', { name: 'same value' }, 'old')
  expect(store.getSnapshot().writes).toEqual({})
  expect(store.getSnapshot().revisions).toEqual({})
  expect(store.getSnapshot().drafts.customer).toEqual({ name: 'same value' })
})

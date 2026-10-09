// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BusinessPage, type BusinessPageProps } from '../src/client/BusinessPage.tsx'
import { createBusinessStore } from '../src/client/business-store.ts'
import { zh } from '../src/client/locales.ts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('creates a server intent for the chosen group before starting the real builder conversation', async () => {
  const calls: { url: string; body: unknown; key: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get('idempotency-key') })
    if (url === '/auth/session') return Response.json({ gateway: 'BUILDER', companyId: 'c', userId: 'u', sessionId: 's' })
    if (url.endsWith('/business-build-intents')) return Response.json({ intentId: 'intent-from-server', version: 1 })
    return Response.json({ forms: [], groups: [{ groupId: 'g1', name: '销售', position: 0, version: 1 }], role: null })
  }))
  const store = createBusinessStore().create(), startBuilder = vi.fn(async () => {})
  const props = {
    t: (key: string) => (zh as Record<string, string>)[key] ?? key,
    useStore: (select: (s: ReturnType<typeof store.getSnapshot>) => unknown) => select(store.getSnapshot()), actions: store.actions,
    useSessions: (select: (s: unknown) => unknown) => select({ byId: {} }),
    useWorkspaces: (select: (s: unknown) => unknown) => select({ items: [] }),
    startBuilder, pickDirectory: async () => '/workspace',
  } as unknown as BusinessPageProps
  render(<BusinessPage {...props}/>); fireEvent.click(await screen.findByRole('button', { name: '新增表单' }))
  fireEvent.change(screen.getByLabelText('业务名称'), { target: { value: '新表单' } })
  fireEvent.change(screen.getByLabelText('业务需求'), { target: { value: '登记联系人' } })
  fireEvent.change(screen.getByLabelText('所属分组'), { target: { value: 'g1' } })
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '开始搭建' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: '开始搭建' }))
  await vi.waitFor(() => expect(startBuilder).toHaveBeenCalledExactlyOnceWith('/workspace', '新表单', '登记联系人', 'intent-from-server'))
  expect(calls.find(c => c.url.endsWith('/business-build-intents'))?.body).toEqual({ groupId: 'g1' })
  fireEvent.click(screen.getByRole('button', { name: '新增表单' }))
  fireEvent.change(screen.getByLabelText('业务名称'), { target: { value: '另一个表单' } })
  fireEvent.change(screen.getByLabelText('所属分组'), { target: { value: 'g1' } })
  fireEvent.click(screen.getByRole('button', { name: '开始搭建' }))
  await vi.waitFor(() => expect(startBuilder).toHaveBeenCalledTimes(2))
  const intents = calls.filter(c => c.url.endsWith('/business-build-intents'))
  expect(intents[0]?.key).not.toBe(intents[1]?.key)
})
it('does not infer an edit workspace from its display name', async () => {
  const { editWorkspace } = await import('../src/client/business-binding.ts')
  const absent = { workspaceId: 'w1', hint: { kind: 'absent' as const } }
  const matching = { workspaceId: 'w2', hint: { kind: 'selected' as const, assetId: 'customer' } }
  expect(editWorkspace([absent], 'customer')).toBeUndefined()
  expect(editWorkspace([absent, matching], 'customer')).toBe('w2')
  expect(editWorkspace([absent], 'customer', 'w1')).toBe('w1')
  expect(editWorkspace([matching], 'orders', 'w2')).toBeUndefined()
})

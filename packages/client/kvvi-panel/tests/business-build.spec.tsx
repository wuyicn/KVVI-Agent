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
it('resumes a partially created builder operation without recreating its directory', async () => {
  const { createBuilderStarter } = await import('../src/client/builder-start.ts')
  const createDirectory = vi.fn(async () => '/created'), createWorkspace = vi.fn(async () => 'w1')
  const createSession = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('s1')
  const send = vi.fn(async () => {})
  const start = createBuilderStarter({ createDirectory, createWorkspace, createSession, send })
  await expect(start('/parent', 'form', 'purpose', 'intent')).rejects.toThrow('offline')
  await start('/parent', 'form', 'purpose', 'intent')
  expect(createDirectory).toHaveBeenCalledTimes(1); expect(createWorkspace).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledExactlyOnceWith('s1', expect.stringContaining('intent'), expect.any(String))
  await expect(start('/other', 'different', 'purpose', 'intent')).rejects.toThrow('KVVI_BUILD_INPUT_CHANGED')
})
it('AI workspace selection refuses conflicting markers and ambiguous legacy names', async () => {
  const { businessWorkspace } = await import('../src/client/business-binding.ts')
  const a = { assetId: 'a', systemId: 'sa', name: 'same', schemaCode: 'a', publishedAt: '' }
  const b = { ...a, assetId: 'b', systemId: 'sb' }
  const candidates = [{ workspaceId: 'w1', title: 'same', hint: { kind: 'selected' as const, assetId: 'a' } }]
  expect(businessWorkspace(candidates, [a, b], 'b', 'w1')).toBeUndefined()
  expect(businessWorkspace([{ ...candidates[0]!, hint: { kind: 'absent' } }], [a, b], 'b')).toBeUndefined()
  expect(businessWorkspace(candidates, [a, b], 'a')?.workspaceId).toBe('w1')
})
it('retries a failed initial prompt with the same request identity and no duplicate setup', async () => {
  const { createBuilderStarter } = await import('../src/client/builder-start.ts')
  const createDirectory = vi.fn(async () => '/created'), createWorkspace = vi.fn(async () => 'w1')
  const createSession = vi.fn(async () => 's1')
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
  const start = createBuilderStarter({ createDirectory, createWorkspace, createSession, send })
  await expect(start('/parent', 'form', 'purpose', 'intent')).rejects.toThrow('offline')
  await start('/parent', 'form', 'purpose', 'intent')
  await start('/parent', 'form', 'purpose', 'intent')
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
  expect(createDirectory).toHaveBeenCalledTimes(1)
  expect(createWorkspace).toHaveBeenCalledTimes(1)
  expect(createSession).toHaveBeenCalledTimes(1)
})

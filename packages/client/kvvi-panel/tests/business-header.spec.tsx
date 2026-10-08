// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BusinessHeader } from '../src/client/BusinessHeader.tsx'
import { zh } from '../src/client/locales.ts'
const system = { assetId: 'customer', systemId: 'published', name: 'customer', schemaCode: 'customer', publishedAt: '' }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const t = (key: string) => (zh as Record<string, string>)[key] ?? key
function props(resolveBusiness: () => Promise<typeof system | undefined>) {
  return { sessionId: 's1', t, resolveBusiness, open: vi.fn(), choose: vi.fn(),
    useSessions: (select: (s: object) => unknown) => select({ byId: { s1: { cwd: '/客户登记系统' } } }),
    useWorkspaces: (select: (s: object) => unknown) => select({ items: [] }),
  } as unknown as Parameters<typeof BusinessHeader>[0]
}
it('opens form and record resources for the explicit workspace binding despite a different folder name', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [system] })))))
  const p = props(async () => system)
  render(<BusinessHeader {...p}/>)
  fireEvent.click(await screen.findByRole('button', { name: '填写表单' }))
  fireEvent.click(screen.getByRole('button', { name: '表单列表' }))
  expect(p.open).toHaveBeenNthCalledWith(1, 'customer', 'form')
  expect(p.open).toHaveBeenNthCalledWith(2, 'customer', 'records')
  expect(p.choose).not.toHaveBeenCalled()
})
it('discards a delayed binding from the previous session', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [system] })))))
  let finish: (value: typeof system) => void = () => {}
  const p = props(() => new Promise((resolve) => { finish = resolve }))
  const view = render(<BusinessHeader {...p}/>)
  view.rerender(<BusinessHeader {...p} sessionId={'s2' as Parameters<typeof BusinessHeader>[0]['sessionId']} resolveBusiness={async () => undefined}/>)
  await screen.findByRole('button', { name: '业务' })
  finish(system)
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: '填写表单' })).toBeNull())
})

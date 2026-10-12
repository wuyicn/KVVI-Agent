// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BuilderPreviewEntry } from '../src/client/BuilderPreviewEntry.tsx'
import { zh } from '../src/client/locales.ts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const intent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function props() {
  return { sessionId: 's1', t: (k: keyof typeof zh) => zh[k], openPreview: vi.fn(),
    useSession: (f: (s: object) => unknown) => f({ running: false }),
    useSessions: (f: (s: object) => unknown) => f({ byId: { s1: { cwd: `/managed/business-workspaces/${'a'.repeat(64)}/${intent}` } } }),
  } as unknown as Parameters<typeof BuilderPreviewEntry>[0]
}
it('opens the current unpublished draft without asking the model or publishing first', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/auth/session'
    ? { gateway: 'BUILDER' } : { intentId: intent, canSubmit: false, validation: 'not_checked' })))
  const p = props(); render(<BuilderPreviewEntry {...p}/>)
  await vi.waitFor(() =>{  expect(p.openPreview).toHaveBeenCalledExactlyOnceWith(intent) })
  fireEvent.click(screen.getByRole('button', { name: '草稿预览' }))
  expect(p.openPreview).toHaveBeenCalledTimes(2)
})
it('never opens or fetches a builder draft for an employee', async () => {
  const fetcher = vi.fn(async () => Response.json({ gateway: 'USER' }))
  vi.stubGlobal('fetch', fetcher)
  const p = props(); render(<BuilderPreviewEntry {...p}/>)
  await vi.waitFor(() =>{  expect(fetcher).toHaveBeenCalledTimes(1) })
  expect(p.openPreview).not.toHaveBeenCalled()
  expect(screen.queryByRole('button')).toBeNull()
})

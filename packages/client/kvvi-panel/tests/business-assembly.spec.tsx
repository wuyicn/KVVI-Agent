// @vitest-environment jsdom
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ClientRoster, createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
const roster=ClientRoster.of([...webApp.rows,{ name:'@deepseek-ai/dsh-client-kvvi-panel',inject:['@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-ui-slots'],immediately:false }])
const it=createClientTest({ roster },{ mount:true })
// Lexical measures the caret after an insertion; jsdom supplies no Range geometry.
Range.prototype.getBoundingClientRect = () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
})
afterEach(()=>vi.unstubAllGlobals())
it('boots the actual business slots alongside the original conversation without declaration collisions',async({ start,mock })=>{
  vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(JSON.stringify({ groups:[], forms:[], items:[], gateway:'USER', companyId:'c1', userId:'u1', sessionId:'login1', role:null,login:'test-user',companyName:'测试公司' })))))
  mock.load({ unary:{ 'settings/mutate':{ ok:true,value:null },'llm/listProviders':{ ok:true,value:[] },'llm/listConfigurableProviders':{ ok:true,value:[] } } })
  const client=await start()
  expect(client.ctx.slots.entries('main').some(e=>e.options.key==='kvvi-business')).toBe(true)
  fireEvent.click(await screen.findByRole('button',{ name:'Business' }))
  await screen.findByRole('textbox',{ name:'Search forms' })
  expect(client.ctx.slots.entries('kvvi.business.session')).toHaveLength(1)
},60000)

it('mounts records and the original embedded AI under the matching business session', async ({ start, mock }) => {
  const system = { assetId: 'customer', systemId: 'published', name: '客户登记', schemaCode: 'customer', publishedAt: '2026-10-08' }
  const runtime = { system, models: { customer: { fields: [] } }, views: { customer: { view_type: 'FORM', componentsTree: [] } }, workflows: {} }
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith('/runtime') ? runtime : url.endsWith('/records') ? { items: [], fieldVisibility: {} } : { items: [system], groups: [], forms: [{ ...system, groupId: null, archived: false, version: 0, actions: ['read', 'create'] }], gateway: 'USER', companyId: 'c1', userId: 'u1', sessionId: 'login1' },
  )))))
  mock.load({ unary: {
    'settings/mutate': { ok: true, value: null },
    'llm/listProviders': { ok: true, value: [] },
    'llm/listConfigurableProviders': { ok: true, value: [] },
    'subagents/list': { ok: true, value: { entries: [], parentAvailable: true } },
    'commands/list': { ok: true, value: [] },
    'skills/list': { ok: true, value: { skills: [] } },
    'workspaceFiles/read': { ok: true, value: { text: '{"assetId":"customer"}', eof: true, lines: 1, offset: 1, absolutePath: '/客户登记系统/.kvvi-system.json', version: '1' } },
    'session/list': { ok: true, value: { items: [{ sessionId: 's1', cwd: '/客户登记系统', updatedAt: 1, running: false, blank: true }] } },
  } })
  mock.stream('workspace/follow', (_args, stream) => {
    stream.push({ type: 'baseline', value: { items: [{ workspaceId: 'w1', title: '客户登记系统', path: '/客户登记系统', sessionIds: ['s1'], createdAt: '', updatedAt: '' }], archivedSessionIds: [] } })
  })
  mock.stream('session/follow', (_args, stream) => {
    stream.push({ type: 'snapshot', header: { version: 3, id: 's1', createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })
  })
  const client = await start()
  fireEvent.click(await screen.findByRole('button', { name: 'Business' }))
  const ai = await screen.findByRole('button', { name: 'AI assistant' })
  await vi.waitFor(() => expect(ai).toHaveProperty('disabled', false))
  expect(client.ctx.sessions.list.getSnapshot().byId['s1' as SessionId]?.retainedBy.kvviBusiness).toBe(1)
  fireEvent.click(ai)
  await screen.findByRole('complementary', { name: 'AI assistant' })
  expect(document.querySelector('[data-slot="kvvi.business.session"] [contenteditable]')).not.toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: 'Close AI assistant' })[0]!)
}, 60_000)

it('releases an opening business session when closing Business before the first stream frame', async ({ start, mock }) => {
  const system = { assetId: 'customer', systemId: 'published', name: 'customer', schemaCode: 'customer', publishedAt: '' }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: [system], groups: [], forms: [{ ...system, groupId: null, archived: false, version: 0, actions: ['read', 'create'] }], gateway: 'USER', companyId: 'c1', userId: 'u1', sessionId: 'login1' })))))
  mock.load({ unary: {
    'settings/mutate': { ok: true, value: null }, 'llm/listProviders': { ok: true, value: [] },
    'llm/listConfigurableProviders': { ok: true, value: [] },
    'subagents/list': { ok: true, value: { entries: [], parentAvailable: true } },
    'commands/list': { ok: true, value: [] }, 'skills/list': { ok: true, value: { skills: [] } },
    'workspaceFiles/read': { ok: true, value: { text: '{"assetId":"customer"}', eof: true, lines: 1, offset: 1, absolutePath: '/客户登记系统/.kvvi-system.json', version: '1' } },
    'session/list': { ok: true, value: { items: [{ sessionId: 's1', cwd: '/客户登记系统', updatedAt: 1, running: false, blank: true }] } },
  } })
  mock.stream('workspace/follow', (_args, stream) => {
    stream.push({ type: 'baseline', value: { items: [{ workspaceId: 'w1', title: '客户登记系统', path: '/客户登记系统', sessionIds: ['s1'], createdAt: '', updatedAt: '' }], archivedSessionIds: [] } })
  })
  mock.stream('session/follow', () => {})
  const client = await start()
  fireEvent.click(await screen.findByRole('button', { name: 'Business' }))
  await vi.waitFor(() => expect(client.ctx.sessions.list.getSnapshot().byId['s1' as SessionId]?.retainedBy.kvviBusiness).toBe(1))
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await vi.waitFor(() => expect(client.ctx.sessions.list.getSnapshot().byId['s1' as SessionId]?.retainedBy.kvviBusiness ?? 0).toBe(0))
}, 60_000)

it('uses the workspace business marker for a differently named published system and restores its shortcuts', async ({ start, mock }) => {
  const system = { assetId: 'customer', systemId: 'published', name: 'customer', schemaCode: 'customer', publishedAt: '2026-10-08' }
  const runtime = { system, models: { customer: { fields: [] } }, views: { customer: { name: '客户登记表', view_type: 'FORM', componentsTree: [] } }, workflows: {} }
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith('/runtime') ? runtime : url.endsWith('/records') ? { items: [{ recordId: 'r1', recordNo: '001', data: {} }], fieldVisibility: {} } : { items: [system], groups: [], forms: [{ ...system, groupId: null, archived: false, version: 0, actions: ['read', 'create'] }], gateway: 'USER', companyId: 'c1', userId: 'u1', sessionId: 'login1' },
  )))))
  mock.load({ unary: {
    'settings/mutate': { ok: true, value: null }, 'llm/listProviders': { ok: true, value: [] },
    'llm/listConfigurableProviders': { ok: true, value: [] },
    'subagents/list': { ok: true, value: { entries: [], parentAvailable: true } },
    'commands/list': { ok: true, value: [] }, 'skills/list': { ok: true, value: { skills: [] } },
    'workspaceFiles/read': { ok: true, value: { text: '{"assetId":"customer"}', eof: true, lines: 1, offset: 1, absolutePath: '/客户登记系统/.kvvi-system.json', version: '1' } },
    'session/list': { ok: true, value: { items: [{ sessionId: 's1', cwd: '/客户登记系统', updatedAt: 1, running: false, blank: true }] } },
  } })
  mock.stream('workspace/follow', (_args, stream) => {
    stream.push({ type: 'baseline', value: { items: [{ workspaceId: 'w1', title: '客户登记系统', path: '/客户登记系统', sessionIds: ['s1'], createdAt: '', updatedAt: '' }], archivedSessionIds: [] } })
  })
  mock.stream('session/follow', (_args, stream) => {
    stream.push({ type: 'snapshot', header: { version: 3, id: 's1', cwd: '/客户登记系统', createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })
  })
  const client = await start()
  fireEvent.click(await screen.findByRole('button', { name: 'Business' }))
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'AI assistant' })).toHaveProperty('disabled', false))
  expect(screen.queryByRole('combobox', { name: 'AI conversation workspace' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'AI assistant' }))
  await screen.findByRole('region', { name: 'Current form' })
  const editor = await screen.findByRole('textbox', { name: 'Ask about this form…' })
  expect(editor).toBeTruthy()
  const scope = client.ctx.sessions.scope('s1' as SessionId)!
  const input = client.ctx.conversation.input.for(scope)
  act(() => { scope.bail('slash/input-insert-reference', {
    reference: { source: 'reference', ref: 'file-id', label: '文件', appearance: 'file', clipboardText: '@文件' },
    span: { start: 0, end: 0, draftRev: input.state.getSnapshot().draftRev },
  }) })
  await vi.waitFor(() => expect(input.state.getSnapshot().occurrences).toHaveLength(1))
  act(() => { client.ctx.conversation.blocks.set('s1' as SessionId, { reason: 'Blocked' }) })
  expect(screen.getByRole('button', { name: 'Ask about current form' })).toHaveProperty('disabled', true)
  act(() => { client.ctx.conversation.blocks.set('s1' as SessionId, undefined) })
  fireEvent.click(screen.getByRole('button', { name: 'Ask about current form' }))
  await vi.waitFor(() => expect(editor.textContent).toContain('customer'))
  expect(editor.textContent).toContain('客户登记表')
  expect(input.state.getSnapshot().occurrences).toEqual([expect.objectContaining({ source: 'reference', ref: 'file-id' })])
  const previousDraft = editor.textContent
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select record: 001' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Ask about selected records' }))
  await vi.waitFor(() => expect(editor.textContent).toContain('["r1"]'))
  expect(editor.textContent).toContain(previousDraft)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await screen.findByRole('button', { name: 'Ask about current form' })
  expect(await screen.findByRole('checkbox', { name: 'Select record: 001' })).toHaveProperty('checked', false)
  expect(client.ctx.sessions.list.getSnapshot().byId['s1' as SessionId]?.retainedBy.kvviBusiness).toBe(1)
  fireEvent.click(screen.getAllByRole('button', { name: 'Close AI assistant' })[0]!)
}, 60_000)

it('uses the same record layout and explicitly binds differently named business and workspace', async ({ start, mock }) => {
  const system = { assetId: 'customer', systemId: 'published', name: 'customer', schemaCode: 'customer', publishedAt: '2026-10-08' }
  const runtime = { system, models: { customer: { fields: [] } }, views: { customer: { view_type: 'FORM', componentsTree: [] } }, workflows: {} }
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith('/runtime') ? runtime : url.endsWith('/records') ? { items: [], fieldVisibility: {} } : { items: [system], groups: [], forms: [{ ...system, groupId: null, archived: false, version: 0, actions: ['read', 'create'] }], gateway: 'USER', companyId: 'c1', userId: 'u1', sessionId: 'login1' },
  )))))
  mock.load({ unary: {
    'settings/mutate': { ok: true, value: null },
    'llm/listProviders': { ok: true, value: [] },
    'llm/listConfigurableProviders': { ok: true, value: [] },
    'subagents/list': { ok: true, value: { entries: [], parentAvailable: true } },
    'commands/list': { ok: true, value: [] },
    'skills/list': { ok: true, value: { skills: [] } },
    'workspaceFiles/read': { ok: false, error: { code: 'workspace-file/not-found', message: 'Missing' } },
    'session/create': { ok: true, value: { sessionId: 's2' } },
    'session/list': { ok: true, value: { items: [{ sessionId: 's1', cwd: '/客户登记系统', updatedAt: 1, running: false, blank: true }] } },
  } })
  mock.stream('workspace/follow', (_args, stream) => {
    stream.push({ type: 'baseline', value: { items: [{ workspaceId: 'w1', title: '客户登记系统', path: '/客户登记系统', sessionIds: ['s1'], createdAt: '', updatedAt: '' }], archivedSessionIds: [] } })
  })
  mock.stream('session/follow', (_args, stream) => {
    stream.push({ type: 'snapshot', header: { version: 3, id: 's2', createdAt: 0, isSeeded: false }, cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } })
  })
  const client = await start()
  fireEvent.click(await screen.findByRole('button', { name: 'Business' }))
  await screen.findByRole('button', { name: 'Refresh' })
  expect(screen.getByRole('button', { name: 'AI assistant' })).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByRole('combobox', { name: 'AI conversation workspace' }), { target: { value: 'w1' } })
  const ai = await screen.findByRole('button', { name: 'AI assistant' })
  await vi.waitFor(() => expect(ai).toHaveProperty('disabled', false))
  expect(client.ctx.sessions.list.getSnapshot().byId['s1' as SessionId]?.retainedBy.kvviBusiness ?? 0).toBe(0)
  expect(client.ctx.sessions.list.getSnapshot().byId['s2' as SessionId]?.retainedBy.kvviBusiness).toBe(1)
  fireEvent.click(ai)
  await screen.findByRole('complementary', { name: 'AI assistant' })
  expect(document.querySelector('[data-slot="kvvi.business.session"] [contenteditable]')).not.toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: 'Close AI assistant' })[0]!)
}, 60_000)

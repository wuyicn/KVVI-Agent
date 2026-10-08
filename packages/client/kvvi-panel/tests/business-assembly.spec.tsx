// @vitest-environment jsdom
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ClientRoster, createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
const roster=ClientRoster.of([...webApp.rows,{ name:'@deepseek-ai/dsh-client-kvvi-panel',inject:['@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-ui-slots'],immediately:false }])
const it=createClientTest({ roster },{ mount:true })
afterEach(()=>vi.unstubAllGlobals())
it('boots the actual business slots alongside the original conversation without declaration collisions',async({ start,mock })=>{
  vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(JSON.stringify({ items:[],role:null,login:'test-user',companyName:'测试公司' })))))
  mock.load({ unary:{ 'settings/mutate':{ ok:true,value:null },'llm/listProviders':{ ok:true,value:[] },'llm/listConfigurableProviders':{ ok:true,value:[] } } })
  const client=await start()
  expect(client.ctx.slots.entries('main').some(e=>e.options.key==='kvvi-business')).toBe(true)
  fireEvent.click(await screen.findByRole('button',{ name:'Business' }))
  await screen.findByRole('textbox',{ name:'Search businesses' })
  expect(client.ctx.slots.entries('kvvi.business.session')).toHaveLength(1)
},60000)

it('mounts records and the original embedded AI under the matching business session', async ({ start, mock }) => {
  const system = { assetId: 'customer', systemId: 'published', name: '客户登记', schemaCode: 'customer', publishedAt: '2026-10-08' }
  const runtime = { system, models: { customer: { fields: [] } }, views: { customer: { view_type: 'FORM', componentsTree: [] } }, workflows: {} }
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith('/runtime') ? runtime : url.endsWith('/records') ? { items: [], fieldVisibility: {} } : { items: [system] },
  )))))
  mock.load({ unary: {
    'settings/mutate': { ok: true, value: null },
    'llm/listProviders': { ok: true, value: [] },
    'llm/listConfigurableProviders': { ok: true, value: [] },
    'subagents/list': { ok: true, value: { entries: [], parentAvailable: true } },
    'commands/list': { ok: true, value: [] },
    'skills/list': { ok: true, value: { skills: [] } },
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
  fireEvent.click(await screen.findByRole('button', { name: 'Open business' }))
  const ai = await screen.findByRole('button', { name: 'AI assistant' })
  await vi.waitFor(() => expect(ai).toHaveProperty('disabled', false))
  expect(client.ctx.sessions.list.getSnapshot().byId['s1' as SessionId]?.retainedBy.kvviBusiness).toBe(1)
  fireEvent.click(ai)
  await screen.findByRole('complementary', { name: 'AI assistant' })
  expect(document.querySelector('[data-slot="kvvi.business.session"] [contenteditable]')).not.toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: 'Close AI assistant' })[0]!)
}, 60_000)

// @vitest-environment jsdom
import type { ReactNode } from 'react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BusinessPage, type BusinessPageProps } from '../src/client/BusinessPage.tsx'
import { zh } from '../src/client/locales.ts'
import { createBusinessStore } from '../src/client/business-store.ts'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const system = { assetId:'customer', systemId:'s1', name:'客户登记',schemaCode:'customer',publishedAt:'2026-10-08' }
const directory = { groups: [], forms: [{ ...system, groupId: null, archived: false, version: 0, actions: ['read', 'create'] }] }
function props() {
  const store = createBusinessStore().create()
  const renderSlot=vi.fn((seat:string, input:{ assistant?: boolean })=> <p>{input.assistant ? 'embedded-conversation' : seat}</p>), bindBusiness=vi.fn(async()=> ({ sessionId:'s1', release:vi.fn() }))
  return { useStore: (select: (s: ReturnType<typeof store.getSnapshot>) => unknown) => select(store.getSnapshot()), actions: store.actions, renderSlot,bindBusiness,t:(key:string)=>(zh as Record<string,string>)[key] ?? key,back:vi.fn(),SessionProvider:({ children }:{ children:ReactNode })=>children,useSessions:(select:(state:unknown)=>unknown)=>select({ byId:{ s1:{ id:'s1',cwd:'/客户登记系统',retainedBy:{ mainView:1 } } } }),useWorkspaces:(select:(state:unknown)=>unknown)=>select({ items:[{ workspaceId:'w1',title:'客户登记系统',path:'/客户登记系统',sessionIds:['s1'] }] }) } as unknown as BusinessPageProps
}
it('keeps business records in the main area and opens the original AI only on request',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(JSON.stringify({ ...directory, gateway: 'USER', companyId: 'c1', userId: 'u1', sessionId: 'login1' })))))
  const p=props();render(<BusinessPage {...p}/>)
  await screen.findByText('kvvi.business.session')
  expect(screen.queryByText('embedded-conversation')).toBeNull()
  fireEvent.click(screen.getByRole('button',{ name:'AI协助' }));await screen.findByText('embedded-conversation')
  expect(p.back).not.toHaveBeenCalled()
  fireEvent.click(screen.getAllByRole('button',{ name:'收起AI协助' })[0]!);expect(screen.queryByText('embedded-conversation')).toBeNull()
})
it('opens the form directory directly and hides builder actions from employees', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...directory, companyId: 'c1', userId: 'u1', sessionId: 'login1', gateway: 'USER' })))))
  render(<BusinessPage {...props()}/> )
  await screen.findByRole('button', { name: '客户登记' })
  expect(screen.queryByRole('columnheader', { name: '业务名称' })).toBeNull()
  expect(screen.queryByRole('button', { name: '新增表单' })).toBeNull()
})
it('offers New business to an authorized builder in USER mode and enters builder login before any creation', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...directory, companyId: 'c1', userId: 'u1', sessionId: 'login1', gateway: 'USER', allowedGateways: ['USER', 'BUILDER'] })))))
  const enterBuilder = vi.fn(), startBuilder = vi.fn()
  render(<BusinessPage {...props()} {...{ enterBuilder, startBuilder }}/>)
  fireEvent.click(await screen.findByRole('button', { name: '新增表单' }))
  expect(enterBuilder).toHaveBeenCalledOnce()
  expect(startBuilder).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('collects builder requirements inside Business before starting the real builder flow', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ...directory, companyId: 'c1', userId: 'u1', sessionId: 'login1', gateway: 'BUILDER' })))))
  const startBuilder = vi.fn(async () => {})
  render(<BusinessPage {...props()} {...{ startBuilder, pickDirectory: async () => '/workspaces' }}/>)
  fireEvent.click(await screen.findByRole('button', { name: '新增表单' }))
  expect(screen.getByRole('button', { name: '开始搭建' })).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('业务名称'), { target: { value: '访客登记' } })
  fireEvent.change(screen.getByLabelText('业务需求'), { target: { value: '登记访客姓名和到访时间' } })
  fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '开始搭建' })).toHaveProperty('disabled', false))
  fireEvent.click(screen.getByRole('button', { name: '开始搭建' }))
  expect(startBuilder).toHaveBeenCalledExactlyOnceWith('/workspaces', '访客登记', '登记访客姓名和到访时间')
})
it('invalidates every view of the same business after a write, without changing other businesses',()=>{
  const store=createBusinessStore().create();store.actions.invalidate('customer')
  expect(store.getSnapshot().revisions.customer).toBe(1);expect(store.getSnapshot().revisions.other).toBeUndefined()
})

it('only treats structured successful record writes as business changes', async()=>{
  const { writtenBusiness }=await import('../src/client/BusinessActivity.tsx')
  const node={ isError:false,call:{ name:'record_create',argsRaw:'{"system":"customer"}' },content:[{ type:'text',text:'{"recordId":"r1"}' }] } as unknown as ToolResultNode
  expect(writtenBusiness(node)).toBe('customer')
  expect(writtenBusiness({ ...node,isError:true })).toBeUndefined()
  expect(writtenBusiness({ ...node,call:{ argsRaw:'{"system":"customer"}',name:'record_get' } })).toBeUndefined()
  expect(writtenBusiness({ ...node,content:[{ type:'text',text:'保存成功' }] })).toBeUndefined()
})

it('ignores replayed writes and refreshes new results without opening a workspace pane in business mode', async () => {
  const { BusinessActivity } = await import('../src/client/BusinessActivity.tsx')
  const store = createBusinessStore().create()
  const afterWrite = vi.fn()
  let workspace = true
  let openState = 'loading'
  const result = (seq: number) => ({ kind: 'tool-result', seq, isError: false, call: { name: 'record_create', argsRaw: '{"system":"customer"}' }, content: [{ type: 'text', text: '{"recordId":"r1"}' }] })
  let nodes = [result(10)]
  const p = {
    actions: store.actions, afterWrite,
    useConversation: (select: (snapshot: object) => unknown) => select({ views: { get: () => ({ legacy: { nodes } }) } }),
    useSession: (select: (snapshot: object) => unknown) => select({ openState }),
    usePanelInfo: (select: (snapshot: object) => unknown) => select({ activePanelId: workspace ? null : 'kvvi-business' }),
  } as unknown as Parameters<typeof BusinessActivity>[0]
  const view = render(<BusinessActivity {...p}/>)
  openState = 'open'; view.rerender(<BusinessActivity {...p}/>)
  expect(afterWrite).not.toHaveBeenCalled()
  nodes = [...nodes, result(11)]; view.rerender(<BusinessActivity {...p}/>)
  expect(afterWrite).toHaveBeenCalledExactlyOnceWith('customer')
  workspace = false; nodes = [...nodes, result(12)]; view.rerender(<BusinessActivity {...p}/>)
  expect(afterWrite).toHaveBeenCalledOnce()
  expect(store.getSnapshot().revisions.customer).toBe(2)
  nodes = [...nodes, { ...result(13), isError: true }]; view.rerender(<BusinessActivity {...p}/>)
  expect(store.getSnapshot().revisions.customer).toBe(2)
})

it('keeps the new record-first layout usable when no workspace name matches', async () => {
  const runtime = { system, models: { customer: { fields: [] } }, views: { customer: { view_type: 'FORM', componentsTree: [] } }, workflows: {} }
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.endsWith('/runtime') ? runtime : url.endsWith('/records') ? { items: [], fieldVisibility: {} } : { ...directory, companyId: 'c1', userId: 'u1', sessionId: 'login1', gateway: 'USER' },
  )))))
  const p = props()
  p.bindBusiness = vi.fn(async () => undefined)
  const store = createBusinessStore().create()
  const useStore: BusinessPageProps['useStore'] = select => select(store.getSnapshot())
  render(<BusinessPage {...p} {...{ useStore, actions: store.actions }}/>)
  await screen.findByRole('button', { name: '刷新' })
  expect(screen.getByRole('button', { name: 'AI协助' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('combobox', { name: 'AI会话工作区' })).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'AI会话工作区' }), { target: { value: 'w1' } })
  expect(p.bindBusiness).toHaveBeenLastCalledWith(system, 's1', 'w1', expect.any(AbortSignal))
})

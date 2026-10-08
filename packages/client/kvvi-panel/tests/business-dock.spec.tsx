// @vitest-environment jsdom
import type {} from '../src/client/index.ts'
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BusinessBody, type BusinessBodyProps } from '../src/client/BusinessBody.tsx'
import { createBusinessStore } from '../src/client/business-store.ts'
import { businessAddress, parseBusinessAddress } from '../src/client/business-tabs.ts'
import { AccountArea, type AccountAreaProps } from '../src/client/AccountArea.tsx'
import { zh } from '../src/client/locales.ts'
const t = ((key: string, params?: Record<string, unknown>) => ((zh as Record<string,string>)[key] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name] ?? ''))) as BusinessBodyProps['t']
const runtime = { system: { name: '客户登记', assetId: 'customer' }, models: { customer: { fields: [{ field_code:'name', label:'名称' }] } }, views: { customer: { view_type:'FORM', componentsTree:[{ id:'root',componentName:'FormPage',children:[{ id:'f',componentName:'ShortTextField',props:{ fieldBinding:{ fieldRef:'name' } } }] }] } }, workflows:{} }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function body(address: string) {
  const store = createBusinessStore().create()
  const openResource = vi.fn()
  const signal = new AbortController().signal
  const useStore: BusinessBodyProps['useStore'] = selector => selector(useSyncExternalStore(store.subscribe,store.getSnapshot))
  const props = { t, useStore, actions:store.actions, useTabInfo:() => ({ tab:{ id:'t1',signal,navigation:{ address },actions:{ openResource } } }) } as unknown as BusinessBodyProps
  return { props, store, openResource }
}
it('validates restored URI shapes and preserves escaped business/record identity', () => {
  expect(parseBusinessAddress(businessAddress('客户/业务','detail','记录/1'))).toEqual({ assetId:'客户/业务',mode:'detail',recordId:'记录/1' })
  for(const address of ['dsh-resource://kvvi-business/%ZZ/form','dsh-resource://kvvi-business/customer/detail','dsh-resource://kvvi-business/customer/form/x','https://example.com/customer/form']) expect(parseBusinessAddress(address)).toBeNull()
})
it('preserves one draft through dialog and tab remount, while isolating sessions', async () => {
  vi.stubGlobal('fetch', vi.fn((url:string) => Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ fields:runtime.models.customer.fields }:runtime)))))
  const b=body(businessAddress('customer','form'));const mounted=render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('name'), { target:{ value:'联测草稿' } })
  fireEvent.click(screen.getByRole('button',{ name:'弹窗填写' }))
  expect(await screen.findByLabelText('name')).toHaveProperty('value','联测草稿')
  fireEvent.keyDown(document,{ key:'Escape' })
  expect(await screen.findByLabelText('name')).toHaveProperty('value','联测草稿')
  mounted.unmount();render(<BusinessBody {...b.props} />)
  expect(await screen.findByLabelText('name')).toHaveProperty('value','联测草稿')
  expect(createBusinessStore().create().getSnapshot().drafts).toEqual({})
})
it('rejects duplicate submissions and opens only the record actually returned by the API', async () => {
  let finish: (r:Response)=>void=()=>{};const requests:string[]=[]
  vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{requests.push(`${init?.method} ${url}`);return init?.method==='POST'?new Promise<Response>((resolve)=>{finish=resolve}):Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ fields:runtime.models.customer.fields }:runtime)))}))
  const b=body(businessAddress('customer','form')); render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('name'),{ target:{ value:'客户' } })
  fireEvent.submit(screen.getByLabelText('name').closest('form')!);fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  expect(requests.filter(v=>v.startsWith('POST'))).toEqual(['POST /api/v1/systems/customer/records'])
  finish(new Response(JSON.stringify({ recordId:'actual-id',rowVersion:1 })))
  await waitFor(()=>expect(b.openResource).toHaveBeenCalledWith(businessAddress('customer','detail','actual-id'),{ replaceTab:true }))
  expect(b.store.getSnapshot().drafts).toEqual({})
})
it('keeps refused submission draft and never opens success details',async()=>{
  vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>Promise.resolve(new Response(JSON.stringify(init?.method==='POST'?{ error:'KVVI_NOT_ALLOWED' }:url.endsWith('/fields')?{ fields:runtime.models.customer.fields }:runtime),{ status:init?.method==='POST'?403:200 }))))
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('name'),{ target:{ value:'留存' } });fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await screen.findByText('你暂无提交权限，请联系管理员。');expect(b.openResource).not.toHaveBeenCalled();expect(b.store.getSnapshot().drafts.customer?.name).toBe('留存')
})
it('shows the authenticated identity, opens existing settings, and carries no fake notifications',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>Promise.resolve(new Response(JSON.stringify({ login:'staff-view',companyName:'可微科技' })))))
  const openSettings=vi.fn();render(<AccountArea {...({ wide:true,openSettings,t } as unknown as AccountAreaProps)} />)
  await screen.findByText('staff-view');fireEvent.click(screen.getByRole('button',{ name:'个人信息' }));fireEvent.click(screen.getByRole('button',{ name:'设置' }));expect(openSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button',{ name:'公司通知' }));await screen.findByText('公司通知尚未接入。')
})

it('withholds the form when the platform refuses the authorized field read',async()=>{
  vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ error:'KVVI_NOT_ALLOWED' }:runtime),{ status:url.endsWith('/fields')?403:200 }))))
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props} />)
  await screen.findByText('KVVI_NOT_ALLOWED');expect(screen.queryByLabelText('name')).toBeNull()
})

it('renders choices from the published model when authorized declarations carry top-level options', async()=>{
  const field={ field_code:'status',label:'跟进状态',type:'single_select',type_config:{ options:[{ code:'following',label:'跟进中' },{ code:'retired',label:'停用',enabled:false }] } }
  const projection={ ...runtime,models:{ customer:{ fields:[field] } },views:{ customer:{ view_type:'FORM',componentsTree:[{ id:'f',componentName:'SingleSelectField',props:{ fieldBinding:{ fieldRef:'status' } } }] } } }
  vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ fields:[{ field_code:'status',label:'跟进状态',type:'single_select',options:field.type_config.options.filter(option=>option.enabled!==false) }] }:projection)))))
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props} />)
  expect(await screen.findByRole('option',{ name:'跟进中' })).toHaveProperty('value','following')
  expect(screen.queryByRole('option',{ name:'停用' })).toBeNull()
})

it('retains an in-flight submit across remount and settles the original tab',async()=>{
  let finish:(r:Response)=>void=()=>{};let posts=0
  vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>init?.method==='POST'?(posts++,new Promise<Response>((resolve)=>{finish=resolve})):Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ fields:runtime.models.customer.fields }:runtime)))))
  const b=body(businessAddress('customer','form'));const first=render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('name'),{ target:{ value:'只提交一次' } });fireEvent.submit(screen.getByLabelText('name').closest('form')!);first.unmount()
  render(<BusinessBody {...b.props} />);fireEvent.submit((await screen.findByLabelText('name')).closest('form')!)
  expect(posts).toBe(1)
  finish(new Response(JSON.stringify({ recordId:'saved-once',rowVersion:1 })))
  await waitFor(()=>expect(b.openResource).toHaveBeenCalledWith(businessAddress('customer','detail','saved-once'),{ replaceTab:true }))
})

it('reloads a remounted detail when its pending update settles',async()=>{
  let finish:(r:Response)=>void=()=>{};let version=1;let reads=0
  vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{
    if(init?.method==='PATCH')return new Promise<Response>((resolve)=>{finish=resolve})
    if(url.endsWith('/records/r1')){reads++;return Promise.resolve(new Response(JSON.stringify({ recordId:'r1',rowVersion:version,data:{ name:'旧值' },fieldVisibility:{ name:'VISIBLE' } })))}
    return Promise.resolve(new Response(JSON.stringify(runtime)))
  }))
  const b=body(businessAddress('customer','detail','r1'));const first=render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('name'),{ target:{ value:'更新' } });fireEvent.click(screen.getByRole('button',{ name:zh['detail.save'] }));first.unmount()
  render(<BusinessBody {...b.props} />);await screen.findByLabelText('name');expect(reads).toBe(2)
  version=2;finish(new Response(JSON.stringify({ recordId:'r1',rowVersion:2 })))
  await waitFor(()=>expect(reads).toBe(3))
})

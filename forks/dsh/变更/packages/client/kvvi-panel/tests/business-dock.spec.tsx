// @vitest-environment jsdom
import type {} from '../src/client/index.ts'
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BusinessSession, type BusinessSessionProps } from '../src/client/BusinessPage.tsx'
import { BusinessBody, BusinessContent, type BusinessBodyProps } from '../src/client/BusinessBody.tsx'
import { createBusinessStore } from '../src/client/business-store.ts'
import { businessAddress, parseBusinessAddress } from '../src/client/business-tabs.ts'
import { AccountArea, type AccountAreaProps } from '../src/client/AccountArea.tsx'
import { zh } from '../src/client/locales.ts'
const t = ((key: string, params?: Record<string, unknown>) => ((zh as Record<string,string>)[key] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => String(params?.[name] ?? ''))) as BusinessBodyProps['t']
const entrance={companyId:'company',userId:'user',sessionId:'session',gateway:'USER'}
const entranceIdentity=JSON.stringify(Object.values(entrance))
/** Protocol-aware server around each test's business responses, with receipts
 * retained across fresh stores. The business handler receives business writes
 * only; protocol routes are explicit rather than positional response mocks. */
function businessFetch(handler:(url:string,init?:RequestInit)=>Promise<Response>) {
  type Receipt={state:'COMMITTED';idempotencyKey:string;operationId:string;statusCode:number;result:unknown;auditPending:boolean}
  const active=new Map<string,{state:'PREPARED';idempotencyKey:string;body:unknown}|Receipt>()
  const receipts=new Map<string,Receipt>()
  let sequence=0,lose=false,currentEntrance={...entrance}
  const businessPath=(base:string)=>base.includes('/records/')?base.replace(/\/write-intent$/u,''):base.replace(/\/write-intent$/u,'/records')
  const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
    const namespace=JSON.stringify([currentEntrance.companyId,currentEntrance.userId,currentEntrance.gateway])
    const scoped=(path:string)=>namespace+':'+path
    const key=new Headers(init?.headers).get('idempotency-key')
    if(url==='/auth/session')return Response.json(currentEntrance)
    if(url.endsWith('/write-receipt')) {
      const endpoint=businessPath(url.replace(/\/write-receipt$/u,'/write-intent')),receipt=receipts.get(scoped(endpoint)+':'+key)
      return receipt?Response.json(receipt):Response.json({state:'UNKNOWN',idempotencyKey:key,retryWithSameKey:true},{status:202})
    }
    const control=url.match(/^(.*\/write-intent)\/(cancel|acknowledge)$/u)
    if(control){
      const endpoint=businessPath(control[1]!),receipt=receipts.get(scoped(endpoint)+':'+key)
      if(control[2]==='cancel'&&receipt)return Response.json(receipt)
      if(control[2]==='acknowledge'&&!receipt)return Response.json({error:'KVVI_OPERATION_NOT_COMMITTED'},{status:409})
      active.delete(scoped(endpoint));return Response.json({state:control[2]==='cancel'?'CANCELED':'ACKNOWLEDGED',idempotencyKey:key})
    }
    if(url.endsWith('/write-intent')){
      const endpoint=businessPath(url),previous=active.get(scoped(endpoint))
      const visible=previous?.state==='PREPARED'?{state:previous.state,idempotencyKey:previous.idempotencyKey}:previous
      if(init?.method==='GET')return Response.json(visible??{state:'EMPTY'})
      if(previous)return Response.json(visible)
      const prepared={state:'PREPARED' as const,idempotencyKey:'prepared-'+(++sequence),body:JSON.parse(String(init?.body))}
      active.set(scoped(endpoint),prepared)
      return Response.json({state:prepared.state,idempotencyKey:prepared.idempotencyKey})
    }
    const result=await handler(url,init)
    if(['POST','PATCH'].includes(init?.method??'')&&/\/records(?:\/[^/]+)?$/u.test(url)&&result.ok){
      const body=await result.clone().json(),original=key??'legacy-fixture'
      const receipt:Receipt={state:'COMMITTED',idempotencyKey:original,operationId:'operation-'+original,
        statusCode:init?.method==='POST'?201:200,result:body,auditPending:false}
      receipts.set(scoped(url)+':'+original,receipt);active.set(scoped(url),receipt)
      if(lose){lose=false;throw new Error('injected-lost-business-reply')}
    }
    return result
  })
  return Object.assign(fetcher,{loseNextBusinessReply:()=>{lose=true},committedCount:()=>receipts.size,
    setEntrance:(next:typeof entrance)=>{currentEntrance={...next}}})
}
const runtime = { system: { name: '客户登记', assetId: 'customer' }, models: { customer: { fields: [{ field_code:'name', label:'名称',type:'short_text',visibility:'VISIBLE' }] } }, views: { customer: { view_type:'FORM', componentsTree:[{ id:'root',componentName:'FormPage',children:[{ id:'f',componentName:'ShortTextField',props:{ fieldBinding:{ fieldRef:'name' } } }] }] } }, workflows:{} }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('explains a duplicate refusal without losing entered form values or suggesting retry', async () => {
  vi.stubGlobal('fetch', businessFetch((url: string, init?: RequestInit) => Promise.resolve(Response.json(
    init?.method === 'POST' ? { error: 'KVVI_FIELD_DUPLICATE', problems: [] } : url.endsWith('/fields') ? { fields: runtime.models.customer.fields } : runtime,
    { status: init?.method === 'POST' ? 409 : 200 },
  ))))
  const b = body(businessAddress('customer', 'form')); render(<BusinessBody {...b.props}/>)
  fireEvent.change(await screen.findByLabelText('name'), { target: { value: '已登记客户' } })
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  expect(await screen.findByText('填写的内容与已有记录重复，请检查不允许重复的项目后修改。')).toBeTruthy()
  expect(screen.getByLabelText('name')).toHaveProperty('value', '已登记客户')
  expect(b.openResource).not.toHaveBeenCalled()
})
it('leaves editing on an archived write refusal and retains the unsaved draft', async () => {
  const refresh = vi.fn()
  globalThis.addEventListener('kvvi-business-directory-refresh', refresh)
  vi.stubGlobal('fetch', businessFetch((url: string, init?: RequestInit) => Promise.resolve(Response.json(
    init?.method === 'POST' ? { error: 'KVVI_FORM_ARCHIVED' } : url.endsWith('/fields') ? { fields: runtime.models.customer.fields } : runtime,
    { status: init?.method === 'POST' ? 409 : 200 },
  ))))
  try {
    const b = body(businessAddress('customer', 'form')); render(<BusinessBody {...b.props}/>)
    fireEvent.change(await screen.findByLabelText('name'), { target: { value: 'unsaved' } })
    fireEvent.click(screen.getByRole('button', { name: '弹窗填写' }))
    fireEvent.submit((await screen.findByLabelText('name')).closest('form')!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByLabelText('name')).toBeNull()
    expect(b.store.getSnapshot().drafts.customer?.name).toBe('unsaved')
    expect(screen.getByText(zh['read.archived'])).toBeTruthy()
    expect(refresh).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: zh['read.retry'] }))
    expect(await screen.findByLabelText('name')).toHaveProperty('value', 'unsaved')
  } finally { globalThis.removeEventListener('kvvi-business-directory-refresh', refresh) }
})
function body(address: string) {
  const store = createBusinessStore().create()
  store.actions.identify(entranceIdentity)
  const openResource = vi.fn()
  const signal = new AbortController().signal
  const useStore: BusinessBodyProps['useStore'] = selector => selector(useSyncExternalStore(store.subscribe,store.getSnapshot))
  const props = { t, useStore, actions:store.actions, useTabInfo:() => ({ tab:{ id:'t1',signal,navigation:{ address },actions:{ openResource } } }) } as unknown as BusinessBodyProps
  return { props, store, openResource }
}
it('opens an authorized form from the main record list and refreshes that list after a real create', async () => {
  const fetcher = businessFetch((url: string, init?: RequestInit) => Promise.resolve(new Response(JSON.stringify(
    init?.method === 'POST' ? { recordId: 'actual-new', rowVersion: 1 } : url.endsWith('/fields') ? { fields: runtime.models.customer.fields } : url.endsWith('/records') ? { items: [], fieldVisibility: {} } : runtime,
  ))))
  vi.stubGlobal('fetch', fetcher)
  const b = body(businessAddress('customer', 'records'))
  render(<BusinessContent {...b.props} address={businessAddress('customer', 'records')} signal={new AbortController().signal} openResource={b.openResource} presentation="workbench"/>)
  fireEvent.click(await screen.findByRole('button', { name: '新增记录' }))
  fireEvent.change(await screen.findByLabelText('name'), { target: { value: '新客户' } })
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(b.openResource).not.toHaveBeenCalled()
  expect(fetcher.mock.calls.filter(([url, init]) => url.endsWith('/records') && init?.method === 'POST')).toHaveLength(1)
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/records'))).toHaveLength(3)
})
it('validates restored URI shapes and preserves escaped business/record identity', () => {
  expect(parseBusinessAddress(businessAddress('客户/业务','detail','记录/1'))).toEqual({ assetId:'客户/业务',mode:'detail',recordId:'记录/1' })
  for(const address of ['dsh-resource://kvvi-business/%ZZ/form','dsh-resource://kvvi-business/customer/detail','dsh-resource://kvvi-business/customer/form/x','https://example.com/customer/form']) expect(parseBusinessAddress(address)).toBeNull()
})
it('preserves one draft through dialog and tab remount, while isolating sessions', async () => {
  vi.stubGlobal('fetch', businessFetch((url:string) => Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ fields:runtime.models.customer.fields }:runtime)))))
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
  vi.stubGlobal('fetch',businessFetch((url:string,init?:RequestInit)=>{requests.push(`${init?.method} ${url}`);return init?.method==='POST'?new Promise<Response>((resolve)=>{finish=resolve}):Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ fields:runtime.models.customer.fields }:runtime)))}))
  const b=body(businessAddress('customer','form')); render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('name'),{ target:{ value:'客户' } })
  fireEvent.submit(screen.getByLabelText('name').closest('form')!);fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await waitFor(()=>expect(requests.filter(v=>v.startsWith('POST'))).toEqual(['POST /api/v1/systems/customer/records']))
  finish(new Response(JSON.stringify({ recordId:'actual-id',rowVersion:1 })))
  await waitFor(()=>expect(b.openResource).toHaveBeenCalledWith(businessAddress('customer','detail','actual-id'),{ replaceTab:true }))
  expect(b.store.getSnapshot().drafts).toEqual({})
})
it('keeps refused submission draft and never opens success details',async()=>{
  vi.stubGlobal('fetch',businessFetch((url:string,init?:RequestInit)=>Promise.resolve(new Response(JSON.stringify(init?.method==='POST'?{ error:'KVVI_NOT_ALLOWED' }:url.endsWith('/fields')?{ fields:runtime.models.customer.fields }:runtime),{ status:init?.method==='POST'?403:200 }))))
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
  vi.stubGlobal('fetch',businessFetch((url:string)=>Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ error:'KVVI_NOT_ALLOWED' }:runtime),{ status:url.endsWith('/fields')?403:200 }))))
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props} />)
  await screen.findByText('KVVI_NOT_ALLOWED');expect(screen.queryByLabelText('name')).toBeNull()
})

it('renders choices from the published model when authorized declarations carry top-level options', async()=>{
  const field={ field_code:'status',label:'跟进状态',type:'single_select',type_config:{ options:[{ code:'following',label:'跟进中' },{ code:'retired',label:'停用',enabled:false }] } }
  const projection={ ...runtime,models:{ customer:{ fields:[field] } },views:{ customer:{ view_type:'FORM',componentsTree:[{ id:'f',componentName:'SingleSelectField',props:{ fieldBinding:{ fieldRef:'status' } } }] } } }
  vi.stubGlobal('fetch',businessFetch((url:string)=>Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ fields:[{ field_code:'status',label:'跟进状态',type:'single_select',visibility:'VISIBLE',options:field.type_config.options.filter(option=>option.enabled!==false) }] }:projection)))))
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props} />)
  expect(await screen.findByRole('option',{ name:'跟进中' })).toHaveProperty('value','following')
  expect(screen.queryByRole('option',{ name:'停用' })).toBeNull()
})

it('finds an in-flight create after remount and only opens its result on explicit request',async()=>{
  let finish:(r:Response)=>void=()=>{};let posts=0
  const fetcher=businessFetch((url:string,init?:RequestInit)=>init?.method==='POST'?(posts++,new Promise<Response>((resolve)=>{finish=resolve})):Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields')?{ fields:runtime.models.customer.fields }:runtime))))
  vi.stubGlobal('fetch',fetcher)
  const b=body(businessAddress('customer','form'));const first=render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('name'),{ target:{ value:'只提交一次' } });fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await waitFor(()=>expect(posts).toBe(1));first.unmount()
  render(<BusinessBody {...b.props} />);fireEvent.submit((await screen.findByLabelText('name')).closest('form')!)
  expect(posts).toBe(1)
  finish(new Response(JSON.stringify({ recordId:'saved-once',rowVersion:1 })))
  await waitFor(()=>expect(fetcher.committedCount()).toBe(1))
  expect(b.openResource).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.check']}))
  await screen.findByText(zh['recovery.saved'])
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.view']}))
  await waitFor(()=>expect(b.openResource).toHaveBeenCalledWith(businessAddress('customer','detail','saved-once'),{ replaceTab:true }))
})

it('rechecks a remounted PATCH and reloads current record data after acknowledgement',async()=>{
  let finish:(r:Response)=>void=()=>{};let version=1,reads=0,patches=0,value='旧值'
  const fetcher=businessFetch((url:string,init?:RequestInit)=>{
    if(init?.method==='PATCH'){patches++;return new Promise<Response>((resolve)=>{finish=resolve})}
    if(url.endsWith('/records/r1')){reads++;return Promise.resolve(new Response(JSON.stringify({ recordId:'r1',rowVersion:version,data:{ name:value },fieldVisibility:{ name:'VISIBLE' } })))}
    return Promise.resolve(new Response(JSON.stringify(runtime)))
  });vi.stubGlobal('fetch',fetcher)
  const b=body(businessAddress('customer','detail','r1'));const first=render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('name'),{ target:{ value:'更新' } });fireEvent.click(screen.getByRole('button',{ name:zh['detail.save'] }))
  await waitFor(()=>expect(patches).toBe(1));first.unmount()
  render(<BusinessBody {...b.props} />);await screen.findByLabelText('name');expect(reads).toBe(2)
  version=2;value='服务端最新值';finish(new Response(JSON.stringify({ recordId:'r1',rowVersion:2 })))
  await waitFor(()=>expect(fetcher.committedCount()).toBe(1))
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.check']}))
  await screen.findByText(zh['recovery.saved'])
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.acknowledge']}))
  await waitFor(()=>expect(reads).toBe(3))
  expect(await screen.findByLabelText('name')).toHaveProperty('value','服务端最新值')
  expect(patches).toBe(1)
})


it('does not redirect a business page after leaving a form with a pending submit', async () => {
  let finish: (response: Response) => void = () => {}
  const fetcher=businessFetch((url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>((resolve) => { finish = resolve })
    : Promise.resolve(new Response(JSON.stringify(url.endsWith('/fields') ? { fields: runtime.models.customer.fields } : runtime))))
  vi.stubGlobal('fetch',fetcher)
  const b = body(businessAddress('customer', 'form'))
  const props = {
    ...b.props,identity:entranceIdentity, address: businessAddress('customer', 'form'), navigate: b.openResource, sessionId: 's1',
    useSession: (select: (snapshot: object) => unknown) => select({ blank: true, openState: 'open' }),
    useConversation: (select: (snapshot: object) => unknown) => select({ activeTargets: new Set(), views: { get: () => undefined } }),
    useSessions: (select: (snapshot: object) => unknown) => select({ byId: { s1: { blank: true } } }),
    usePanelInfo: (select: (snapshot: object) => unknown) => select({ activePanelId: 'kvvi-business' }),
  } as unknown as BusinessSessionProps
  const view = render(<BusinessSession {...props}/>)
  fireEvent.change(await screen.findByLabelText('name'), { target: { value: '后台完成' } })
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await waitFor(()=>expect(fetcher.mock.calls.some(([url,init])=>url.endsWith('/records')&&init?.method==='POST')).toBe(true))
  view.rerender(<BusinessSession {...props} address={businessAddress('customer', 'records')}/>)
  finish(new Response(JSON.stringify({ recordId: 'saved', rowVersion: 1 })))
  await waitFor(()=>expect(fetcher.committedCount()).toBe(1))
  expect(b.openResource).not.toHaveBeenCalled()
  view.rerender(<BusinessSession {...props}/>)
  await screen.findByText(zh['recovery.saved'])
  expect(b.openResource).not.toHaveBeenCalled()
})

it('creates all ten types through the real business form with exact JSON wire values',async()=>{
  const fields=[{field_code:'title',type:'short_text'},{field_code:'note',type:'long_text'},
    {field_code:'flag',type:'boolean'},{field_code:'count',type:'integer'},
    {field_code:'rate',type:'decimal',type_config:{precision:38,scale:12}},
    {field_code:'fee',type:'money',type_config:{currency_mode:'FIXED',currency:'CNY'}},
    {field_code:'day',type:'date'},{field_code:'at',type:'datetime'},
    {field_code:'status',type:'single_select',type_config:{options:[{code:'a'}]}},
    {field_code:'tags',type:'multi_select',type_config:{options:[{code:'a'},{code:'b'}]}}]
  const components=['ShortTextField','LongTextField','BooleanField','IntegerField','DecimalField','MoneyField','DateField','DateTimeField','SingleSelectField','MultiSelectField']
  const projected={...runtime,models:{customer:{fields}},views:{customer:{view_type:'FORM',componentsTree:[{id:'root',componentName:'FormPage',children:fields.map((field,i)=>({id:field.field_code,componentName:components[i],props:{fieldBinding:{fieldRef:field.field_code}}}))}]}}}
  const posts:unknown[]=[]
  vi.stubGlobal('fetch',businessFetch((url:string,init?:RequestInit)=>{
    if(init?.method==='POST') {posts.push(JSON.parse(String(init.body)));return Promise.resolve(Response.json({recordId:'typed',rowVersion:1}))}
    return Promise.resolve(Response.json(url.endsWith('/fields')?{fields:fields.map(field=>({...field,visibility:'VISIBLE',options:field.type_config?.options}))}:projected))
  }))
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props} />)
  await screen.findByLabelText('title')
  for(const [field,value] of Object.entries({title:'title',note:'note',count:'0',rate:'12345678901234567890.123456789012',fee:'9007199254740993.01',day:'2026-10-19',at:'2026-10-19T10:15',status:'a'})) {
    fireEvent.change(screen.getByLabelText(field),{target:{value}})
  }
  fireEvent.click(screen.getByLabelText('flag'));fireEvent.click(screen.getByLabelText('flag'))
  fireEvent.click(screen.getByLabelText('tags:a'));fireEvent.click(screen.getByLabelText('tags:b'))
  fireEvent.submit(screen.getByLabelText('title').closest('form')!)
  await waitFor(()=>expect(posts).toHaveLength(1))
  expect(posts[0]).toEqual({data:{title:'title',note:'note',flag:false,count:0,rate:'12345678901234567890.123456789012',fee:{amount:'9007199254740993.01',currency:'CNY'},day:'2026-10-19',at:new Date('2026-10-19T10:15').toISOString(),status:'a',tags:['a','b']}})
})

it('an invalid typed form remains entered and makes no POST',async()=>{
  const field={field_code:'rate',label:'比率',type:'decimal',type_config:{precision:18,scale:2}}
  const projection={...runtime,models:{customer:{fields:[field]}},views:{customer:{view_type:'FORM',componentsTree:[{id:'rate',componentName:'DecimalField',props:{fieldBinding:{fieldRef:'rate'}}}]}}}
  const fetcher=businessFetch((url:string,init?:RequestInit)=>Promise.resolve(Response.json(init?.method==='POST'?{recordId:'bad'}:url.endsWith('/fields')?{fields:[{...field,visibility:'VISIBLE'}]}:projection)))
  vi.stubGlobal('fetch',fetcher)
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props} />)
  fireEvent.change(await screen.findByLabelText('rate'),{target:{value:'1.234'}})
  fireEvent.submit(screen.getByLabelText('rate').closest('form')!)
  expect(fetcher.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false)
  expect(screen.getByRole('alert').textContent).toContain('比率')
  expect(screen.getByLabelText('rate')).toHaveProperty('value','1.234')
})

it('prepares a durable original key before the real business form sends its typed create',async()=>{
  const fetcher=businessFetch(async(url,init)=>Response.json(init?.method==='POST'?{recordId:'prepared-record',rowVersion:1}
    :url.endsWith('/fields')?{fields:runtime.models.customer.fields}:runtime))
  vi.stubGlobal('fetch',fetcher)
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props}/>)
  fireEvent.change(await screen.findByLabelText('name'),{target:{value:'original name'}})
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await waitFor(()=>expect(b.openResource).toHaveBeenCalled())
  const prepare=fetcher.mock.calls.findIndex(([url,init])=>url.endsWith('/write-intent')&&init?.method==='POST')
  const write=fetcher.mock.calls.findIndex(([url,init])=>url.endsWith('/records')&&init?.method==='POST')
  expect(prepare).toBeGreaterThanOrEqual(0)
  expect(write).toBeGreaterThan(prepare)
  expect(new Headers(fetcher.mock.calls[write]?.[1]?.headers).get('idempotency-key')).toBe('prepared-1')
})

it('a fresh business store finds a lost create result without another write or automatic navigation',async()=>{
  const fetcher=businessFetch(async(url,init)=>Response.json(init?.method==='POST'?{recordId:'saved-before-refresh',rowVersion:1}
    :url.endsWith('/fields')?{fields:runtime.models.customer.fields}:runtime))
  vi.stubGlobal('fetch',fetcher);fetcher.loseNextBusinessReply()
  const first=body(businessAddress('customer','form')),mounted=render(<BusinessBody {...first.props}/>)
  fireEvent.change(await screen.findByLabelText('name'),{target:{value:'before refresh'}})
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await screen.findByText(zh['recovery.uncertain']);mounted.unmount()
  const fresh=body(businessAddress('customer','form'));render(<BusinessBody {...fresh.props}/>)
  await screen.findByText(zh['recovery.saved'])
  expect(fresh.openResource).not.toHaveBeenCalled()
  expect(fresh.store.getSnapshot().drafts).toEqual({})
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.view']}))
  await waitFor(()=>expect(fresh.openResource).toHaveBeenCalledWith(businessAddress('customer','detail','saved-before-refresh'),{replaceTab:true}))
  expect(fetcher.mock.calls.filter(([url,init])=>url.endsWith('/records')&&init?.method==='POST')).toHaveLength(1)
})

it('the workbench keeps the record list after creation but honors an explicit view of its saved result',async()=>{
  const fetcher=businessFetch(async(url,init)=>Response.json(init?.method==='POST'?{recordId:'workbench-result',rowVersion:1}
    :url.endsWith('/fields')?{fields:runtime.models.customer.fields}:url.endsWith('/records')?{items:[],fieldVisibility:{}}:runtime))
  vi.stubGlobal('fetch',fetcher)
  const b=body(businessAddress('customer','records'))
  render(<BusinessContent {...b.props} address={businessAddress('customer','records')} signal={new AbortController().signal}
    openResource={b.openResource} presentation="workbench"/>)
  fireEvent.click(await screen.findByRole('button',{name:'新增记录'}))
  fireEvent.change(await screen.findByLabelText('name'),{target:{value:'workbench'}})
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull())
  expect(b.openResource).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button',{name:'新增记录'}))
  await screen.findByText(zh['recovery.saved'])
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.view']}))
  await waitFor(()=>expect(b.openResource).toHaveBeenCalledWith(businessAddress('customer','detail','workbench-result'),{replaceTab:true}))
  expect(fetcher.mock.calls.filter(([url,init])=>url.endsWith('/records')&&init?.method==='POST')).toHaveLength(1)
})

it('a known create cannot clear another tab draft that changed while its response was pending',async()=>{
  let finish!:(response:Response)=>void
  const fetcher=businessFetch((url,init)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve})
    :Promise.resolve(Response.json(url.endsWith('/fields')?{fields:runtime.models.customer.fields}:runtime)))
  vi.stubGlobal('fetch',fetcher)
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props}/>)
  fireEvent.change(await screen.findByLabelText('name'),{target:{value:'submitted draft'}})
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await waitFor(()=>expect(fetcher.mock.calls.some(([url,init])=>url.endsWith('/records')&&init?.method==='POST')).toBe(true))
  b.store.actions.change('customer',{name:'new draft from another tab'})
  finish(Response.json({recordId:'saved-original',rowVersion:1}))
  await waitFor(()=>expect(b.openResource).toHaveBeenCalled())
  expect(await screen.findByLabelText('name')).toHaveProperty('value','new draft from another tab')
  expect(b.store.getSnapshot().drafts.customer?.name).toBe('new draft from another tab')
  const sent=fetcher.mock.calls.find(([url,init])=>url.endsWith('/records')&&init?.method==='POST')
  expect(JSON.parse(String(sent?.[1]?.body))).toEqual({data:{name:'submitted draft'}})
})

it('a late create from a previous identity cannot navigate or change the new identity draft',async()=>{
  let finish!:(response:Response)=>void
  const fetcher=businessFetch((url,init)=>init?.method==='POST'?new Promise(resolve=>{finish=resolve})
    :Promise.resolve(Response.json(url.endsWith('/fields')?{fields:runtime.models.customer.fields}:runtime)))
  vi.stubGlobal('fetch',fetcher)
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props}/>)
  fireEvent.change(await screen.findByLabelText('name'),{target:{value:'old identity draft'}})
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  await waitFor(()=>expect(fetcher.mock.calls.some(([url,init])=>url.endsWith('/records')&&init?.method==='POST')).toBe(true))
  const next={companyId:'other-company',userId:'other-user',sessionId:'other-session',gateway:'USER'}
  fetcher.setEntrance(next);b.store.actions.identify(JSON.stringify(Object.values(next)))
  b.store.actions.change('customer',{name:'new identity draft'})
  await waitFor(()=>expect(screen.getByLabelText('name')).toHaveProperty('value','new identity draft'))
  finish(Response.json({recordId:'old-identity-result',rowVersion:1}))
  await waitFor(()=>expect(fetcher.committedCount()).toBe(1))
  expect(b.openResource).not.toHaveBeenCalled()
  expect(screen.getByLabelText('name')).toHaveProperty('value','new identity draft')
  expect(b.store.getSnapshot().drafts.customer?.name).toBe('new identity draft')
})


it('an explicit retry clears only the unchanged originally submitted create draft',async()=>{
  let writes=0
  const fetcher=businessFetch(async(url,init)=>{
    if(init?.method==='POST') {
      writes++
      return writes===1?Response.json({error:'KVVI_INTERNAL_ERROR'},{status:500}):Response.json({recordId:'retry-result',rowVersion:1})
    }
    return Response.json(url.endsWith('/fields')?{fields:runtime.models.customer.fields}:runtime)
  })
  vi.stubGlobal('fetch',fetcher)
  const b=body(businessAddress('customer','form'));render(<BusinessBody {...b.props}/>)
  fireEvent.change(await screen.findByLabelText('name'),{target:{value:'original retry draft'}})
  fireEvent.submit(screen.getByLabelText('name').closest('form')!)
  fireEvent.click(await screen.findByRole('button',{name:zh['recovery.retry']}))
  await waitFor(()=>expect(b.openResource).toHaveBeenCalled())
  expect(writes).toBe(2)
  expect(b.store.getSnapshot().drafts.customer).toBeUndefined()
})

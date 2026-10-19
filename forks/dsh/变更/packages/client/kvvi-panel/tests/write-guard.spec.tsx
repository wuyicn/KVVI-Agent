// @vitest-environment jsdom
import {StrictMode,useState} from 'react'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {RecordWriteGuard} from '../src/client/RecordWriteGuard.tsx'
import {zh} from '../src/client/locales.ts'
import type {RecordWriteResult} from '../src/client/api.ts'
afterEach(()=>{cleanup();vi.unstubAllGlobals()})
const who={companyId:'company',userId:'alice',sessionId:'session',gateway:'USER'}
const identity=JSON.stringify(Object.values(who))
const copy=(key:string,params?:Record<string,unknown>)=>((zh as Record<string,string>)[key]??key).replace(/\{(\w+)\}/gu,(_,name:string)=>String(params?.[name]??''))
function api(initial:'EMPTY'|'PREPARED'|'COMMITTED'='EMPTY') {
  let state=initial,lose=false,effects=initial==='COMMITTED'?1:0,restricted=false,auth={...who},operationOwner=who.userId,prepareFails=false
  let prepareReply:Promise<void>|undefined,writeReply:Promise<void>|undefined,controlReply:Promise<void>|undefined
  const result={recordId:'saved-record',rowVersion:1}, receipt={state:'COMMITTED',operationId:'op',statusCode:201,result,auditPending:false}
  const fetcher=vi.fn(async(url:string,init:RequestInit={})=>{
    if(url==='/auth/session') return Response.json(auth)
    if(url.endsWith('/write-receipt')) return effects?Response.json(receipt):Response.json({state:'UNKNOWN',idempotencyKey:'original',retryWithSameKey:true},{status:202})
    if(url.endsWith('/write-intent')) {
      if(init.method==='POST'){
        state='PREPARED';operationOwner=auth.userId;if(prepareReply)await prepareReply
        if(prepareFails)throw new Error('prepare reply lost')
        return Response.json({state:'PREPARED',idempotencyKey:'original'})
      }
      const visible=operationOwner===auth.userId?state:'EMPTY'
      return Response.json(visible==='EMPTY'?{state:visible}:visible==='COMMITTED'
        ?restricted?{state:visible,idempotencyKey:'original',resultRestricted:true}:{...receipt,idempotencyKey:'original'}
        :{state:visible,idempotencyKey:'original'})
    }
    if(url.endsWith('/acknowledge')) {state='EMPTY';if(controlReply)await controlReply;return Response.json({state:'ACKNOWLEDGED',idempotencyKey:'original'})}
    if(url.endsWith('/cancel')) {
      if(state==='COMMITTED')return Response.json({...receipt,idempotencyKey:'original'})
      state='EMPTY';return Response.json({state:'CANCELED',idempotencyKey:'original'})
    }
    if(url.endsWith('/records')&&init.method==='POST') {
      effects++;state='COMMITTED'
      if(writeReply)await writeReply
      if(lose)throw new Error('lost reply')
      return Response.json(result,{status:201})
    }
    throw new Error('unexpected route '+url)
  })
  vi.stubGlobal('fetch',fetcher)
  return {fetcher,result,get effects(){return effects},set lose(value:boolean){lose=value},
    set restricted(value:boolean){restricted=value},set auth(value:typeof who){auth=value},
    set prepareReply(value:Promise<void>){prepareReply=value},set writeReply(value:Promise<void>){writeReply=value},
    set prepareFails(value:boolean){prepareFails=value},set controlReply(value:Promise<void>){controlReply=value}}
}
function harness() {
  const committed=vi.fn(),failure=vi.fn(),reload=vi.fn()
  function Harness({scope=identity,completed=committed,reloaded=reload}:{scope?:string;completed?:(result:RecordWriteResult)=>void;reloaded?:()=>void}={}) {
    const [generation,setGeneration]=useState(0)
    return <RecordWriteGuard target={{assetId:'form'}} identity={scope} generation={generation} copy={copy}
      onCommitted={completed} onFailure={failure} onReload={()=>{reloaded();setGeneration(value=>value+1)}}>
      {({busy,submit})=><form aria-label="business form" onSubmit={event=>{event.preventDefault();submit({data:{title:'original'}})}}>
        <input aria-label="title" disabled={busy}/><button disabled={busy}>提交</button>
      </form>}
    </RecordWriteGuard>
  }
  return {Harness,committed,failure,reload}
}

it('prepares once under StrictMode and holds the form until acknowledgement reloads it',async()=>{
  const s=api(),h=harness();render(<StrictMode><h.Harness/></StrictMode>)
  const form=await screen.findByRole('form',{name:'business form'})
  fireEvent.submit(form);fireEvent.submit(form)
  await waitFor(()=>expect(h.committed).toHaveBeenCalledOnce())
  expect(s.effects).toBe(1)
  expect(screen.getByLabelText('title')).toHaveProperty('disabled',true)
  expect(screen.getByText(copy('recovery.saved'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.acknowledge')}))
  await waitFor(()=>expect(h.reload).toHaveBeenCalledOnce())
  await waitFor(()=>expect(screen.getByLabelText('title')).toHaveProperty('disabled',false))
  const write=s.fetcher.mock.calls.find(([url,init])=>url.endsWith('/records')&&init?.method==='POST')
  expect(new Headers(write?.[1]?.headers).get('idempotency-key')).toBe('original')
})

it('finds pending metadata after remount and cancels through the server without replaying',async()=>{
  const s=api('PREPARED'),h=harness();const first=render(<h.Harness/>)
  await screen.findByText(copy('recovery.pending'));first.unmount();render(<h.Harness/>)
  await screen.findByText(copy('recovery.pending'))
  expect(screen.getByLabelText('title')).toHaveProperty('disabled',true)
  expect(screen.queryByRole('button',{name:copy('recovery.retry')})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.cancel')}))
  await waitFor(()=>expect(h.reload).toHaveBeenCalledOnce())
  expect(s.effects).toBe(0)
  expect(s.fetcher.mock.calls.some(([url,init])=>url.endsWith('/records')&&init?.method==='POST')).toBe(false)
})

it('a lost response checks the original result without navigating or writing automatically',async()=>{
  const s=api(),h=harness();s.lose=true;render(<h.Harness/>)
  fireEvent.submit(await screen.findByRole('form',{name:'business form'}))
  await screen.findByText(copy('recovery.pending'))
  await waitFor(()=>expect(h.failure).toHaveBeenCalled())
  expect(h.committed).not.toHaveBeenCalled()
  expect(screen.queryByText(copy('form.writeFailed'))).toBeNull()
  expect(screen.getByText(copy('recovery.uncertain'))).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.check')}))
  await screen.findByText(copy('recovery.saved'))
  expect(h.committed).not.toHaveBeenCalled()
  expect(s.effects).toBe(1)
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.view')}))
  await waitFor(()=>expect(h.committed).toHaveBeenCalledWith(s.result))
  expect(s.effects).toBe(1)
})

it('restored committed results require an explicit view action and retain the original key for acknowledgement',async()=>{
  const s=api('COMMITTED'),h=harness();render(<h.Harness/>)
  await screen.findByText(copy('recovery.saved'))
  expect(h.committed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.acknowledge')}))
  await waitFor(()=>expect(h.reload).toHaveBeenCalledOnce())
  const ack=s.fetcher.mock.calls.find(([url])=>url.endsWith('/acknowledge'))
  expect(new Headers(ack?.[1]?.headers).get('idempotency-key')).toBe('original')
  expect(s.effects).toBe(1)
})

it('restricted committed metadata hides the form and result while allowing acknowledgement',async()=>{
  const s=api('COMMITTED'),h=harness();s.restricted=true;render(<h.Harness/>)
  await screen.findByText(copy('recovery.savedRestricted'))
  expect(screen.queryByLabelText('title')).toBeNull()
  expect(screen.queryByRole('button',{name:copy('recovery.view')})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.acknowledge')}))
  await waitFor(()=>expect(h.reload).toHaveBeenCalledOnce())
  expect(h.committed).not.toHaveBeenCalled()
  expect(s.effects).toBe(1)
})

it('switching identity during prepare cannot publish or write the old occurrence',async()=>{
  const s=api(),h=harness();let release!:()=>void
  s.prepareReply=new Promise<void>(resolve=>{release=resolve})
  const view=render(<h.Harness/>)
  fireEvent.submit(await screen.findByRole('form',{name:'business form'}))
  await waitFor(()=>expect(s.fetcher.mock.calls.some(([url,init])=>url.endsWith('/write-intent')&&init?.method==='POST')).toBe(true))
  const next={...who,userId:'bob',sessionId:'bob-session'};s.auth=next
  view.rerender(<h.Harness scope={JSON.stringify(Object.values(next))}/>);release()
  await waitFor(()=>expect(screen.getByLabelText('title')).toHaveProperty('disabled',false))
  expect(s.effects).toBe(0)
  expect(h.committed).not.toHaveBeenCalled()
  expect(h.failure).not.toHaveBeenCalled()
})

it('a remounted guard finds an already committed in-flight write and ignores the old callback',async()=>{
  const s=api(),h=harness();let release!:()=>void
  s.writeReply=new Promise<void>(resolve=>{release=resolve})
  const first=render(<h.Harness/>);fireEvent.submit(await screen.findByRole('form',{name:'business form'}))
  await waitFor(()=>expect(s.effects).toBe(1))
  first.unmount();render(<h.Harness/>)
  await screen.findByText(copy('recovery.saved'));release()
  expect(h.committed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.view')}))
  await waitFor(()=>expect(h.committed).toHaveBeenCalledOnce())
  expect(s.effects).toBe(1)
})

it('cancel discovering a committed result shows that result without clearing it or reloading',async()=>{
  const s=api(),h=harness();s.lose=true;render(<h.Harness/>)
  fireEvent.submit(await screen.findByRole('form',{name:'business form'}))
  await waitFor(()=>expect(h.failure).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.cancel')}))
  await screen.findByText(copy('recovery.saved'))
  expect(h.reload).not.toHaveBeenCalled()
  expect(h.committed).not.toHaveBeenCalled()
  expect(s.effects).toBe(1)
})

it('uses current completion and reload callbacks when they change within the same scope',async()=>{
  const s=api(),h=harness(),oldCompleted=vi.fn(),newCompleted=vi.fn(),oldReload=vi.fn(),newReload=vi.fn()
  let releaseWrite!:()=>void,releaseControl!:()=>void
  s.writeReply=new Promise<void>(resolve=>{releaseWrite=resolve})
  const view=render(<h.Harness completed={oldCompleted} reloaded={oldReload}/>)
  fireEvent.submit(await screen.findByRole('form',{name:'business form'}))
  await waitFor(()=>expect(s.effects).toBe(1))
  view.rerender(<h.Harness completed={newCompleted} reloaded={oldReload}/>);releaseWrite()
  await waitFor(()=>expect(newCompleted).toHaveBeenCalledWith(s.result))
  expect(oldCompleted).not.toHaveBeenCalled()
  s.controlReply=new Promise<void>(resolve=>{releaseControl=resolve})
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.acknowledge')}))
  await waitFor(()=>expect(s.fetcher.mock.calls.some(([url])=>url.endsWith('/acknowledge'))).toBe(true))
  view.rerender(<h.Harness completed={newCompleted} reloaded={newReload}/>);releaseControl()
  await waitFor(()=>expect(newReload).toHaveBeenCalledOnce())
  expect(oldReload).not.toHaveBeenCalled()
})

it('an unidentified prepare outcome offers checking before cancellation can become available',async()=>{
  const s=api(),h=harness();s.prepareFails=true;render(<h.Harness/>)
  fireEvent.submit(await screen.findByRole('form',{name:'business form'}))
  await waitFor(()=>expect(h.failure).toHaveBeenCalled())
  expect(screen.queryByRole('button',{name:copy('recovery.cancel')})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:copy('recovery.check')}))
  await screen.findByRole('button',{name:copy('recovery.cancel')})
  expect(s.effects).toBe(0)
})

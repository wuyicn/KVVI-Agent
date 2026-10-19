import {afterEach,expect,it,vi} from 'vitest'
import {createRecordWriteController} from '../src/client/record-write.ts'

afterEach(()=>vi.unstubAllGlobals())
const identity={companyId:'company',userId:'alice',sessionId:'session',gateway:'USER'}
const scope=JSON.stringify(Object.values(identity))
const target={assetId:'form'}
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}

function server() {
  let who={...identity}, active=false, canceled=false, committed=false, effect=0, beforeWriteFailure=false, lostReply=false
  let prepareFailure=false, prepareReply:Promise<void>|undefined,writeReply:Promise<void>|undefined
  const writes:Array<{key:string|null;body:unknown}>=[]
  const result={recordId:'record-1',rowVersion:1}
  const receipt=()=>({state:'COMMITTED',operationId:'operation-1',statusCode:201,result,auditPending:false})
  const fetcher=vi.fn(async(url:string,init:RequestInit={})=>{
    if(url==='/auth/session') return Response.json(who)
    const key=new Headers(init.headers).get('idempotency-key')
    if(url.endsWith('/write-receipt')) return committed?Response.json(receipt()):Response.json({state:'UNKNOWN',idempotencyKey:key,retryWithSameKey:true},{status:202})
    if(url.endsWith('/write-intent')&&init.method==='GET') return Response.json(active
      ?committed?{...receipt(),idempotencyKey:'original-key'}:{state:'PREPARED',idempotencyKey:'original-key'}:{state:'EMPTY'})
    if(url.endsWith('/write-intent')&&init.method==='POST') {
      if(prepareFailure) throw new Error('prepare storage unavailable')
      active=true
      if(prepareReply) await prepareReply
      return Response.json(committed?{...receipt(),idempotencyKey:'original-key'}:{state:'PREPARED',idempotencyKey:'original-key'})
    }
    if(url.endsWith('/cancel')) {
      if(committed) return Response.json({...receipt(),idempotencyKey:'original-key'})
      active=false;canceled=true;return Response.json({state:'CANCELED',idempotencyKey:'original-key'})
    }
    if(url.endsWith('/acknowledge')) {
      if(!committed) return Response.json({error:'KVVI_OPERATION_NOT_COMMITTED'},{status:409})
      active=false;return Response.json({state:'ACKNOWLEDGED',idempotencyKey:'original-key'})
    }
    if(url.endsWith('/records')&&init.method==='POST') {
      writes.push({key,body:JSON.parse(String(init.body))})
      if(beforeWriteFailure) throw new Error('not delivered')
      if(canceled) return Response.json({error:'KVVI_OPERATION_CANCELED'},{status:409})
      if(!committed) {effect++;committed=true}
      if(writeReply) await writeReply
      if(lostReply) throw new Error('reply lost after commit')
      return Response.json(result,{status:201})
    }
    throw new Error('unexpected route '+url)
  })
  vi.stubGlobal('fetch',fetcher)
  return {fetcher,writes,result,get effect(){return effect},set who(next:typeof identity){who=next},
    set beforeWriteFailure(value:boolean){beforeWriteFailure=value},set lostReply(value:boolean){lostReply=value},
    set prepareFailure(value:boolean){prepareFailure=value},set prepareReply(value:Promise<void>){prepareReply=value},
    set writeReply(value:Promise<void>){writeReply=value}}
}
const controller=()=>createRecordWriteController(target,{expectedIdentity:scope})

it('prepares before writing and blocks new actions until explicit acknowledgement and reload',async()=>{
  const s=server(), c=controller()
  await c.refresh()
  expect(c.getSnapshot().phase).toBe('ready')
  expect(await c.submit({data:{title:'private original'}})).toEqual(s.result)
  expect(s.writes).toHaveLength(1)
  expect(s.writes[0]?.key).toBe('original-key')
  expect(c.getSnapshot().phase).toBe('committed')
  expect(JSON.stringify(c.getSnapshot())).not.toContain('private original')
  expect(await c.submit({data:{title:'another'}})).toBeUndefined()
  expect(s.writes).toHaveLength(1)
  expect(await c.acknowledge()).toBe(true)
  expect(c.getSnapshot().phase).toBe('settled')
  expect(await c.submit({data:{title:'before reload'}})).toBeUndefined()
  await c.refresh()
  expect(c.getSnapshot().phase).toBe('ready')
})

it('a failed durable prepare never sends a business write; checking cannot retry one',async()=>{
  const s=server(),c=controller();await c.refresh();s.prepareFailure=true
  expect(await c.submit({data:{title:'not prepared'}})).toBeUndefined()
  expect(c.getSnapshot().phase).toBe('pending')
  expect(s.writes).toHaveLength(0)
  await c.refresh()
  expect(c.getSnapshot().phase).toBe('ready')
  expect(s.writes).toHaveLength(0)
})

it('lost committed response recovers by original receipt and never automatically writes on refresh',async()=>{
  const s=server(),c=controller();await c.refresh();s.lostReply=true
  expect(await c.submit({data:{title:'lost reply'}})).toBeUndefined()
  expect(c.getSnapshot().phase).toBe('pending')
  expect(s.effect).toBe(1)
  await c.refresh()
  expect(c.getSnapshot().phase).toBe('committed')
  expect(s.writes).toHaveLength(1)
  expect(await c.retry()).toEqual(s.result)
  expect(s.writes).toHaveLength(1)
})

it('an explicit retry freezes the original body and key rather than taking newly edited values',async()=>{
  const s=server(),c=controller();await c.refresh();s.beforeWriteFailure=true
  const input={data:{title:'original',tags:['a']}}
  await c.submit(input)
  input.data.title='edited';input.data.tags.push('b')
  expect(c.getSnapshot().canRetry).toBe(true)
  s.beforeWriteFailure=false
  expect(await c.retry()).toEqual(s.result)
  expect(s.writes).toEqual([
    {key:'original-key',body:{data:{title:'original',tags:['a']}}},
    {key:'original-key',body:{data:{title:'original',tags:['a']}}},
  ])
  expect(s.effect).toBe(1)
})

it('closing during prepare prevents the late business write; a fresh controller only finds metadata',async()=>{
  const s=server(),c=controller(), waiting=deferred<void>();await c.refresh();s.prepareReply=waiting.promise
  const submitting=c.submit({data:{title:'closed before write'}})
  await vi.waitFor(()=>expect(s.fetcher.mock.calls.some(([url,init])=>url.endsWith('/write-intent')&&init?.method==='POST')).toBe(true))
  c.dispose();waiting.resolve();await submitting
  expect(s.writes).toHaveLength(0)
  const fresh=controller();await fresh.refresh()
  expect(fresh.getSnapshot().phase).toBe('pending')
  expect(fresh.getSnapshot().canRetry).toBe(false)
  expect(await fresh.retry()).toBeUndefined()
  expect(await fresh.cancel()).toBe(true)
  expect(fresh.getSnapshot().phase).toBe('settled')
  expect(s.effect).toBe(0)
})

it('identity changes after prepare never send the frozen request as another session or gateway',async()=>{
  for(const change of [{companyId:'other'},{userId:'bob'},{sessionId:'new-session'},{gateway:'BUILDER'}]) {
    const s=server(),c=controller(),waiting=deferred<void>();await c.refresh();s.prepareReply=waiting.promise
    const submitting=c.submit({data:{title:'original owner only'}})
    await vi.waitFor(()=>expect(s.fetcher.mock.calls.some(([url,init])=>url.endsWith('/write-intent')&&init?.method==='POST')).toBe(true))
    s.who={...identity,...change};waiting.resolve();await submitting
    expect(c.getSnapshot().phase).toBe('blocked')
    expect(c.getSnapshot().error?.code).toBe('KVVI_WRITE_IDENTITY_CHANGED')
    expect(s.writes).toHaveLength(0)
    expect(await c.cancel()).toBe(false)
    c.dispose()
  }
})

it('a render occurrence that became stale cannot publish or send a late prepared request',async()=>{
  const s=server(),waiting=deferred<void>();let current=true
  const c=createRecordWriteController(target,{expectedIdentity:scope,isCurrent:()=>current})
  await c.refresh();s.prepareReply=waiting.promise
  const submitting=c.submit({data:{title:'old occurrence'}})
  await vi.waitFor(()=>expect(s.fetcher.mock.calls.some(([url,init])=>url.endsWith('/write-intent')&&init?.method==='POST')).toBe(true))
  current=false;waiting.resolve();await submitting
  expect(s.writes).toHaveLength(0)
  expect(c.isCurrent()).toBe(false)
})

it('an original receipt remains recoverable after another tab acknowledged the active intent',async()=>{
  const s=server(),c=controller();await c.refresh();s.lostReply=true
  await c.submit({data:{title:'peer acknowledged'}})
  const peer=controller();await peer.refresh();expect(await peer.acknowledge()).toBe(true)
  await c.refresh()
  expect(c.getSnapshot().phase).toBe('committed')
  expect(s.writes).toHaveLength(1)
  expect(s.effect).toBe(1)
})

it('freezes the target endpoint as well as the request while preparation is in flight',async()=>{
  const s=server(), mutableTarget={assetId:'original-form'},waiting=deferred<void>()
  const c=createRecordWriteController(mutableTarget,{expectedIdentity:scope})
  await c.refresh();s.prepareReply=waiting.promise
  const submitting=c.submit({data:{title:'original endpoint'}})
  await vi.waitFor(()=>expect(s.fetcher.mock.calls.some(([url,init])=>url.endsWith('/write-intent')&&init?.method==='POST')).toBe(true))
  mutableTarget.assetId='changed-form';waiting.resolve();await submitting
  expect(s.fetcher.mock.calls.filter(([url,init])=>url.endsWith('/records')&&init?.method==='POST').map(([url])=>url))
    .toEqual(['/api/v1/systems/original-form/records'])
})

it('keeps a known version conflict blocked across checks instead of retrying the stale body',async()=>{
  let active=false,writes=0
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit={})=>{
    if(url==='/auth/session') return Response.json(identity)
    if(url.endsWith('/write-receipt')) return Response.json({state:'UNKNOWN',idempotencyKey:'original-key',retryWithSameKey:true},{status:202})
    if(url.endsWith('/write-intent')) {
      if(init.method==='POST') active=true
      return Response.json(active?{state:'PREPARED',idempotencyKey:'original-key'}:{state:'EMPTY'})
    }
    if(init.method==='PATCH') {writes++;return Response.json({error:'KVVI_ROW_VERSION_CONFLICT',currentRowVersion:2},{status:409})}
    throw new Error('unexpected route')
  }))
  const c=createRecordWriteController({assetId:'form',recordId:'r1'},{expectedIdentity:scope})
  await c.refresh();await c.submit({data:{title:'stale edit'},rowVersion:1})
  expect(c.getSnapshot().canRetry).toBe(false)
  await c.refresh()
  expect(c.getSnapshot().canRetry).toBe(false)
  expect(c.getSnapshot().error?.code).toBe('KVVI_ROW_VERSION_CONFLICT')
  expect(c.getSnapshot().error?.currentRowVersion).toBe(2)
  expect(await c.retry()).toBeUndefined()
  expect(writes).toBe(1)
})

it('malformed entrance identity fails closed without an unhandled rejection',async()=>{
  for(const body of [null,{},[],{...identity,gateway:'ADMIN'},{...identity,userId:5}]) {
    const fetcher=vi.fn().mockResolvedValue(Response.json(body));vi.stubGlobal('fetch',fetcher)
    const c=controller()
    await expect(c.refresh()).resolves.toBeUndefined()
    expect(c.getSnapshot().phase).toBe('blocked')
    expect(c.getSnapshot().error?.code).toBe('KVVI_BAD_RESPONSE')
    expect(fetcher).toHaveBeenCalledTimes(1)
    c.dispose()
  }
})

it('a restored committed key survives peer acknowledgement without needing a resident request body',async()=>{
  const s=server(),first=controller();await first.refresh();await first.submit({data:{title:'committed before restore'}})
  const restored=controller();await restored.refresh();expect(restored.getSnapshot().phase).toBe('committed')
  await first.acknowledge();await restored.refresh()
  expect(restored.getSnapshot().phase).toBe('committed')
  expect(restored.getSnapshot().intent).toHaveProperty('idempotencyKey','original-key')
  expect(s.writes).toHaveLength(1)
})

it('a restored prepared key stays bound when a peer writes and acknowledges it',async()=>{
  const s=server(),first=controller();await first.refresh();s.beforeWriteFailure=true
  await first.submit({data:{title:'prepared before restore'}})
  const restored=controller();await restored.refresh();expect(restored.getSnapshot().phase).toBe('pending')
  expect(restored.getSnapshot().canRetry).toBe(false)
  s.beforeWriteFailure=false;await first.retry();await first.acknowledge();await restored.refresh()
  expect(restored.getSnapshot().phase).toBe('committed')
  expect(s.effect).toBe(1)
})

it('prepare directly returning a peer committed result also remembers that original key',async()=>{
  const s=server(),first=controller(),second=controller();await first.refresh();await second.refresh()
  await first.submit({data:{title:'same body'}})
  expect(await second.submit({data:{title:'same body'}})).toEqual(s.result)
  await first.acknowledge();await second.refresh()
  expect(second.getSnapshot().phase).toBe('committed')
  expect(s.writes).toHaveLength(1)
})

it('a failed prepare cannot bind its unconfirmed body to an independently discovered active key',async()=>{
  const s=server(),c=controller();await c.refresh()
  await s.fetcher('/api/v1/systems/form/write-intent',{method:'POST',body:JSON.stringify({data:{title:'peer prepared'}})})
  s.prepareFailure=true;await c.submit({data:{title:'unconfirmed different input'}})
  await c.refresh()
  expect(c.getSnapshot().phase).toBe('pending')
  expect(c.getSnapshot().canRetry).toBe(false)
  expect(await c.retry()).toBeUndefined()
  expect(s.writes).toHaveLength(0)
})

it('a hung write reply has a bounded wait, retains the key and ignores its late completion',async()=>{
  const s=server(), waiting=deferred<void>(), c=createRecordWriteController(target,{expectedIdentity:scope,requestTimeoutMs:20})
  await c.refresh();s.writeReply=waiting.promise
  const submitting=c.submit({data:{title:'hung committed reply'}})
  const outcome=await Promise.race([submitting.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),150))])
  if(!outcome) {c.dispose();waiting.resolve();await submitting;expect(outcome).toBe(true);return}
  expect(c.getSnapshot().phase).toBe('pending')
  expect(c.getSnapshot().error).toMatchObject({status:0,code:'KVVI_OPERATION_OUTCOME_UNKNOWN',idempotencyKey:'original-key'})
  const post=s.fetcher.mock.calls.find(([url,init])=>url.endsWith('/records')&&init?.method==='POST')
  expect(post?.[1]?.signal?.aborted).toBe(true)
  await c.refresh();expect(c.getSnapshot().phase).toBe('committed')
  waiting.resolve();await Promise.resolve()
  expect(c.getSnapshot().phase).toBe('committed')
  expect(s.effect).toBe(1)
  expect(s.writes).toHaveLength(1)
  c.dispose()
})

it('a hung prepare is uncertain, aborts its HTTP wait and never sends a late business write',async()=>{
  const s=server(), waiting=deferred<void>(), c=createRecordWriteController(target,{expectedIdentity:scope,requestTimeoutMs:20})
  await c.refresh();s.prepareReply=waiting.promise
  const submitting=c.submit({data:{title:'hung prepare'}})
  const outcome=await Promise.race([submitting.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),150))])
  if(!outcome) {c.dispose();waiting.resolve();await submitting;expect(outcome).toBe(true);return}
  expect(c.getSnapshot().error?.code).toBe('KVVI_OPERATION_OUTCOME_UNKNOWN')
  await c.refresh();expect(c.getSnapshot().canRetry).toBe(false)
  expect(await c.cancel()).toBe(true)
  waiting.resolve();await Promise.resolve()
  expect(s.writes).toHaveLength(0)
  expect(s.effect).toBe(0)
  c.dispose()
})

it('a hung authentication response body has a bounded read without starting any intent request',async()=>{
  const waiting=deferred<unknown>(),fetcher=vi.fn(async()=>({ok:true,status:200,json:()=>waiting.promise}))
  vi.stubGlobal('fetch',fetcher)
  const c=createRecordWriteController(target,{expectedIdentity:scope,requestTimeoutMs:20})
  await c.refresh()
  expect(c.getSnapshot().phase).toBe('blocked')
  expect(c.getSnapshot().error).toMatchObject({status:0,code:'KVVI_UNREACHABLE'})
  expect(fetcher).toHaveBeenCalledTimes(1)
  c.dispose();waiting.resolve(identity);await Promise.resolve()
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('dispose immediately releases an in-flight write even when fetch ignores abort and later rejects',async()=>{
  const s=server(),waiting=deferred<void>(),c=controller();await c.refresh();s.writeReply=waiting.promise
  const submitting=c.submit({data:{title:'dispose hung write'}})
  await vi.waitFor(()=>expect(s.writes).toHaveLength(1))
  c.dispose()
  const outcome=await Promise.race([submitting.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))])
  s.lostReply=true;waiting.resolve();await submitting
  expect(outcome).toBe(true)
  const post=s.fetcher.mock.calls.find(([url,init])=>url.endsWith('/records')&&init?.method==='POST')
  expect(post?.[1]?.signal?.aborted).toBe(true)
  expect(s.effect).toBe(1)
  expect(s.writes).toHaveLength(1)
})

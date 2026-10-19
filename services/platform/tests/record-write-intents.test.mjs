import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {A,B,resetDatabase,grantBaseline,grantPlatformRole,makeSession,pool,closeAll,adminQuery} from './harness.mjs'
import {submitDraft,approveDraft,publishDraft,DIFF_FACES} from '../src/publish.mjs'
import {api} from './directory-fixture.mjs'
import {handleApi} from '../src/api-router.mjs'
import {handleAuth} from '../src/auth.mjs'

let alice,bob,other
const records='/systems/general_item/records', intent='/systems/general_item/write-intent'
const call=async(...args)=>api(...args).catch(error=>({status:500,body:{error:error.code}}))
const effects=async title=>(await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'=$1",[title])).rows[0].n
before(async()=>{
  await resetDatabase()
  for(const user of [A.alice,A.bob]) {await grantBaseline(user);await grantPlatformRole(user,'owner')}
  alice=await makeSession(A.alice,A.company);bob=await makeSession(A.bob,A.company);other=await makeSession(B.dave,B.company)
  const draft=await submitDraft({ctx:alice.ctx,change:{assetId:'general_item'},diffReport:{faces:DIFF_FACES},invariant:{ok:true}})
  await approveDraft({ctx:bob.ctx,draftId:draft.draftId,decision:'APPROVE'})
  const specs={'business-schema':{schema_code:'general_item',fields:[{field_code:'title',type:'short_text'}]},
    'view-schema':{componentsTree:[]},'workflow-spec':{states:[{state_code:'draft',initial:true}],transitions:[]},
    'permission-spec':{roles:[],policies:[]},'tool-spec':{tools:[]},'app-model-command':{commands:[]}}
  await publishDraft({ctx:bob.ctx,draftId:draft.draftId,apply:async({diffDigest})=>({diffDigest}),
    system:{assetId:'general_item',schemaCode:'general_item',name:'Intents'},
    contracts:Object.entries(specs).map(([contractType,content])=>({contractType,content,assetId:'general_item'}))})
})
after(closeAll)
async function settle(session=alice,url=intent) {
  const active=await call(session,'GET',url)
  if(active.body.state==='PREPARED') await call(session,'POST',url+'/cancel',{},active.body.idempotencyKey)
  else if(active.body.state==='COMMITTED') await call(session,'POST',url+'/acknowledge',{},active.body.idempotencyKey)
}

test('concurrent preparation reserves one durable key; relogin finds it without storing business values',async()=>{
  await settle()
  const request={data:{title:'one prepared intent'}}
  const prepared=await Promise.all(Array.from({length:12},()=>call(alice,'POST',intent,request)))
  assert.ok(prepared.every(result=>result.status===200))
  const keys=new Set(prepared.map(result=>result.body.idempotencyKey))
  assert.equal(keys.size,1)
  const key=[...keys][0]
  assert.equal(typeof key,'string')
  assert.equal(await effects(request.data.title),0)
  const fresh=await makeSession(A.alice,A.company)
  const active=await call(fresh,'GET',intent)
  assert.equal(active.body.idempotencyKey,key)
  assert.equal(active.body.state,'PREPARED')
  assert.equal(JSON.stringify(active.body).includes(request.data.title),false)
  const isolated=await call(bob,'GET',intent)
  assert.equal(isolated.body.state,'EMPTY')
  const created=await call(alice,'POST',records,request,key)
  assert.equal(created.status,201)
  const current=await call(fresh,'GET',intent)
  assert.equal(current.body.state,'COMMITTED')
  assert.equal(current.body.result.recordId,created.body.recordId)
  const ack=await call(fresh,'POST',intent+'/acknowledge',{},key)
  assert.equal(ack.body.state,'ACKNOWLEDGED')
  assert.equal((await call(fresh,'GET',intent)).body.state,'EMPTY')
  assert.equal(await effects(request.data.title),1)
})

test('pending intent cannot be replaced or executed with changed input',async()=>{
  await settle()
  const a={data:{title:'original frozen intent'}}, b={data:{title:'different intent'}}
  const prepared=await call(alice,'POST',intent,a), key=prepared.body.idempotencyKey
  assert.equal(prepared.status,200)
  const changed=await call(alice,'POST',intent,b)
  assert.equal(changed.status,409)
  assert.equal(changed.body.error,'KVVI_OPERATION_PENDING_DIFFERENT_INPUT')
  const refused=await call(alice,'POST',records,b,key)
  assert.equal(refused.status,409)
  assert.equal(refused.body.error,'KVVI_OPERATION_KEY_CONFLICT')
  assert.equal(await effects(b.data.title),0)
  assert.equal((await call(alice,'POST',records,a,key)).status,201)
  await settle()
})

test('cancellation seals the original key before permitting a new intent',async()=>{
  await settle()
  const request={data:{title:'canceled late request'}}
  const prepared=await call(alice,'POST',intent,request), key=prepared.body.idempotencyKey
  assert.equal(prepared.status,200)
  const canceled=await call(alice,'POST',intent+'/cancel',{},key)
  assert.equal(canceled.body.state,'CANCELED')
  const again=await call(alice,'POST',intent+'/cancel',{},key)
  assert.equal(again.body.state,'CANCELED')
  assert.equal((await call(alice,'GET',intent)).body.state,'EMPTY')
  const late=await call(alice,'POST',records,request,key)
  assert.equal(late.status,409)
  assert.equal(late.body.error,'KVVI_OPERATION_CANCELED')
  assert.equal(await effects(request.data.title),0)
  const next=await call(alice,'POST',intent,{data:{title:'new after seal'}})
  assert.equal(next.status,200)
  assert.notEqual(next.body.idempotencyKey,key)
  await settle()
})

test('a cancel racing the original write yields either one committed result or a durable tombstone',async()=>{
  for(let i=0;i<6;i++) {
    await settle()
    const request={data:{title:`cancel race ${i}`}}
    const prepared=await call(alice,'POST',intent,request), key=prepared.body.idempotencyKey
    const [write,cancel]=await Promise.all([call(alice,'POST',records,request,key),call(alice,'POST',intent+'/cancel',{},key)])
    assert.ok([201,409].includes(write.status))
    assert.equal(cancel.status,200)
    if(write.status===201) {
      assert.equal(cancel.body.state,'COMMITTED')
      assert.equal(cancel.body.result.recordId,write.body.recordId)
      assert.equal(await effects(request.data.title),1)
    } else {
      assert.equal(cancel.body.state,'CANCELED')
      assert.equal(await effects(request.data.title),0)
    }
  }
  await settle()
})

test('PATCH intents bind the original rowVersion and are separate from create intents',async()=>{
  const created=await call(alice,'POST',records,{data:{title:'patch intent'}})
  assert.equal(created.status,201)
  const url=`${records}/${created.body.recordId}/write-intent`, request={data:{title:'patched by intent'},rowVersion:1}
  const prepared=await call(alice,'POST',url,request)
  assert.equal(prepared.status,200)
  const write=await call(alice,'PATCH',`${records}/${created.body.recordId}`,request,prepared.body.idempotencyKey)
  assert.equal(write.status,200)
  assert.equal(write.body.rowVersion,2)
  const fresh=await makeSession(A.alice,A.company)
  const recovered=await call(fresh,'GET',url)
  assert.equal(recovered.body.state,'COMMITTED')
  assert.equal(recovered.body.result.rowVersion,2)
  assert.equal((await call(fresh,'POST',url+'/acknowledge',{},prepared.body.idempotencyKey)).body.state,'ACKNOWLEDGED')
  const foreign=await call(other,'GET',url)
  assert.ok([403,404].includes(foreign.status))
})

test('a different or omitted original key cannot bypass an active intent',async()=>{
  await settle()
  const request={data:{title:'cannot bypass active key'}}
  const prepared=await call(alice,'POST',intent,request), key=prepared.body.idempotencyKey
  assert.equal(prepared.status,200)
  const different=await call(alice,'POST',records,request,randomUUID())
  assert.equal(different.status,409)
  assert.equal(different.body.error,'KVVI_OPERATION_PENDING')
  const noPreparedKey=await handleApi({method:'POST',path:'/api/v1'+records,query:'',body:JSON.stringify(request),
    headers:{authorization:'Bearer '+alice.raw},
    loadSession:token=>handleAuth({method:'GET',path:'/auth/session',body:null,headers:{authorization:'Bearer '+token}})})
  assert.equal(noPreparedKey.status,409)
  assert.equal(await effects(request.data.title),0)
  assert.equal((await call(alice,'POST',records,request,key)).status,201)
  assert.equal(await effects(request.data.title),1)
  await settle()
})

test('prepare/cancel/ack audit-buffer storage failure rolls back the control state',async()=>{
  for(const action of ['prepare','cancel','acknowledge']) {
    await settle()
    const request={data:{title:`control rollback ${action}`}}
    let key
    if(action!=='prepare') {
      const prepared=await call(alice,'POST',intent,request);assert.equal(prepared.status,200);key=prepared.body.idempotencyKey
      if(action==='acknowledge') assert.equal((await call(alice,'POST',records,request,key)).status,201)
    }
    await adminQuery('kvvi_business',`CREATE FUNCTION injected_control_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.audit_payload->>'action'=TG_ARGV[0] THEN RAISE EXCEPTION 'injected-control-storage'; END IF; RETURN NEW; END $$`)
    await adminQuery('kvvi_business',`CREATE TRIGGER injected_control_failure BEFORE INSERT ON record_write_operations
      FOR EACH ROW EXECUTE FUNCTION injected_control_failure('record.write.${action}')`)
    try {
      const failed=await call(alice,'POST',action==='prepare'?intent:intent+'/'+action,action==='prepare'?request:{},key)
      assert.equal(failed.status,500)
      const current=await call(alice,'GET',intent)
      assert.equal(current.body.state,action==='prepare'?'EMPTY':action==='cancel'?'PREPARED':'COMMITTED')
      assert.equal(await effects(request.data.title),action==='acknowledge'?1:0)
    } finally {
      await adminQuery('kvvi_business','DROP TRIGGER injected_control_failure ON record_write_operations')
      await adminQuery('kvvi_business','DROP FUNCTION injected_control_failure()')
    }
    await settle()
  }
})

test('intent COMMITTED storage failure rolls back record, receipt and sequence together',async()=>{
  await settle()
  const request={data:{title:'committed marker rollback'}}, prepared=await call(alice,'POST',intent,request), key=prepared.body.idempotencyKey
  assert.equal(prepared.status,200)
  const sequence=async()=>(await adminQuery('kvvi_business','SELECT coalesce(sum(next_value),0)::text n FROM sequences')).rows[0].n
  const before=await sequence()
  await adminQuery('kvvi_business',`CREATE FUNCTION injected_committed_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='COMMITTED' THEN RAISE EXCEPTION 'injected-intent-marker'; END IF; RETURN NEW; END $$`)
  await adminQuery('kvvi_business',`CREATE TRIGGER injected_committed_failure BEFORE UPDATE ON record_write_intents
    FOR EACH ROW EXECUTE FUNCTION injected_committed_failure()`)
  try {
    assert.equal((await call(alice,'POST',records,request,key)).status,500)
    assert.equal(await effects(request.data.title),0)
    assert.equal(await sequence(),before)
    assert.equal((await call(alice,'GET',intent)).body.state,'PREPARED')
    assert.equal((await adminQuery('kvvi_business','SELECT count(*)::int n FROM record_write_operations WHERE endpoint=$1 AND idempotency_key=$2',['POST /systems/general_item/records',key])).rows[0].n,0)
  } finally {
    await adminQuery('kvvi_business','DROP TRIGGER injected_committed_failure ON record_write_intents')
    await adminQuery('kvvi_business','DROP FUNCTION injected_committed_failure()')
  }
  assert.equal((await call(alice,'POST',records,request,key)).status,201)
  assert.equal(await effects(request.data.title),1)
  await settle()
})

test('prepare COMMIT succeeded but reply was lost: relogin recovers the same reserved key',async()=>{
  await settle()
  const business=pool('business'), originalConnect=business.connect
  let lost=false
  business.connect=function(callback) {
    if(callback) return originalConnect.call(this,callback)
    return originalConnect.call(this).then(client=>{
      const query=client.query,release=client.release;let inserted=false
      client.query=async function(...args) {
        const text=typeof args[0]==='string'?args[0]:args[0].text
        const value=await query.apply(this,args)
        if(text.includes('INSERT INTO record_write_intents')) inserted=true
        if(text==='COMMIT'&&inserted&&!lost) {lost=true;throw new Error('injected-lost-commit-reply')}
        return value
      }
      client.release=function(...args) {client.query=query;client.release=release;return release.apply(this,args)}
      return client
    })
  }
  let unknown
  try {unknown=await call(alice,'POST',intent,{data:{title:'prepared before lost reply'}})}
  finally {business.connect=originalConnect}
  assert.equal(lost,true)
  assert.equal(unknown.status,503)
  assert.equal(unknown.body.error,'KVVI_OPERATION_OUTCOME_UNKNOWN')
  assert.equal(typeof unknown.body.idempotencyKey,'string')
  const fresh=await makeSession(A.alice,A.company)
  const active=await call(fresh,'GET',intent)
  assert.equal(active.body.state,'PREPARED')
  assert.equal(active.body.idempotencyKey,unknown.body.idempotencyKey)
  assert.equal(await effects('prepared before lost reply'),0)
  await settle()
})

test('unsupported intent aliases cannot bypass record identifier validation',async()=>{
  for(const suffix of ['get','prepare','made-up']) {
    const result=await call(alice,'POST',records+'/not-a-record/write-intent/'+suffix,{data:{title:'no effect'},rowVersion:1})
    assert.equal(result.status,400)
    assert.equal(result.body.error,'KVVI_BAD_REQUEST')
  }
  assert.equal(await effects('no effect'),0)
})

test('audit outage retains control changes and retries each control audit once',async()=>{
  await settle()
  const legacy='audit_append(uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)'
  const once='audit_append_once(uuid,uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)'
  let key
  for(const fn of [legacy,once]) await adminQuery('kvvi_audit',`REVOKE EXECUTE ON FUNCTION ${fn} FROM kvvi_audit_writer`)
  try {
    const prepared=await call(alice,'POST',intent,{data:{title:'control audit pending'}})
    assert.equal(prepared.status,200);key=prepared.body.idempotencyKey
    assert.equal(prepared.body.intentAuditPending,true)
    const canceled=await call(alice,'POST',intent+'/cancel',{},key)
    assert.equal(canceled.body.state,'CANCELED')
    assert.equal(canceled.body.intentAuditPending,true)
    assert.equal((await call(alice,'GET',intent)).body.state,'EMPTY')
    assert.equal(await effects('control audit pending'),0)
  } finally {
    for(const fn of [legacy,once]) await adminQuery('kvvi_audit',`GRANT EXECUTE ON FUNCTION ${fn} TO kvvi_audit_writer`)
  }
  const {flushWriteAudit}=await import('../src/record-write-operations.mjs')
  await adminQuery('kvvi_business',"UPDATE record_write_operations SET audit_next_attempt_at=now() WHERE audit_payload->>'resourceId'=$1",[key])
  await flushWriteAudit()
  assert.equal((await adminQuery('kvvi_audit',"SELECT count(*)::int n FROM audit_entries WHERE resource_id=$1 AND action IN ('record.write.prepare','record.write.cancel')",[key])).rows[0].n,2)
  await call(alice,'POST',intent+'/cancel',{},key)
  await flushWriteAudit()
  assert.equal((await adminQuery('kvvi_audit',"SELECT count(*)::int n FROM audit_entries WHERE resource_id=$1 AND action IN ('record.write.prepare','record.write.cancel')",[key])).rows[0].n,2)
})

test('a server-issued key cannot become a new write for another account or endpoint',async()=>{
  await settle()
  const record=await call(alice,'POST',records,{data:{title:'endpoint binding target'}})
  assert.equal(record.status,201)
  const request={data:{title:'owner-bound prepared key'}}, prepared=await call(alice,'POST',intent,request), key=prepared.body.idempotencyKey
  assert.equal(prepared.status,200)
  const crossAccount=await call(bob,'POST',records,request,key)
  assert.ok([403,409].includes(crossAccount.status))
  assert.equal(await effects(request.data.title),0)
  const crossEndpoint=await call(alice,'PATCH',`${records}/${record.body.recordId}`,{data:{title:'wrong endpoint'},rowVersion:1},key)
  assert.equal(crossEndpoint.status,409)
  assert.equal(await effects('wrong endpoint'),0)
  const builder=await makeSession(A.alice,A.company,'BUILDER')
  assert.equal((await call(builder,'GET',intent)).status,403)
  assert.ok([403,409].includes((await call(builder,'POST',records,request,key)).status))
  assert.equal(await effects(request.data.title),0)
  await settle()
})

test('a fabricated server-intent key requires a real intent row',async()=>{
  await settle()
  const key=`kvvi-intent.v1.${A.company}.${A.alice}.USER.${randomUUID()}`
  const refused=await call(alice,'POST',records,{data:{title:'fabricated key'}},key)
  assert.equal(refused.status,409)
  assert.equal(refused.body.error,'KVVI_OPERATION_INTENT_NOT_FOUND')
  assert.equal(await effects('fabricated key'),0)
})

test('ack cannot abandon a prepared intent; cancel after commit returns the original result',async()=>{
  await settle()
  const request={data:{title:'ack only known result'}}, prepared=await call(alice,'POST',intent,request), key=prepared.body.idempotencyKey
  const early=await call(alice,'POST',intent+'/acknowledge',{},key)
  assert.equal(early.status,409)
  assert.equal(early.body.error,'KVVI_OPERATION_NOT_COMMITTED')
  assert.equal((await call(alice,'GET',intent)).body.state,'PREPARED')
  const written=await call(alice,'POST',records,request,key)
  assert.equal(written.status,201)
  const cancel=await call(alice,'POST',intent+'/cancel',{},key)
  assert.equal(cancel.body.state,'COMMITTED')
  assert.equal(cancel.body.result.recordId,written.body.recordId)
  assert.equal(await effects(request.data.title),1)
  await settle()
})

test('cancel key-lock timeout preserves the prepared intent and original key',async()=>{
  await settle()
  const request={data:{title:'cancel lock timeout'}}, prepared=await call(alice,'POST',intent,request), key=prepared.body.idempotencyKey
  const blocker=await pool('business').connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['record-write',A.company,A.alice,'POST /systems/general_item/records',key])])
    const canceled=await call(alice,'POST',intent+'/cancel',{},key)
    assert.equal(canceled.status,503)
    assert.equal(canceled.body.error,'KVVI_OPERATION_OUTCOME_UNKNOWN')
    assert.equal(canceled.body.idempotencyKey,key)
  } finally {await blocker.query('ROLLBACK');blocker.release()}
  const active=await call(alice,'GET',intent)
  assert.equal(active.body.state,'PREPARED')
  assert.equal(active.body.idempotencyKey,key)
  assert.equal(await effects(request.data.title),0)
  assert.equal((await call(alice,'POST',records,request,key)).status,201)
  assert.equal(await effects(request.data.title),1)
  await settle()
})

test('prepare/get lock timeout never labels an unbound caller header as the original key',async()=>{
  await settle()
  const blocker=await pool('business').connect()
  try {
    await blocker.query('BEGIN')
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['record-write-intent',A.company,A.alice,'POST /systems/general_item/records'])])
    const results=await Promise.all([
      call(alice,'GET',intent,undefined,'unbound-caller-key'),
      call(alice,'POST',intent,{data:{title:'unbound timeout'}},'unbound-caller-key'),
    ])
    for(const result of results) {
      assert.equal(result.status,503)
      assert.equal(result.body.error,'KVVI_OPERATION_OUTCOME_UNKNOWN')
      assert.equal(result.body.idempotencyKey,undefined)
    }
  } finally {await blocker.query('ROLLBACK');blocker.release()}
  assert.equal((await call(alice,'GET',intent)).body.state,'EMPTY')
  assert.equal(await effects('unbound timeout'),0)
})

test('revoked field access hides original results but permits sealing or acknowledging own intent metadata',async()=>{
  for(const committed of [false,true]) {
    await settle()
    const request={data:{title:`revoked intent ${committed}`}}, prepared=await call(alice,'POST',intent,request), key=prepared.body.idempotencyKey
    assert.equal(prepared.status,200)
    if(committed) assert.equal((await call(alice,'POST',records,request,key)).status,201)
    const role=(await pool('platform').query('SELECT role_id FROM role_members WHERE company_id=$1 AND user_id=$2 LIMIT 1',[A.company,A.alice])).rows[0].role_id
    const policy=randomUUID()
    await pool('platform').query(`INSERT INTO policies(policy_id,company_id,role_id,dimension,resource_code,field_visibility)
      VALUES($1,$2,$3,'FIELD','title','HIDDEN')`,[policy,A.company,role])
    try {
      const current=await call(alice,'GET',intent)
      assert.equal(current.status,200)
      assert.equal(current.body.state,committed?'COMMITTED':'PREPARED')
      assert.equal(current.body.resultRestricted,true)
      assert.equal(current.body.result,undefined)
      assert.equal(current.body.fields,undefined)
      const canceled=await call(alice,'POST',intent+'/cancel',{},key)
      assert.equal(canceled.status,200)
      assert.equal(canceled.body.state,committed?'COMMITTED':'CANCELED')
      assert.equal(canceled.body.result,undefined)
      if(committed) assert.equal((await call(alice,'POST',intent+'/acknowledge',{},key)).body.state,'ACKNOWLEDGED')
      assert.equal((await call(alice,'GET',intent)).body.state,'EMPTY')
      assert.equal(await effects(request.data.title),committed?1:0)
    } finally {
      await pool('platform').query('DELETE FROM policies WHERE policy_id=$1',[policy])
      await settle()
    }
  }
})

test('transferred record intent can be acknowledged without exposing the now-inaccessible result',async()=>{
  await settle()
  const request={data:{title:'transfer intent result'}}, created=await call(alice,'POST',records,request)
  assert.equal(created.status,201)
  const url=`${records}/${created.body.recordId}/write-intent`, patch={data:{title:'changed before transfer'},rowVersion:1}
  const prepared=await call(alice,'POST',url,patch), key=prepared.body.idempotencyKey
  assert.equal((await call(alice,'PATCH',`${records}/${created.body.recordId}`,patch,key)).status,200)
  await adminQuery('kvvi_business','UPDATE business_records SET owner_id=$1,dept_id=NULL,shop_id=NULL WHERE record_id=$2',[A.bob,created.body.recordId])
  const active=await call(alice,'GET',url)
  assert.equal(active.status,200)
  assert.equal(active.body.state,'COMMITTED')
  assert.equal(active.body.resultRestricted,true)
  assert.equal(active.body.result,undefined)
  assert.equal((await call(alice,'POST',url+'/acknowledge',{},key)).body.state,'ACKNOWLEDGED')
  assert.equal((await call(alice,'GET',url+'/acknowledge',undefined,key)).status,400)
  assert.equal((await call(alice,'GET',url)).status,404)
})

test('field revocation plus audit outage still seals own metadata through the durable control outbox',async()=>{
  await settle()
  const prepared=await call(alice,'POST',intent,{data:{title:'revoked offline audit'}}), key=prepared.body.idempotencyKey
  assert.equal(prepared.status,200)
  const role=(await pool('platform').query('SELECT role_id FROM role_members WHERE company_id=$1 AND user_id=$2 LIMIT 1',[A.company,A.alice])).rows[0].role_id
  const policy=randomUUID(), legacy='audit_append(uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)',
    once='audit_append_once(uuid,uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)'
  await pool('platform').query(`INSERT INTO policies(policy_id,company_id,role_id,dimension,resource_code,field_visibility)
    VALUES($1,$2,$3,'FIELD','title','HIDDEN')`,[policy,A.company,role])
  for(const fn of [legacy,once]) await adminQuery('kvvi_audit',`REVOKE EXECUTE ON FUNCTION ${fn} FROM kvvi_audit_writer`)
  try {
    const active=await call(alice,'GET',intent)
    assert.equal(active.status,200)
    assert.equal(active.body.resultRestricted,true)
    const cancel=await call(alice,'POST',intent+'/cancel',{},key)
    assert.equal(cancel.status,200)
    assert.equal(cancel.body.state,'CANCELED')
    assert.equal(cancel.body.intentAuditPending,true)
    assert.equal(await effects('revoked offline audit'),0)
  } finally {
    for(const fn of [legacy,once]) await adminQuery('kvvi_audit',`GRANT EXECUTE ON FUNCTION ${fn} TO kvvi_audit_writer`)
    await pool('platform').query('DELETE FROM policies WHERE policy_id=$1',[policy])
    await settle()
  }
})

test('actual client intent SDK traverses authenticated APIs and real PG without replay on recovery',async()=>{
  await settle()
  const sdk=await import('../../../forks/dsh/变更/packages/client/kvvi-panel/src/client/api.ts')
  const originalFetch=globalThis.fetch, calls=[]
  let session=alice, dropWriteReply=true
  globalThis.fetch=async(url,init={})=>{
    const parsed=new URL(url,'http://test'), headers=new Headers(init.headers)
    calls.push([init.method,parsed.pathname,headers.get('idempotency-key')])
    const response=await handleApi({method:init.method,path:parsed.pathname,query:parsed.search,body:init.body??null,
      headers:{authorization:'Bearer '+session.raw,...Object.fromEntries(headers.entries())},
      loadSession:token=>handleAuth({method:'GET',path:'/auth/session',body:null,headers:{authorization:'Bearer '+token}})})
    if(dropWriteReply && init.method==='POST'&&parsed.pathname.endsWith('/records')&&response.status===201) {
      dropWriteReply=false
      throw new Error('injected-lost-client-response-after-business-commit')
    }
    return Response.json(response.body,{status:response.status})
  }
  try {
    const target={assetId:'general_item'}, input={data:{title:'actual intent SDK'}}
    assert.deepEqual(await sdk.getRecordWriteIntent(target),{ok:true,value:{state:'EMPTY'}})
    const prepared=await sdk.prepareRecordWriteIntent(target,input)
    assert.equal(prepared.ok,true)
    assert.equal(prepared.value.state,'PREPARED')
    const key=prepared.value.idempotencyKey
    const created=await sdk.createRecord(target.assetId,input.data,key)
    assert.equal(created.ok,false)
    assert.equal(created.code,'KVVI_UNREACHABLE')
    session=await makeSession(A.alice,A.company)
    const recovered=await sdk.getRecordWriteIntent(target)
    assert.equal(recovered.ok,true)
    assert.equal(recovered.value.state,'COMMITTED')
    assert.equal(recovered.value.idempotencyKey,key)
    assert.equal(typeof recovered.value.result.recordId,'string')
    assert.equal(await effects(input.data.title),1)
    assert.equal((await sdk.acknowledgeRecordWriteIntent(target,key)).value.state,'ACKNOWLEDGED')
    assert.equal((await sdk.getRecordWriteIntent(target)).value.state,'EMPTY')
    const next=await sdk.prepareRecordWriteIntent(target,{data:{title:'SDK cancel without effect'}})
    assert.equal((await sdk.cancelRecordWriteIntent(target,next.value.idempotencyKey)).value.state,'CANCELED')
    assert.equal(await effects('SDK cancel without effect'),0)
    assert.equal(calls.filter(([method,path])=>method==='POST'&&path.endsWith('/records')).length,1)
    const patchTarget={assetId:'general_item',recordId:recovered.value.result.recordId}
    const patch=await sdk.prepareRecordWriteIntent(patchTarget,{data:{title:'SDK PATCH'},rowVersion:1})
    assert.equal(patch.ok,true)
    const update=await sdk.updateRecord(patchTarget.assetId,patchTarget.recordId,{title:'SDK PATCH'},1,patch.value.idempotencyKey)
    assert.equal(update.ok,true)
    assert.equal(update.value.rowVersion,2)
    assert.equal((await sdk.getRecordWriteIntent(patchTarget)).value.result.rowVersion,2)
    assert.equal((await sdk.acknowledgeRecordWriteIntent(patchTarget,patch.value.idempotencyKey)).value.state,'ACKNOWLEDGED')
  } finally {globalThis.fetch=originalFetch}
})

test('actual client controller recovers a committed lost response after relogin and blocks a late cross-account write',async()=>{
  await settle()
  const {createRecordWriteController}=await import('../../../forks/dsh/变更/packages/client/kvvi-panel/src/client/record-write.ts')
  const originalFetch=globalThis.fetch
  let session=alice, loseReply=true, pausePrepare=false, preparedKey, releasePrepare, notifyPrepared
  const prepareGate=new Promise(resolve=>{releasePrepare=resolve}), prepared=new Promise(resolve=>{notifyPrepared=resolve})
  globalThis.fetch=async(url,init={})=>{
    if(url==='/auth/session') {
      const auth=await handleAuth({method:'GET',path:url,body:null,headers:{authorization:'Bearer '+session.raw}})
      return Response.json(auth.body,{status:auth.status})
    }
    const parsed=new URL(url,'http://test'), headers=new Headers(init.headers)
    const response=await handleApi({method:init.method,path:parsed.pathname,query:parsed.search,body:init.body??null,
      headers:{authorization:'Bearer '+session.raw,...Object.fromEntries(headers.entries())},
      loadSession:token=>handleAuth({method:'GET',path:'/auth/session',body:null,headers:{authorization:'Bearer '+token}})})
    if(pausePrepare&&init.method==='POST'&&parsed.pathname.endsWith('/write-intent')&&response.status===200) {
      preparedKey=response.body.idempotencyKey;notifyPrepared();await prepareGate
    }
    if(loseReply&&init.method==='POST'&&parsed.pathname.endsWith('/records')&&response.status===201) {
      loseReply=false;throw new Error('injected-controller-lost-reply-after-commit')
    }
    return Response.json(response.body,{status:response.status})
  }
  const old=createRecordWriteController({assetId:'general_item'}),controllers=[old]
  try {
    await old.refresh();assert.equal(old.getSnapshot().phase,'ready')
    assert.equal(await old.submit({data:{title:'controller committed lost reply'}}),undefined)
    assert.equal(old.getSnapshot().phase,'pending')
    assert.equal(await effects('controller committed lost reply'),1)
    session=await makeSession(A.alice,A.company)
    await old.refresh()
    assert.equal(old.getSnapshot().phase,'blocked')
    const fresh=createRecordWriteController({assetId:'general_item'});controllers.push(fresh)
    await fresh.refresh()
    assert.equal(fresh.getSnapshot().phase,'committed')
    assert.equal(await fresh.acknowledge(),true)
    assert.equal(fresh.getSnapshot().phase,'settled')
    await fresh.refresh();assert.equal(fresh.getSnapshot().phase,'ready')
    pausePrepare=true
    const submitting=fresh.submit({data:{title:'controller must not cross account'}})
    await prepared;session=bob;releasePrepare();await submitting
    assert.equal(fresh.getSnapshot().phase,'blocked')
    assert.equal(fresh.getSnapshot().error.code,'KVVI_WRITE_IDENTITY_CHANGED')
    assert.equal(await effects('controller must not cross account'),0)
    assert.equal((await call(bob,'GET',intent)).body.state,'EMPTY')
    const original=await call(alice,'GET',intent)
    assert.equal(original.body.state,'PREPARED')
    assert.equal(original.body.idempotencyKey,preparedKey)
    assert.equal((await call(alice,'POST',intent+'/cancel',{},preparedKey)).body.state,'CANCELED')
  } finally {releasePrepare();for(const c of controllers)c.dispose();globalThis.fetch=originalFetch}
})

test('real HTTP response hang after PG commit times out as unknown and recovers without another write',{timeout:15000},async()=>{
  await settle()
  const {createServer}=await import('node:http')
  const {createRecordWriteController}=await import('../../../forks/dsh/变更/packages/client/kvvi-panel/src/client/record-write.ts')
  const originalFetch=globalThis.fetch
  let releaseReply
  const lateReply=new Promise(resolve=>{releaseReply=resolve})
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://test'),chunks=[]
      for await(const chunk of req)chunks.push(chunk)
      const input={method:req.method,path:url.pathname,query:url.search,body:Buffer.concat(chunks).toString()||null,headers:req.headers}
      const result=url.pathname==='/auth/session'?await handleAuth(input):await handleApi({...input,
        loadSession:token=>handleAuth({method:'GET',path:'/auth/session',body:null,headers:{authorization:'Bearer '+token}})})
      if(req.method==='POST'&&url.pathname.endsWith('/records')&&result.status===201) await lateReply
      if(!res.destroyed) {res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.body))}
    } catch {if(!res.destroyed){res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"KVVI_TEST_HTTP_FAILURE"}')}}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  globalThis.fetch=(url,init={})=>originalFetch(origin+url,{...init,headers:{...Object.fromEntries(new Headers(init.headers).entries()),authorization:'Bearer '+alice.raw}})
  const c=createRecordWriteController({assetId:'general_item'},{requestTimeoutMs:600})
  try {
    await c.refresh();assert.equal(c.getSnapshot().phase,'ready')
    assert.equal(await c.submit({data:{title:'HTTP committed with hung reply'}}),undefined)
    assert.equal(c.getSnapshot().phase,'pending')
    assert.equal(c.getSnapshot().error.code,'KVVI_OPERATION_OUTCOME_UNKNOWN')
    assert.equal(typeof c.getSnapshot().error.idempotencyKey,'string')
    assert.equal(await effects('HTTP committed with hung reply'),1)
    await c.refresh();assert.equal(c.getSnapshot().phase,'committed')
    assert.equal(await c.acknowledge(),true)
    await c.refresh();assert.equal(c.getSnapshot().phase,'ready')
    releaseReply();await new Promise(resolve=>setImmediate(resolve))
    assert.equal(c.getSnapshot().phase,'ready')
    assert.equal(await effects('HTTP committed with hung reply'),1)
  } finally {
    c.dispose();releaseReply();globalThis.fetch=originalFetch
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
  }
})

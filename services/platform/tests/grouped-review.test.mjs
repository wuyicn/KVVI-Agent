import {test,beforeEach,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {directoryFixture,api} from './directory-fixture.mjs'
import {A,pool,closeAll,adminQuery} from './harness.mjs'
import {dsns} from '../src/db.mjs'
import {mutateDirectory} from '../src/business-directory.mjs'
import {createBuildIntent,attachBuildIntent,flushBuildIntents} from '../src/business-build-intents.mjs'
import {submitDraft,approveDraft,publishDraft,DIFF_FACES} from '../src/publish.mjs'
let f
beforeEach(async()=>{f=await directoryFixture()})
after(closeAll)
test('create-only directory entry provides fields and submission but never record reads',async()=>{
  const d=await submitDraft({ctx:f.builder.ctx,change:{assetId:'general_item',newFields:true},diffReport:{faces:DIFF_FACES}})
  await approveDraft({ctx:f.owner.ctx,draftId:d.draftId,decision:'APPROVE'})
  await publishDraft({ctx:f.owner.ctx,draftId:d.draftId,apply:async()=>({}),system:{assetId:'general_item',schemaCode:'general_item',name:'general_item'},contracts:[{contractType:'business-schema',assetId:'general_item',content:{fields:[{field_code:'title',type:'short_text',write_policy:'MUTABLE'}]}}]})
  assert.deepEqual((await api(f.employee,'GET','/business-directory')).body.forms[0].actions,['create'])
  assert.equal((await api(f.employee,'GET','/systems/general_item/fields')).status,200)
  const made=await api(f.employee,'POST','/systems/general_item/records',{data:{title:'create only'}})
  assert.equal(made.status,201)
  assert.equal((await api(f.employee,'GET','/systems/general_item/records')).status,403)
  assert.equal((await api(f.employee,'GET',`/systems/general_item/records/${made.body.recordId}`)).status,403)
})
test('public operation ID reuse cannot impersonate a publish-placement receipt',async()=>{
  const id=randomUUID(),g=(await api(f.builder,'POST','/business-groups',{name:'same id'},id)).body.result
  const i=await createBuildIntent(f.builder.ctx,{groupId:g.groupId,operationId:id})
  const d=await submitDraft({ctx:f.builder.ctx,change:{assetId:'collision'},diffReport:{faces:DIFF_FACES},payload:{assetId:'collision'}})
  await attachBuildIntent(f.builder.ctx,{intentId:i.intentId,draftId:d.draftId,expectedVersion:1})
  await approveDraft({ctx:f.owner.ctx,draftId:d.draftId,decision:'APPROVE'})
  await publishDraft({ctx:f.owner.ctx,draftId:d.draftId,apply:async()=>({}),system:{assetId:'collision',schemaCode:'collision',name:'collision'}})
  await flushBuildIntents()
  const result=(await api(f.builder,'GET',`/business-build-intents/${i.intentId}`)).body
  assert.equal(result.state,'DONE');assert.equal(result.result.assetId,'collision')
  assert.equal((await api(f.builder,'GET','/business-directory')).body.forms.find(x=>x.assetId==='collision').groupId,g.groupId)
})
async function until(predicate) {
  const deadline=Date.now()+5000
  while(!await predicate()) {
    if(Date.now()>deadline) throw new Error('barrier was not reached')
    await new Promise(r=>setTimeout(r,10))
  }
}
test('saturated directory mutations and intent creation cannot deadlock the two pools',async()=>{
  const g=(await api(f.builder,'POST','/business-groups',{name:'target'})).body.result
  const url=new URL(dsns().admin);url.pathname='/kvvi_business'
  const blocker=new pg.Client({connectionString:url.href});await blocker.connect()
  const lock='directory:'+A.company,work=[]
  const expectedShutdown=()=>{}
  pool('platform').on('error',expectedShutdown);pool('business').on('error',expectedShutdown)
  let timedOut=false,timer
  try {
    await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[lock])
    for(let n=0;n<8;n++) work.push(mutateDirectory(f.builder.ctx,{operationId:randomUUID(),action:'group.create',payload:{name:'parallel'+n}}))
    // Observe the actual database barrier, not a timing-based assumption about scheduling.
    await until(async()=>Number((await adminQuery('kvvi_business',"SELECT count(*) AS n FROM pg_stat_activity WHERE datname='kvvi_business' AND usename='kvvi_business' AND wait_event='advisory'")).rows[0].n)===8)
    for(let n=0;n<8;n++) work.push(createBuildIntent(f.builder.ctx,{groupId:g.groupId,operationId:randomUUID()}))
    await until(()=>pool('business').waitingCount>=8)
    await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock])
    await Promise.race([Promise.allSettled(work),new Promise(r=>{timer=setTimeout(()=>{timedOut=true;r()},3000)})])
  } finally {
    clearTimeout(timer)
    await blocker.query('SELECT pg_advisory_unlock_all()');await blocker.end()
    if(timedOut) await adminQuery('kvvi_business',"SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE usename='kvvi_business' AND wait_event='advisory' AND pid<>pg_backend_pid()")
    await Promise.allSettled(work)
  }
  assert.equal(timedOut,false,'cross-pool wait cycle left all operations pending')
  assert.ok((await Promise.allSettled(work)).every(x=>x.status==='fulfilled'))
})

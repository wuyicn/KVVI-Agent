import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { A, RECORDS, grantBaseline, closeAll, adminQuery } from './harness.mjs'
import { directoryFixture, api } from './directory-fixture.mjs'
import { scopeContext } from '../src/authorization.mjs'
import { readRecord, listRecords, createRecord, updateRecord } from '../src/refs.mjs'
import { execute } from '../src/commands.mjs'
import { pool } from '../src/db.mjs'
import { lockFormLifecycle } from '../src/business-lifecycle.mjs'
import { step } from '../src/workflow.mjs'
import { runtimeProjection } from '../src/runtime-projection.mjs'
import { handleApi } from '../src/api-router.mjs'
import { runtimeContextHeaders } from '../src/runtime-auth.mjs'
import { offboard } from '../src/lifecycle.mjs'
let f,scope
beforeEach(async()=>{f=await directoryFixture();await grantBaseline(A.bob);scope=await scopeContext(f.builder.ctx)})
after(closeAll)
test('archiving blocks real references, generic commands and HTTP paths; restore retains records',async()=>{
  const before=(await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows
  const archive=await api(f.builder,'POST','/business-forms/general_item/archive',{expectedVersion:0,confirmed:true})
  assert.equal(archive.status,200)
  const calls=[
    ()=>readRecord(f.builder.ctx,scope,{id:RECORDS.bobOwn}),
    ()=>listRecords(scope,'general_item'),
    ()=>createRecord(f.builder.ctx,scope,{schemaCode:'general_item',data:{title:'must not write'}}),
    ()=>updateRecord(f.builder.ctx,scope,{id:RECORDS.bobOwn},{data:{title:'must not write'},rowVersion:1}),
    ()=>execute({ctx:f.builder.ctx,scope,request:{action:'record.update',targets:[{id:RECORDS.bobOwn}],patch:{data:{title:'must not write'}}}}),
  ]
  for(const call of calls) await assert.rejects(call,/KVVI_FORM_ARCHIVED/)
  // S1 修复后：schema 不匹配的引用按「找不到」（null）处理，不触发该记录真实
  // schema 的归档闸 —— 否则等于把「这条记录存在且其表单已归档」泄露给错误
  // schema 的调用方（而这正是 S1 要堵的越权读口）。
  assert.equal(await readRecord(f.builder.ctx,scope,{id:RECORDS.bobOwn,schemaCode:'hidden_item'}), null)
  await assert.rejects(()=>step({ctx:f.builder.ctx,spec:{states:[],actions:[]},assetId:'general_item',recordId:RECORDS.bobOwn,from:'draft',action:'submit',applyTransition:()=>assert.fail('archive must prevent callback')}),/KVVI_FORM_ARCHIVED/)
  await assert.rejects(()=>runtimeProjection(A.company,'general_item'),/KVVI_FORM_ARCHIVED/)
  for(const suffix of ['runtime','fields','records','records/'+RECORDS.bobOwn,'records/GI2026000002']) {
    const r=await api(f.builder,'GET','/systems/general_item/'+suffix)
    assert.equal(r.status,409);assert.equal(r.body.error,'KVVI_FORM_ARCHIVED')
  }
  process.env.KVVI_INTERNAL_TOKEN='directory-lifecycle-test-only'
  const agent=await handleApi({method:'GET',path:'/api/v1/systems/general_item/records',query:'',body:null,headers:runtimeContextHeaders(f.builder.ctx),loadSession:()=>assert.fail('signed runtime uses verified session')})
  assert.equal(agent.status,409); assert.equal(agent.body.error,'KVVI_FORM_ARCHIVED')
  const systems=await api(f.builder,'GET','/systems')
  assert.equal(systems.body.items.some(s=>s.assetId==='general_item'),false)
  assert.deepEqual((await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows,before)
  assert.equal((await api(f.builder,'POST','/business-forms/general_item/restore',{expectedVersion:1,confirmed:true})).status,200)
  assert.equal((await readRecord(f.builder.ctx,scope,{id:RECORDS.bobOwn})).recordId,RECORDS.bobOwn)
  assert.deepEqual((await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows,before)
})
test('lifecycle metadata failure refuses reads and writes, without changing records',async()=>{
  const before=(await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows
  await adminQuery('kvvi_business','ALTER TABLE business_form_directory RENAME TO directory_unavailable')
  try {
    await assert.rejects(()=>readRecord(f.builder.ctx,scope,{id:RECORDS.bobOwn}),{code:'42P01'})
    await assert.rejects(()=>createRecord(f.builder.ctx,scope,{schemaCode:'general_item',data:{title:'no'}}),{code:'42P01'})
  } finally {await adminQuery('kvvi_business','ALTER TABLE directory_unavailable RENAME TO business_form_directory')}
  assert.deepEqual((await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows,before)
})
test('administrative offboarding leaves archived records unchanged and reports the skip',async()=>{
  await api(f.builder,'POST','/business-forms/general_item/archive',{expectedVersion:0,confirmed:true})
  const before=(await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows
  const result=await offboard({actor:f.owner.ctx,userId:A.bob,successorUserId:A.carol,records:[{recordId:RECORDS.bobOwn,state:'draft'}]})
  assert.deepEqual((await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows,before)
  assert.equal(result.skipped[0].reason,'KVVI_FORM_ARCHIVED')
})
async function waitBlockedBy(pid) {
  const until=Date.now()+5000
  while(Date.now()<until) {
    const r=await adminQuery('kvvi_business','SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',[pid])
    if(r.rows.length) return
  }
  assert.fail('expected an actual PostgreSQL lock wait')
}
test('archive waits for existing writer, then queued writer rechecks committed archive',async()=>{
  const c=await pool('business').connect()
  let pending
  try {
    await c.query('BEGIN')
    await c.query("SELECT set_config('kvvi.company_id',$1,true)",[A.company])
    await lockFormLifecycle(c,A.company,'general_item','write')
    const pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid
    const dir=await api(f.builder,'GET','/business-directory')
    const version=dir.body.forms.find(x=>x.assetId==='general_item').version
    pending=api(f.builder,'POST','/business-forms/general_item/archive',{expectedVersion:version,confirmed:true})
    await waitBlockedBy(pid)
    await c.query('COMMIT')
    assert.equal((await pending).status,200)

    await c.query('BEGIN')
    await lockFormLifecycle(c,A.company,'general_item','archive')
    // Start actual writer behind an exclusive lifecycle lock, not a timed race.
    pending=createRecord(f.builder.ctx,scope,{schemaCode:'general_item',data:{title:'blocked'}})
    const refused=assert.rejects(pending,/KVVI_FORM_ARCHIVED/)
    await waitBlockedBy(pid)
    await c.query('COMMIT')
    await refused
  } finally { await c.query('ROLLBACK'); c.release(); await pending?.catch(()=>{}) }
})
test('legacy catalog does not expose unauthorized forms or contracts',async()=>{
  const out=await api(f.employee,'GET','/systems')
  assert.deepEqual(out.body.items.map(s=>s.assetId),['general_item'])
  assert.equal((await api(f.employee,'GET','/systems/hidden_item/runtime')).status,403)
})

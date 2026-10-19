import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { A, B, resetDatabase, grantBaseline, grantPlatformRole, makeSession, pool, closeAll, adminQuery } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { api } from './directory-fixture.mjs'
import { flushWriteAudit, deliverWriteAudit } from '../src/record-write-operations.mjs'

let alice, bob, other
const path = '/systems/general_item/records'
const legacy = 'audit_append(uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)'
const once = 'audit_append_once(uuid,uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)'
const call = async (...args) => api(...args).catch(error => ({ status: 500, body: { error: error.code } }))
const count = async title => (await adminQuery('kvvi_business',
  "SELECT count(*)::int n FROM business_records WHERE data->>'title'=$1", [title])).rows[0].n

before(async () => {
  await resetDatabase()
  for (const id of [A.alice, A.bob]) await grantBaseline(id)
  await grantPlatformRole(A.alice, 'owner')
  await grantPlatformRole(A.bob, 'owner')
  alice = await makeSession(A.alice, A.company)
  bob = await makeSession(A.bob, A.company)
  other = await makeSession(B.dave, B.company)
  const draft = await submitDraft({ ctx: alice.ctx, change: { assetId: 'general_item' },
    diffReport: { faces: DIFF_FACES }, invariant: { ok: true } })
  await approveDraft({ ctx: bob.ctx, draftId: draft.draftId, decision: 'APPROVE' })
  const specs = {
    'business-schema': { schema_code: 'general_item', fields: [
      {field_code:'title',type:'short_text'}, {field_code:'note',type:'long_text'},
      {field_code:'flag',type:'boolean'}, {field_code:'count',type:'integer'},
      {field_code:'ratio',type:'decimal',type_config:{precision:38,scale:12}},
      {field_code:'total',type:'money',type_config:{currency_mode:'FIXED',currency:'CNY'}},
      {field_code:'on_date',type:'date'}, {field_code:'at_time',type:'datetime'},
      {field_code:'choice',type:'single_select',type_config:{options:[{code:'a'},{code:'b'}]}},
      {field_code:'tags',type:'multi_select',type_config:{options:[{code:'a'},{code:'b'}]}},
      {field_code:'nullable_text',type:'short_text',nullable:true},
      {field_code:'nullable_count',type:'integer',nullable:true},
    ] },
    'view-schema': { componentsTree: [] },
    'workflow-spec': { states: [{ state_code: 'draft', initial: true }], transitions: [] },
    'permission-spec': { roles: [], policies: [] }, 'tool-spec': { tools: [] }, 'app-model-command': { commands: [] },
  }
  await publishDraft({ ctx: bob.ctx, draftId: draft.draftId, apply: async ({ diffDigest }) => ({ diffDigest }),
    system: { assetId: 'general_item', schemaCode: 'general_item', name: 'Recovery' },
    contracts: Object.entries(specs).map(([contractType, content]) => ({ contractType, content, assetId: 'general_item' })) })
})
after(closeAll)

test('ten declared types reach actual PG JSONB with native booleans/integers/arrays and exact decimals/money',async()=>{
  const data={title:'typed database',note:'long\ntext',flag:true,count:7,
    ratio:'12345678901234567890.123456789012',total:{amount:'9007199254740993.01',currency:'CNY'},
    on_date:'2024-02-29',at_time:'2026-10-19T12:30:00+08:00',choice:'a',tags:['a','b'],nullable_text:null}
  const created=await call(alice,'POST',path,{data})
  assert.equal(created.status,201)
  assert.deepEqual((await adminQuery('kvvi_business','SELECT data FROM business_records WHERE record_id=$1',[created.body.recordId])).rows[0].data,data)
  const changed={flag:false,count:0,tags:[],nullable_text:'',ratio:'0.000000000001',total:{amount:'0.01',currency:'CNY'}}
  const updated=await call(alice,'PATCH',`${path}/${created.body.recordId}`,{data:changed,rowVersion:1})
  assert.equal(updated.status,200)
  assert.deepEqual((await adminQuery('kvvi_business','SELECT data FROM business_records WHERE record_id=$1',[created.body.recordId])).rows[0].data,{...data,...changed})
  for(const invalid of [{flag:'false'},{count:'7'},{tags:'a,b'},{ratio:0.1},{total:'1.23'}]) {
    const refused=await call(alice,'PATCH',`${path}/${created.body.recordId}`,{data:invalid,rowVersion:2})
    assert.equal(refused.status,400)
    assert.equal(refused.body.error,'KVVI_FIELD_TYPE_INVALID')
  }
  assert.equal((await adminQuery('kvvi_business','SELECT row_version::int v FROM business_records WHERE record_id=$1',[created.body.recordId])).rows[0].v,2)
})

test('audit outage keeps one committed result; original key resumes after connection restart', async () => {
  const key = randomUUID()
  let first
  for (const fn of [legacy, once]) await adminQuery('kvvi_audit', `REVOKE EXECUTE ON FUNCTION ${fn} FROM kvvi_audit_writer`)
  try {
    first = await call(alice, 'POST', path, { data: { title: 'audit outage' } }, key)
    assert.equal(first.status, 201)
    assert.equal(first.body.auditPending, true)
    const retry = await call(alice, 'POST', path, { data: { title: 'audit outage' } }, key)
    assert.equal(retry.body.recordId, first.body.recordId)
    assert.equal(await count('audit outage'), 1)
  } finally {
    for (const fn of [legacy, once]) await adminQuery('kvvi_audit', `GRANT EXECUTE ON FUNCTION ${fn} TO kvvi_audit_writer`)
  }
  await closeAll()
  const newSession=await makeSession(A.alice,A.company)
  const recovered = await call(newSession, 'POST', path, { data: { title: 'audit outage' } }, key)
  assert.equal(recovered.body.recordId, first.body.recordId)
  assert.equal(recovered.body.auditPending, false)
  assert.equal(await count('audit outage'), 1)
  assert.equal((await adminQuery('kvvi_audit',
    "SELECT count(*)::int n FROM audit_entries WHERE action='record.create' AND resource_id=$1", [first.body.recordId])).rows[0].n, 1)
  assert.equal((await adminQuery('kvvi_audit', 'SELECT session_id FROM audit_entries WHERE resource_id=$1', [first.body.recordId])).rows[0].session_id,alice.ctx.sessionId)
})

test('concurrent same key creates exactly one record and returns the same response', async () => {
  const key = randomUUID()
  const all = await Promise.all(Array.from({ length: 12 }, () => call(alice, 'POST', path, { data: { title: 'concurrent receipt' } }, key)))
  for (const response of all) {
    assert.equal(response.status, 201)
    assert.equal(response.body.recordId, all[0].body.recordId)
  }
  assert.equal(await count('concurrent receipt'), 1)
})

test('key cannot change payload', async () => {
  const key = randomUUID()
  const first = await call(alice, 'POST', path, { data: { title: 'immutable receipt' } }, key)
  assert.equal(first.status, 201)
  const changed = await call(alice, 'POST', path, { data: { title: 'changed receipt' } }, key)
  assert.equal(changed.status, 409)
  assert.equal(changed.body.error, 'KVVI_OPERATION_KEY_CONFLICT')
  assert.equal(await count('changed receipt'), 0)
})

test('lost PATCH response resumes its committed version with the original key', async () => {
  const created = await call(alice, 'POST', path, { data: { title: 'before patch' } })
  const key = randomUUID(), recordPath = `${path}/${created.body.recordId}`
  const payload = { data: { title: 'after patch' }, rowVersion: 1 }
  const first = await call(alice, 'PATCH', recordPath, payload, key)
  assert.equal(first.status, 200)
  await closeAll()
  const retry = await call(alice, 'PATCH', `${path}/${created.body.recordId.toUpperCase()}`,
    {rowVersion:1,data:{title:'after patch'}}, key)
  assert.equal(retry.status, 200)
  assert.equal(retry.body.rowVersion, 2)
  assert.equal(retry.body.operationId, first.body.operationId)
  assert.equal((await adminQuery('kvvi_business', 'SELECT row_version::int v FROM business_records WHERE record_id=$1', [created.body.recordId])).rows[0].v, 2)
})

test('original key stays scoped to the account and current authorization', async () => {
  const key = randomUUID()
  const first = await call(alice, 'POST', path, { data: { title: 'account receipt' } }, key)
  const second = await call(bob, 'POST', path, { data: { title: 'account receipt' } }, key)
  assert.equal(first.status, 201); assert.equal(second.status, 201)
  assert.notEqual(first.body.recordId, second.body.recordId)
  const forbidden = await call(other, 'POST', path, { data: { title: 'account receipt' } }, key)
  assert.ok([403, 404].includes(forbidden.status))
  await pool('platform').query("UPDATE policies SET actions='{}' WHERE company_id=$1 AND dimension='FORM'", [A.company])
  try {
    const revoked = await call(alice, 'POST', path, { data: { title: 'account receipt' } }, key)
    assert.equal(revoked.status, 403)
    assert.equal(revoked.body.recordId, undefined)
  } finally {
    await pool('platform').query("UPDATE policies SET actions='{read,create,update}' WHERE company_id=$1 AND dimension='FORM'", [A.company])
  }
})

test('receipt storage failure rolls back the business row and its allocated sequence', async () => {
  const key=randomUUID()
  const before=(await adminQuery('kvvi_business','SELECT * FROM sequences ORDER BY company_id,schema_code,period_key')).rows
  await adminQuery('kvvi_business', `CREATE FUNCTION reject_write_receipt() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'injected write receipt failure'; END $$;
    CREATE TRIGGER reject_write_receipt BEFORE INSERT ON record_write_operations
      FOR EACH ROW EXECUTE FUNCTION reject_write_receipt()`)
  try {
    const failed=await call(alice,'POST',path,{data:{title:'rollback receipt'}},key)
    assert.equal(failed.status,500)
    assert.equal(await count('rollback receipt'),0)
    assert.deepEqual((await adminQuery('kvvi_business','SELECT * FROM sequences ORDER BY company_id,schema_code,period_key')).rows,before)
  } finally {
    await adminQuery('kvvi_business','DROP TRIGGER reject_write_receipt ON record_write_operations; DROP FUNCTION reject_write_receipt()')
  }
  assert.equal((await call(alice,'POST',path,{data:{title:'rollback receipt'}},key)).status,201)
})

test('audit commit followed by delivery-marker failure safely retries without another audit', async () => {
  const key=randomUUID()
  let first
  await adminQuery('kvvi_business', `CREATE FUNCTION reject_delivery_marker() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'injected delivery marker failure'; END $$;
    CREATE TRIGGER reject_delivery_marker BEFORE UPDATE OF audit_delivered_at ON record_write_operations
      FOR EACH ROW EXECUTE FUNCTION reject_delivery_marker()`)
  try {
    first=await call(alice,'POST',path,{data:{title:'marker failure'}},key)
    assert.equal(first.status,201)
    assert.equal(first.body.auditPending,true)
    assert.equal((await adminQuery('kvvi_audit','SELECT count(*)::int n FROM audit_entries WHERE resource_id=$1',[first.body.recordId])).rows[0].n,1)
  } finally {
    await adminQuery('kvvi_business','DROP TRIGGER reject_delivery_marker ON record_write_operations; DROP FUNCTION reject_delivery_marker()')
  }
  await closeAll()
  const retry=await call(alice,'POST',path,{data:{title:'marker failure'}},key)
  assert.equal(retry.body.recordId,first.body.recordId)
  assert.equal(retry.body.auditPending,false)
  assert.equal((await adminQuery('kvvi_audit', 'SELECT count(*)::int n FROM audit_entries WHERE resource_id=$1',[first.body.recordId])).rows[0].n,1)
})

test('COMMIT succeeded but its reply was lost: report unknown and resume only the same key', async () => {
  const key=randomUUID(), business=pool('business'), originalConnect=business.connect
  let lost=false
  business.connect=function(callback) {
    if (callback) return originalConnect.call(this,callback)
    return originalConnect.call(this).then(client=>{
      const query=client.query, release=client.release
      let inserted=false
      client.query=async function(...args) {
        const text=typeof args[0]==='string'?args[0]:args[0].text
        const result=await query.apply(this,args)
        if (text.includes('INSERT INTO record_write_operations')) inserted=true
        if (text==='COMMIT' && inserted && !lost) {
          lost=true
          throw Object.assign(new Error('injected lost commit response'),{code:'08006'})
        }
        return result
      }
      client.release=function(...args) { client.query=query; client.release=release; return release.apply(this,args) }
      return client
    })
  }
  try {
    const unknown=await call(alice,'POST',path,{data:{title:'commit reply lost'}},key)
    assert.equal(lost,true)
    assert.equal(unknown.status,503)
    assert.equal(unknown.body.error,'KVVI_OPERATION_OUTCOME_UNKNOWN')
    assert.equal(unknown.body.idempotencyKey,key)
    assert.equal(unknown.body.retryWithSameKey,true)
  } finally { business.connect=originalConnect }
  await closeAll()
  const retry=await call(alice,'POST',path,{data:{title:'commit reply lost'}},key)
  assert.equal(retry.status,201)
  assert.equal(retry.body.auditPending,false)
  assert.equal(await count('commit reply lost'),1)
})

test('old timestamps never turn a committed write key into another action', async () => {
  const key=randomUUID(), data={data:{title:'durable old key'}}
  const first=await call(alice,'POST',path,data,key)
  await adminQuery('kvvi_business',"UPDATE record_write_operations SET created_at=now()-interval '90 days' WHERE operation_id=$1",[first.body.operationId])
  const retry=await call(alice,'POST',path,data,key)
  assert.equal(retry.body.recordId,first.body.recordId)
  assert.equal(await count('durable old key'),1)
})

test('legacy platform receipt without payload binding refuses another business effect', async () => {
  const key=randomUUID()
  await pool('platform').query(`INSERT INTO idempotency_keys(company_id,user_id,endpoint,idem_key,response,status_code)
    VALUES($1,$2,$3,$4,$5,201)`,[A.company,A.alice,'POST '+path,key,{recordId:randomUUID()}])
  const refused=await call(alice,'POST',path,{data:{title:'legacy key'}},key)
  assert.equal(refused.status,409)
  assert.equal(refused.body.error,'KVVI_OPERATION_LEGACY_RECEIPT')
  assert.equal(await count('legacy key'),0)
})

test('background delivery uses persisted receipts without needing another user write', async () => {
  let created
  await adminQuery('kvvi_audit',`REVOKE EXECUTE ON FUNCTION ${once} FROM kvvi_audit_writer`)
  try {
    created=await call(alice,'POST',path,{data:{title:'background receipt'}})
    assert.equal(created.body.auditPending,true)
  } finally { await adminQuery('kvvi_audit',`GRANT EXECUTE ON FUNCTION ${once} TO kvvi_audit_writer`) }
  await closeAll()
  await adminQuery('kvvi_business','UPDATE record_write_operations SET audit_next_attempt_at=now() WHERE operation_id=$1',[created.body.operationId])
  assert.deepEqual(await flushWriteAudit(),{delivered:1,pending:0})
  assert.equal((await adminQuery('kvvi_audit','SELECT count(*)::int n FROM audit_entries WHERE resource_id=$1',[created.body.recordId])).rows[0].n,1)
})

test('a slow audit call has a timeout budget and safely resumes after the lock clears', async () => {
  const lock=await pool('auditRead').connect(), key=randomUUID()
  let created
  await lock.query('BEGIN')
  await lock.query("SELECT pg_advisory_xact_lock(hashtext('kvvi_audit_chain'))")
  const started=Date.now()
  try {
    created=await call(alice,'POST',path,{data:{title:'audit timeout'}},key)
    assert.equal(created.status,201)
    assert.equal(created.body.auditPending,true)
    assert.ok(Date.now()-started>=4500)
    assert.ok(Date.now()-started<9000)
  } finally { await lock.query('COMMIT'); lock.release() }
  const retry=await call(alice,'POST',path,{data:{title:'audit timeout'}},key)
  assert.equal(retry.body.recordId,created.body.recordId)
  assert.equal(retry.body.auditPending,false)
  assert.equal((await adminQuery('kvvi_audit','SELECT count(*)::int n FROM audit_entries WHERE resource_id=$1',[created.body.recordId])).rows[0].n,1)
})

test('a fresh platform process automatically drains persisted audit receipts', async () => {
  let created
  await adminQuery('kvvi_audit',`REVOKE EXECUTE ON FUNCTION ${once} FROM kvvi_audit_writer`)
  try {
    created=await call(alice,'POST',path,{data:{title:'server restart receipt'}})
    assert.equal(created.body.auditPending,true)
  } finally { await adminQuery('kvvi_audit',`GRANT EXECUTE ON FUNCTION ${once} TO kvvi_audit_writer`) }
  await adminQuery('kvvi_business','UPDATE record_write_operations SET audit_next_attempt_at=now() WHERE operation_id=$1',[created.body.operationId])
  const reservation=createServer()
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve))
  const port=reservation.address().port
  await new Promise(resolve=>reservation.close(resolve))
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],{
    env:{...process.env,KVVI_PLATFORM_HOST:'127.0.0.1',KVVI_PLATFORM_PORT:String(port),KVVI_RUNTIME_URL:'http://127.0.0.1:1'},
    stdio:'ignore',
  })
  const exited=new Promise(resolve=>child.once('exit',resolve))
  try {
    const deadline=Date.now()+18000
    let drained=false
    while (Date.now()<deadline) {
      assert.equal(child.exitCode,null,'owned platform process exited before draining')
      try {
        const health=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(1000)})
        const state=await health.json()
        if (state.recordWriteAuditPending===0) { drained=true; break }
      } catch { /* wait only for this owned process */ }
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    assert.equal(drained,true)
  } finally {
    if (child.exitCode===null && child.signalCode===null) child.kill('SIGTERM')
    const timer=setTimeout(()=>child.kill('SIGKILL'),3000)
    try { await exited } finally { clearTimeout(timer) }
  }
  assert.equal((await adminQuery('kvvi_audit','SELECT count(*)::int n FROM audit_entries WHERE resource_id=$1',[created.body.recordId])).rows[0].n,1)
})

test('audit pool checkout is part of the delivery timeout budget', async () => {
  const held=await Promise.all(Array.from({length:8},()=>pool('audit').connect()))
  const key=randomUUID(), started=Date.now()
  let created
  try {
    created=await call(alice,'POST',path,{data:{title:'audit pool exhausted'}},key)
    assert.equal(created.status,201)
    assert.equal(created.body.auditPending,true)
    assert.ok(Date.now()-started>=4500)
    assert.ok(Date.now()-started<9000)
  } finally { for (const client of held) client.release() }
  const retry=await call(alice,'POST',path,{data:{title:'audit pool exhausted'}},key)
  assert.equal(retry.body.recordId,created.body.recordId)
  assert.equal(retry.body.auditPending,false)
})

test('an already locked receipt returns pending without waiting for that row lock', async () => {
  const created=await call(alice,'POST',path,{data:{title:'locked receipt'}})
  const lock=await pool('business').connect()
  await lock.query('BEGIN')
  await lock.query("SELECT set_config('kvvi.company_id',$1,true)",[A.company])
  await lock.query('SELECT 1 FROM record_write_operations WHERE operation_id=$1 FOR UPDATE',[created.body.operationId])
  try {
    const start=Date.now()
    assert.equal(await deliverWriteAudit(A.company,A.alice,created.body.operationId),false)
    assert.ok(Date.now()-start<1000)
  } finally { await lock.query('ROLLBACK'); lock.release() }
})

test('background enumeration has a deadline under an actual table lock and can run again', async () => {
  const lock=await pool('business').connect()
  await lock.query('BEGIN')
  await lock.query('LOCK TABLE record_write_operations IN ACCESS EXCLUSIVE MODE')
  try {
    const start=Date.now()
    await assert.rejects(()=>flushWriteAudit(),/timeout/i)
    assert.ok(Date.now()-start>=4500)
    assert.ok(Date.now()-start<9000)
  } finally { await lock.query('ROLLBACK'); lock.release() }
  assert.deepEqual(await flushWriteAudit(),{delivered:0,pending:0})
})


test('the actual client create converter uses authorized metadata and reaches real PG without stringifying types',async()=>{
  const {coerceCreateData}=await import('../../../forks/dsh/变更/packages/client/kvvi-panel/src/client/values.ts')
  const metadata=await call(alice,'GET','/systems/general_item/fields')
  assert.equal(metadata.status,200)
  const fields=metadata.body.fields.map(field=>({...field,type_config:{...field.type_config,options:field.options??[]}}))
  const converted=coerceCreateData(fields,{title:'converted create',note:'long text',flag:'false',count:'0',
    ratio:'12345678901234567890.123456789012',total:'9007199254740993.01',on_date:'2024-02-29',
    at_time:'2026-10-19T10:15',choice:'b',tags:'a,b',nullable_count:''},
    Object.fromEntries(fields.map(field=>[field.field_code,field.visibility])))
  assert.deepEqual(converted.invalidFields,[])
  const expected={title:'converted create',note:'long text',flag:false,count:0,ratio:'12345678901234567890.123456789012',
    total:{amount:'9007199254740993.01',currency:'CNY'},on_date:'2024-02-29',at_time:new Date('2026-10-19T10:15').toISOString(),
    choice:'b',tags:['a','b'],nullable_count:null}
  assert.deepEqual(converted.data,expected)
  const created=await call(alice,'POST',path,{data:converted.data})
  assert.equal(created.status,201)
  assert.deepEqual((await adminQuery('kvvi_business','SELECT data FROM business_records WHERE record_id=$1',[created.body.recordId])).rows[0].data,expected)
})

test('authenticated original-key lookup recovers a committed create without replaying its business effect',async()=>{
  const key=randomUUID(), data={title:'lookup create'}
  const created=await call(alice,'POST',path,{data},key)
  assert.equal(created.status,201)
  const fresh=await makeSession(A.alice,A.company)
  const recovered=await call(fresh,'GET','/systems/general_item/write-receipt',undefined,key)
  assert.equal(recovered.status,200)
  assert.equal(recovered.body.state,'COMMITTED')
  assert.equal(recovered.body.result.recordId,created.body.recordId)
  assert.equal(recovered.body.operationId,created.body.operationId)
  assert.equal(recovered.body.statusCode,201)
  assert.equal(await count(data.title),1)
  assert.equal(JSON.stringify(recovered.body).includes(data.title),false)
  const fields=(await adminQuery('kvvi_business','SELECT request_fields FROM record_write_operations WHERE idempotency_key=$1',[key])).rows[0].request_fields
  assert.deepEqual(fields,['title'])
})

test('receipt lookup stays unknown for absent/different-owner keys without creating any effect',async()=>{
  const key=randomUUID()
  const created=await call(alice,'POST',path,{data:{title:'scoped receipt'}},key)
  const other=await call(bob,'GET','/systems/general_item/write-receipt',undefined,key)
  assert.equal(other.status,202)
  assert.equal(other.body.state,'UNKNOWN')
  assert.equal(JSON.stringify(other.body).includes(created.body.recordId),false)
  const absent=await call(alice,'GET','/systems/general_item/write-receipt',undefined,randomUUID())
  assert.equal(absent.status,202)
  assert.equal(absent.body.state,'UNKNOWN')
  assert.equal(await count('scoped receipt'),1)
})

test('lookup of a PATCH receipt returns its original result and rechecks current field authorization',async()=>{
  const created=await call(alice,'POST',path,{data:{title:'patch lookup'}})
  const key=randomUUID()
  const updated=await call(alice,'PATCH',`${path}/${created.body.recordId}`,{data:{title:'patch lookup changed'},rowVersion:1},key)
  assert.equal(updated.status,200)
  const url=`${path}/${created.body.recordId}/write-receipt`
  const read=await call(alice,'GET',url,undefined,key)
  assert.equal(read.status,200)
  assert.deepEqual(read.body.result,{recordId:updated.body.recordId,rowVersion:2})
  const role=(await pool('platform').query(`SELECT role_id FROM role_members WHERE company_id=$1 AND user_id=$2 LIMIT 1`,[A.company,A.alice])).rows[0].role_id
  const policy=randomUUID()
  await pool('platform').query(`INSERT INTO policies(policy_id,company_id,role_id,dimension,resource_code,field_visibility) VALUES($1,$2,$3,'FIELD','title','HIDDEN')`,[policy,A.company,role])
  try {
    const denied=await call(alice,'GET',url,undefined,key)
    assert.equal(denied.status,403)
    assert.equal(denied.body.error,'KVVI_NOT_ALLOWED')
    assert.equal(denied.body.fields,undefined)
    assert.equal(denied.body.result,undefined)
  } finally {await pool('platform').query('DELETE FROM policies WHERE policy_id=$1',[policy])}
})

test('a create receipt with a row transferred outside current scope no longer exposes its result',async()=>{
  const key=randomUUID()
  const created=await call(alice,'POST',path,{data:{title:'receipt moved outside scope'}},key)
  assert.equal(created.status,201)
  assert.equal((await call(alice,'GET','/systems/general_item/write-receipt',undefined,key)).status,200)
  await adminQuery('kvvi_business','UPDATE business_records SET owner_id=$1,dept_id=NULL,shop_id=NULL WHERE record_id=$2',[A.bob,created.body.recordId])
  const hidden=await call(alice,'GET','/systems/general_item/write-receipt',undefined,key)
  assert.ok([403,404].includes(hidden.status))
  assert.equal(hidden.body.result,undefined)
})

test('older receipts without field recovery metadata require manual review rather than unknown/new execution',async()=>{
  const key=randomUUID(), created=await call(alice,'POST',path,{data:{title:'metadata legacy receipt'}},key)
  assert.equal(created.status,201)
  await adminQuery('kvvi_business','UPDATE record_write_operations SET request_fields=NULL WHERE idempotency_key=$1',[key])
  const legacy=await call(alice,'GET','/systems/general_item/write-receipt',undefined,key)
  assert.equal(legacy.status,409)
  assert.equal(legacy.body.error,'KVVI_OPERATION_LEGACY_RECEIPT')
  assert.equal(legacy.body.result,undefined)
  assert.equal(await count('metadata legacy receipt'),1)
  const oldKey=randomUUID()
  await pool('platform').query(`INSERT INTO idempotency_keys(company_id,user_id,endpoint,idem_key,response,status_code) VALUES($1,$2,$3,$4,$5,201)`,
    [A.company,A.alice,'POST /systems/general_item/records',oldKey,{recordId:randomUUID(),rowVersion:1}])
  const old=await call(alice,'GET','/systems/general_item/write-receipt',undefined,oldKey)
  assert.equal(old.status,409)
  assert.equal(old.body.error,'KVVI_OPERATION_LEGACY_RECEIPT')
})

test('receipt lookup times out safely behind an in-flight original key, then recovers that one result',async()=>{
  const key=randomUUID(), lock=await pool('business').connect()
  let creating
  await lock.query('BEGIN')
  await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['record-write',A.company,A.alice,'POST /systems/general_item/records',key])])
  try {
    creating=call(alice,'POST',path,{data:{title:'inflight lookup'}},key)
    const started=Date.now()
    const status=await call(alice,'GET','/systems/general_item/write-receipt',undefined,key)
    assert.equal(status.status,503)
    assert.equal(status.body.error,'KVVI_OPERATION_OUTCOME_UNKNOWN')
    assert.equal(status.body.idempotencyKey,key)
    assert.equal(status.body.retryWithSameKey,true)
    assert.ok(Date.now()-started<6500)
  } finally {await lock.query('ROLLBACK');lock.release()}
  const created=await creating
  assert.equal(created.status,201)
  const recovered=await call(alice,'GET','/systems/general_item/write-receipt',undefined,key)
  assert.equal(recovered.status,200)
  assert.equal(recovered.body.result.recordId,created.body.recordId)
  assert.equal(await count('inflight lookup'),1)
})

test('receipt lookup refuses a revoked create action and never returns a foreign company result',async()=>{
  const key=randomUUID(), created=await call(alice,'POST',path,{data:{title:'lookup action revoked'}},key)
  assert.equal(created.status,201)
  const foreign=await call(other,'GET','/systems/general_item/write-receipt',undefined,key)
  assert.ok([403,404].includes(foreign.status))
  assert.equal(JSON.stringify(foreign.body).includes(created.body.recordId),false)
  const policies=(await pool('platform').query(`SELECT p.policy_id,p.actions FROM policies p
    JOIN role_members r ON r.role_id=p.role_id AND r.company_id=p.company_id
    WHERE p.company_id=$1 AND r.user_id=$2 AND p.dimension='FORM'`,[A.company,A.alice])).rows
  try {
    for(const policy of policies) await pool('platform').query("UPDATE policies SET actions=array_remove(actions,'create') WHERE policy_id=$1",[policy.policy_id])
    const denied=await call(alice,'GET','/systems/general_item/write-receipt',undefined,key)
    assert.equal(denied.status,403)
    assert.equal(denied.body.error,'KVVI_NOT_ALLOWED')
    assert.equal(denied.body.result,undefined)
  } finally {
    for(const policy of policies) await pool('platform').query('UPDATE policies SET actions=$2 WHERE policy_id=$1',[policy.policy_id,policy.actions])
  }
})

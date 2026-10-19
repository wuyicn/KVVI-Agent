import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {A,resetDatabase,grantBaseline,makeSession,adminQuery,pool,closeAll} from './harness.mjs'
import {publishVisitorFixture} from './visitor-fixture.mjs'
import {issueLink,submitAsVisitor} from '../src/visitor.mjs'
let issuer
before(async()=>{await resetDatabase();await grantBaseline(A.alice);await publishVisitorFixture();issuer=await makeSession(A.alice,A.company)})
after(closeAll)
const link=(maxSubmissions=1)=>issueLink({ctx:issuer.ctx,formCode:'general_item',schemaCode:'general_item',fields:['title'],actions:['create'],rowScope:{},maxSubmissions})
const submit=(token,key=randomUUID(),title=randomUUID())=>submitAsVisitor({token,idempotencyKey:key,data:{title}})
const count=async(table)=>(await adminQuery('kvvi_business',`SELECT count(*)::int n FROM ${table}`)).rows[0].n
const enable=()=>adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=true WHERE singleton')
test('new signed links cannot create through the old path while cutover admission is closed',async()=>{
  const result=await link(),before=await count('business_records')
  await assert.rejects(()=>submit(result.token),error=>error.code==='KVVI_VISITOR_CUTOVER_REQUIRED')
  assert.equal(await count('business_records'),before)
})
test('every first submit requires a client-held random UUID original key',async()=>{
  await enable();const result=await link(),before=await count('business_records')
  for(const key of [undefined,'','payload-hash',randomUUID()+'.extra'])await assert.rejects(()=>submitAsVisitor({token:result.token,idempotencyKey:key,data:{title:'no key'}}),error=>error.code==='KVVI_OPERATION_KEY_INVALID')
  assert.equal(await count('business_records'),before)
})
test('max1 same-key retries preserve one effect and pinned published workflow without platform counter dependence',async()=>{
  const result=await link(),key=randomUUID(),title='same original '+randomUUID()
  const before=await count('kvvi_visitor_private.admissions')
  const first=await submit(result.token,key,title),second=await submit(result.token,key.toUpperCase(),title)
  assert.equal(first.recordId,second.recordId);assert.equal(first.operationId,second.operationId)
  assert.equal(first.idempotencyKey,key);assert.equal(first.projectionPending,false)
  assert.equal(await count('kvvi_visitor_private.admissions'),before+1)
  const record=(await adminQuery('kvvi_business','SELECT state,workflow_version,record_no FROM business_records WHERE record_id=$1',[first.recordId])).rows[0]
  assert.equal(record.state,'collecting');assert.equal(record.workflow_version,1);assert.ok(record.record_no);assert.ok(!record.record_no.startsWith('VIS'))
  assert.equal((await adminQuery('kvvi_business','SELECT count(*)::int n FROM visitor_submissions WHERE operation_id=$1',[first.operationId])).rows[0].n,1)
  await assert.rejects(()=>submit(result.token,randomUUID(),title),error=>error.code==='KVVI_RATE_LIMITED_LINK')
  await assert.rejects(()=>submit(result.token,key,'changed body'),error=>error.code==='KVVI_OPERATION_KEY_CONFLICT')
})
test('different keys with maxN race for exactly the fixed lifetime capacity',async()=>{
  const result=await link(2),before=await count('business_records')
  const results=await Promise.allSettled(Array.from({length:8},()=>submit(result.token)))
  assert.equal(results.filter(result=>result.status==='fulfilled').length,2)
  assert.ok(results.filter(result=>result.status==='rejected').every(result=>result.reason.code==='KVVI_RATE_LIMITED_LINK'))
  assert.equal(await count('business_records'),before+2)
})
test('failed journal insert rolls back record, receipt, quota and transaction sequence; the same key can retry',async()=>{
  const result=await link(),key=randomUUID(),title='atomic storage fault'
  const counts=await Promise.all(['business_records','record_write_operations','kvvi_visitor_private.admissions'].map(count))
  const numbers=(await adminQuery('kvvi_business','SELECT * FROM sequences ORDER BY company_id,schema_code,period_key')).rows
  await adminQuery('kvvi_business',`CREATE FUNCTION public.visitor_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected visitor journal'; END $$;
    CREATE TRIGGER visitor_fault BEFORE INSERT ON visitor_submissions FOR EACH ROW EXECUTE FUNCTION visitor_fault()`)
  try{await assert.rejects(()=>submit(result.token,key,title),/injected visitor journal/u)}
  finally{await adminQuery('kvvi_business','DROP TRIGGER visitor_fault ON visitor_submissions; DROP FUNCTION visitor_fault()')}
  assert.deepEqual(await Promise.all(['business_records','record_write_operations','kvvi_visitor_private.admissions'].map(count)),counts)
  assert.deepEqual((await adminQuery('kvvi_business','SELECT * FROM sequences ORDER BY company_id,schema_code,period_key')).rows,numbers)
  assert.ok((await submit(result.token,key,title)).recordId)
})
test('actual COMMIT followed by lost confirmation returns UNKNOWN and original key recovers one effect',async()=>{
  const result=await link(),key=randomUUID(),title='lost confirmation'
  const business=pool('business'),connect=business.connect
  let injected=false
  business.connect=async function(...args){
    const client=await connect.apply(this,args),query=client.query
    client.query=async function(...queryArgs){
      const output=await query.apply(this,queryArgs)
      if(queryArgs[0]==='COMMIT'&&!injected){injected=true;throw new Error('injected lost COMMIT reply')}
      return output
    }
    return client
  }
  try{await assert.rejects(()=>submit(result.token,key,title),error=>error.code==='KVVI_OPERATION_OUTCOME_UNKNOWN'&&error.key===key)}
  finally{business.connect=connect}
  assert.equal(injected,true)
  const recovered=await submit(result.token,key,title)
  assert.ok(recovered.recordId)
  assert.equal((await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'=$1",[title])).rows[0].n,1)
})
test('simultaneous submissions with one original key share the same receipt',async()=>{
  const result=await link(),key=randomUUID(),before=await count('business_records')
  const outputs=await Promise.all(Array.from({length:6},()=>submit(result.token,key,'same concurrent original')))
  assert.equal(new Set(outputs.map(output=>output.operationId)).size,1)
  assert.equal(await count('business_records'),before+1)
})
async function whileSourceBlocked(source,action){
  const {createHash}=await import('node:crypto'),client=await pool('business').connect()
  await client.query('BEGIN')
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['visitor-source:'+createHash('sha256').update(source).digest('hex')])
  try{await action(async()=>{await client.query('COMMIT')})}
  finally{await client.query('ROLLBACK');client.release()}
}
async function waitForAdmission(){
  const deadline=Date.now()+3000
  while(Date.now()<deadline){
    if((await adminQuery('kvvi_business',"SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT kvvi_visitor_private.admit%'")).rows.length)return
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.fail('request never waited at source admission lock')
}
test('revocation while queued for quota is rechecked after the lock and rolls back its reservation',async()=>{
  const result=await link(),source='queued revocation '+randomUUID(),before=await count('kvvi_visitor_private.admissions')
  await whileSourceBlocked(source,async release=>{
    const request=submitAsVisitor({token:result.token,idempotencyKey:randomUUID(),data:{title:'must not write revoked'},sourceIp:source});void request.catch(()=>{})
    try{
      await waitForAdmission()
      await pool('platform').query('UPDATE visitor_links SET revoked_at=now() WHERE link_id=$1',[result.linkId])
      await release()
      await assert.rejects(()=>request,error=>error.code==='KVVI_LINK_REVOKED')
    }finally{await release();await Promise.allSettled([request])}
  })
  assert.equal(await count('kvvi_visitor_private.admissions'),before)
})
test('expiry while queued is checked using database admission time even when request time is frozen',async()=>{
  const result=await issueLink({ctx:issuer.ctx,formCode:'general_item',schemaCode:'general_item',fields:['title'],actions:['create'],rowScope:{},ttlMs:3000})
  const source='queued expiry '+randomUUID(),before=await count('kvvi_visitor_private.admissions'),nowMs=Date.now()
  await whileSourceBlocked(source,async release=>{
    const request=submitAsVisitor({token:result.token,idempotencyKey:randomUUID(),data:{title:'must not write expired'},sourceIp:source,nowMs});void request.catch(()=>{})
    try{
      await waitForAdmission();await new Promise(resolve=>setTimeout(resolve,result.expiresAt.getTime()-Date.now()+10))
      await release();await assert.rejects(()=>request,error=>error.code==='KVVI_LINK_EXPIRED')
    }finally{await release();await Promise.allSettled([request])}
  })
  assert.equal(await count('kvvi_visitor_private.admissions'),before)
})
test('a committed original receipt is withheld when the record has left the issuer current row scope',async()=>{
  const result=await link(),key=randomUUID(),title='transferred original receipt'
  const first=await submit(result.token,key,title)
  await adminQuery('kvvi_business','UPDATE business_records SET owner_id=$2,dept_id=$3,shop_id=$4 WHERE record_id=$1',[first.recordId,A.bob,A.otherDept,A.shop2])
  await assert.rejects(()=>submit(result.token,key,title),error=>error.code==='KVVI_NOT_ALLOWED')
  assert.equal((await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'=$1",[title])).rows[0].n,1)
})
for(const kind of ['form','unique','sequence'])test('revocation while queued for '+kind+' is checked before the business INSERT',async()=>{
  const result=await link(),before=await count('kvvi_visitor_private.admissions'),client=await pool('business').connect()
  await client.query('BEGIN')
  await client.query("SELECT set_config('kvvi.company_id',$1,true)",[A.company])
  if(kind==='form')await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['form-lifecycle',A.company,'general_item'])])
  else if(kind==='unique')await client.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('field-unique',$1::uuid,$2::text)::text,0))",[A.company,'general_item'])
  else await client.query("SELECT * FROM sequences WHERE company_id=$1 AND schema_code='general_item' FOR UPDATE",[A.company])
  const request=submit(result.token);void request.catch(()=>{})
  try{
    const deadline=Date.now()+3000
    let waited=false
    while(Date.now()<deadline){
      const query=kind==='form'?'SELECT pg_advisory_xact_lock_shared%':kind==='unique'?'SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array%':'INSERT INTO sequences%'
      if((await adminQuery('kvvi_business',"SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",[query])).rows.length){waited=true;break}
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(waited,true,'must exercise the actual '+kind+' lock wait')
    await pool('platform').query('UPDATE visitor_links SET revoked_at=now() WHERE link_id=$1',[result.linkId])
    await client.query('COMMIT')
    await assert.rejects(()=>request,error=>error.code==='KVVI_LINK_REVOKED')
  }finally{await client.query('ROLLBACK');client.release();await Promise.allSettled([request])}
  assert.equal(await count('kvvi_visitor_private.admissions'),before)
})
test('quota and projection use the source and token snapshot captured before awaiting',async()=>{
  const result=await link(),other=await link(),source='snapshot source '+randomUUID(),{createHash}=await import('node:crypto')
  const input={token:result.token,idempotencyKey:randomUUID(),data:{title:'frozen source'},sourceIp:source}
  await whileSourceBlocked(source,async release=>{
    const request=submitAsVisitor(input);void request.catch(()=>{})
    try{
      await waitForAdmission();input.token=other.token;input.sourceIp='mutated source'
      await release();const output=await request
      const stored=(await adminQuery('kvvi_business','SELECT projection_payload FROM visitor_submissions WHERE operation_id=$1',[output.operationId])).rows[0].projection_payload
      assert.equal(stored.sourceIp,source)
      const admission=(await adminQuery('kvvi_business','SELECT binding_digest,source_key FROM kvvi_visitor_private.admissions WHERE operation_id=$1',[output.operationId])).rows[0]
      assert.equal(admission.binding_digest,createHash('sha256').update(result.token).digest('hex'))
      assert.equal(admission.source_key,createHash('sha256').update(source).digest('hex'))
    }finally{await release();await Promise.allSettled([request])}
  })
})
test('a new Node process recovers the original committed key without another record',async()=>{
  const result=await link(),key=randomUUID(),title='fresh process original',first=await submit(result.token,key,title)
  const {execFileSync}=await import('node:child_process')
  const code=`import {submitAsVisitor} from './services/platform/src/visitor.mjs';import {closeAll} from './services/platform/src/db.mjs';try{const r=await submitAsVisitor(JSON.parse(process.env.KVVI_TEST_VISITOR_REQUEST));process.stdout.write(JSON.stringify({recordId:r.recordId,operationId:r.operationId}));}finally{await closeAll()}`
  const recovered=JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',code],{
    cwd:new URL('../../../',import.meta.url),env:{...process.env,KVVI_TEST_VISITOR_REQUEST:JSON.stringify({token:result.token,idempotencyKey:key,data:{title}})},encoding:'utf8',timeout:15000}))
  assert.equal(recovered.recordId,first.recordId);assert.equal(recovered.operationId,first.operationId)
  assert.equal((await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'=$1",[title])).rows[0].n,1)
})
test('audit failure leaves one business effect and a durable audit payload for original-key recovery',async()=>{
  const result=await link(),key=randomUUID(),title='visitor audit retry'
  const signature='audit_append_once(uuid,uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)'
  let first
  await adminQuery('kvvi_audit',`REVOKE EXECUTE ON FUNCTION ${signature} FROM kvvi_audit_writer`)
  try{first=await submit(result.token,key,title);assert.equal(first.auditPending,true)}
  finally{await adminQuery('kvvi_audit',`GRANT EXECUTE ON FUNCTION ${signature} TO kvvi_audit_writer`)}
  const recovered=await submit(result.token,key,title)
  assert.equal(recovered.operationId,first.operationId);assert.equal(recovered.auditPending,false)
  assert.equal((await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'=$1",[title])).rows[0].n,1)
})
test('malformed auxiliary sources are rejected before any admission',async()=>{
  const result=await link(),before=await count('kvvi_visitor_private.admissions')
  for(const sourceIp of ['',{},17,'x'.repeat(129)])await assert.rejects(()=>submitAsVisitor({token:result.token,idempotencyKey:randomUUID(),data:{title:'invalid source'},sourceIp}),error=>error.code==='KVVI_VISITOR_SOURCE_INVALID')
  assert.equal(await count('kvvi_visitor_private.admissions'),before)
})

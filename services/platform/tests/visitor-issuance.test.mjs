import {beforeEach,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {A,resetDatabase,grantBaseline,makeSession,adminQuery,pool,closeAll} from './harness.mjs'
import {issueLink} from '../src/visitor.mjs'
let alice,bob
beforeEach(async()=>{await resetDatabase();await grantBaseline(A.alice);await grantBaseline(A.bob)
  alice=await makeSession(A.alice,A.company);bob=await makeSession(A.bob,A.company)})
after(closeAll)
const issue=(ctx=alice.ctx)=>issueLink({ctx,formCode:'general_item',schemaCode:'general_item',fields:['title'],actions:['create'],rowScope:{}})
const count=async()=>(await pool('platform').query('SELECT count(*)::int n FROM visitor_links')).rows[0].n
test('same-issuer parallel issuance admits exactly the active-link capacity',async()=>{
  const outputs=await Promise.allSettled(Array.from({length:32},()=>issue()))
  assert.equal(outputs.filter(output=>output.status==='fulfilled').length,20)
  assert.ok(outputs.filter(output=>output.status==='rejected').every(output=>output.reason.code==='KVVI_RATE_LIMITED_ISSUER'))
  assert.equal(await count(),20)
})
test('different issuers serialize against the same company issuance window',async()=>{
  await adminQuery('kvvi_platform',`INSERT INTO visitor_links(link_id,token_digest,nonce,company_id,schema_code,form_code,allowed_fields,allowed_actions,row_scope,issuer_user_id,issuer_authz_version,expires_at)
    SELECT gen_random_uuid(),gen_random_uuid()::text,gen_random_uuid()::text,$1,'general_item','general_item','{title}','{create}','{}',$2,1,now()-interval '1 second' FROM generate_series(1,199)`,[A.company,A.alice])
  await adminQuery('kvvi_platform',`CREATE FUNCTION public.visitor_issue_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('visitor-issue-test-insert',0));RETURN NEW;END $$;
    CREATE TRIGGER visitor_issue_gate BEFORE INSERT ON visitor_links FOR EACH ROW EXECUTE FUNCTION visitor_issue_gate()`)
  const gate=await pool('platform').connect()
  await gate.query('BEGIN');await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('visitor-issue-test-insert',0))")
  const requests=[issue(),issue(bob.ctx),issue(),issue(bob.ctx)]
  for(const request of requests)void request.catch(()=>{})
  try{
    const deadline=Date.now()+3000
    let waiting=0
    while(Date.now()<deadline){
      waiting=(await adminQuery('kvvi_platform',"SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n
      if(waiting===4)break
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(waiting,4,'all requests must reach the controlled lock boundary')
    await gate.query('COMMIT')
    const outputs=await Promise.allSettled(requests)
    assert.equal(outputs.filter(output=>output.status==='fulfilled').length,1)
    assert.ok(outputs.filter(output=>output.status==='rejected').every(output=>output.reason.code==='KVVI_RATE_LIMITED_COMPANY'))
    assert.equal(await count(),200)
  }finally{
    await gate.query('ROLLBACK');gate.release();await Promise.allSettled(requests)
    await adminQuery('kvvi_platform','DROP TRIGGER visitor_issue_gate ON visitor_links; DROP FUNCTION visitor_issue_gate()')
  }
})
test('an ISSUED event fault cannot leave a registered live capability',async()=>{
  await adminQuery('kvvi_platform',`CREATE FUNCTION public.visitor_issue_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected issue event'; END $$;
    CREATE TRIGGER visitor_issue_fault BEFORE INSERT ON visitor_link_events FOR EACH ROW WHEN(NEW.kind='ISSUED') EXECUTE FUNCTION visitor_issue_fault()`)
  try{await assert.rejects(()=>issue(),/injected issue event/u)}
  finally{await adminQuery('kvvi_platform','DROP TRIGGER visitor_issue_fault ON visitor_link_events; DROP FUNCTION visitor_issue_fault()')}
  assert.equal(await count(),0)
})
for(const permission of ['form','field'])test('a queued issuer rechecks current '+permission+' permission after obtaining its lock',async()=>{
  const client=await pool('platform').connect()
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['visitor-issue-company',A.company])])
  const request=issue();void request.catch(()=>{})
  try{
    const deadline=Date.now()+2000
    let waited=false
    while(Date.now()<deadline){
      if((await adminQuery('kvvi_platform',"SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'")).rows.length){waited=true;break}
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(waited,true,'the request must exercise the actual issuance lock')
    if(permission==='form')await adminQuery('kvvi_platform',"UPDATE policies SET actions='{read}' WHERE company_id=$1 AND dimension='FORM'",[A.company])
    else await adminQuery('kvvi_platform',"UPDATE policies SET field_visibility='READONLY' WHERE company_id=$1 AND dimension='FIELD'",[A.company])
    await client.query('COMMIT')
    await assert.rejects(()=>request,error=>error.code===(permission==='form'?'KVVI_ISSUER_LACKS_WRITE_PERMISSION':'KVVI_BINDING_EXCEEDS_ISSUER'))
    assert.equal(await count(),0)
  }finally{await client.query('ROLLBACK');client.release();await Promise.allSettled([request])}
})
test('queued issuance time is stamped after its lock wait rather than transaction start',async()=>{
  const client=await pool('platform').connect()
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['visitor-issue-company',A.company])])
  const request=issue();void request.catch(()=>{})
  try{
    const deadline=Date.now()+2000
    let waited=false
    while(Date.now()<deadline){
      if((await adminQuery('kvvi_platform',"SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'")).rows.length){waited=true;break}
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(waited,true)
    await new Promise(resolve=>setTimeout(resolve,80))
    const releaseAt=(await adminQuery('kvvi_platform','SELECT clock_timestamp() AS at')).rows[0].at
    await client.query('COMMIT');const result=await request
    const stored=(await pool('platform').query('SELECT issued_at FROM visitor_links WHERE link_id=$1',[result.linkId])).rows[0]
    assert.ok(stored.issued_at>=releaseAt,'issued_at must not precede actual lock release')
    const event=(await pool('platform').query("SELECT at FROM visitor_link_events WHERE link_id=$1 AND kind='ISSUED'",[result.linkId])).rows[0]
    assert.equal(event.at.getTime(),stored.issued_at.getTime())
  }finally{await client.query('ROLLBACK');client.release();await Promise.allSettled([request])}
})

import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {A,resetDatabase,grantBaseline,makeSession,adminQuery,pool,closeAll} from './harness.mjs'
import {publishVisitorFixture} from './visitor-fixture.mjs'
import {issueLink,submitAsVisitor} from '../src/visitor.mjs'
let issuer
before(async()=>{await resetDatabase();await grantBaseline(A.alice);await publishVisitorFixture();issuer=await makeSession(A.alice,A.company)
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=true WHERE singleton')})
after(closeAll)
async function create(){
  const link=await issueLink({ctx:issuer.ctx,formCode:'general_item',schemaCode:'general_item',fields:['title'],actions:['create'],rowScope:{}})
  const request={token:link.token,idempotencyKey:randomUUID(),data:{title:randomUUID()}}
  return {link,request,result:await submitAsVisitor(request)}
}
test('a committed visitor journal delivers one platform counter and event, independently of business retry',async()=>{
  const {link,result}=await create()
  const {deliverVisitorProjection}=await import('../src/visitor-projection.mjs')
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  assert.equal((await pool('platform').query('SELECT submissions FROM visitor_links WHERE link_id=$1',[link.linkId])).rows[0].submissions,1)
  assert.equal((await pool('platform').query("SELECT count(*)::int n FROM visitor_link_events WHERE link_id=$1 AND kind='SUBMITTED'",[link.linkId])).rows[0].n,1)
  assert.ok((await adminQuery('kvvi_business','SELECT projected_at FROM visitor_submissions WHERE operation_id=$1',[result.operationId])).rows[0].projected_at)
})
async function pendingCreate(){
  await adminQuery('kvvi_platform','REVOKE INSERT ON visitor_projection_receipts FROM kvvi_platform')
  try{const output=await create();assert.equal(output.result.projectionPending,true);return output}
  finally{await adminQuery('kvvi_platform','GRANT INSERT ON visitor_projection_receipts TO kvvi_platform')}
}
const projection=()=>import('../src/visitor-projection.mjs')
const journal=async operationId=>(await adminQuery('kvvi_business','SELECT * FROM visitor_submissions WHERE operation_id=$1',[operationId])).rows[0]
const counter=async linkId=>(await pool('platform').query('SELECT submissions FROM visitor_links WHERE link_id=$1',[linkId])).rows[0].submissions
const receiptCount=async operationId=>(await pool('platform').query('SELECT count(*)::int n FROM visitor_projection_receipts WHERE operation_id=$1',[operationId])).rows[0].n
test('platform receipt failure preserves the committed business result and durable retry timing',async()=>{
  const {link,request,result}=await pendingCreate(),{deliverVisitorProjection}=await projection()
  assert.equal(await counter(link.linkId),0);assert.equal(await receiptCount(result.operationId),0)
  const stored=await journal(result.operationId)
  assert.equal(stored.projected_at,null);assert.equal(stored.projection_attempts,1)
  assert.ok(stored.projection_next_attempt_at>stored.admitted_at)
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  const recovered=await submitAsVisitor(request)
  assert.equal(recovered.recordId,result.recordId);assert.equal(recovered.projectionPending,false)
  assert.equal(await counter(link.linkId),1)
})
test('event failure rolls back platform receipt and counter together',async()=>{
  const {link,result}=await pendingCreate(),{deliverVisitorProjection}=await projection()
  await adminQuery('kvvi_platform',`CREATE FUNCTION public.visitor_event_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected submitted event'; END $$;
    CREATE TRIGGER visitor_event_fault BEFORE INSERT ON visitor_link_events FOR EACH ROW WHEN(NEW.kind='SUBMITTED') EXECUTE FUNCTION visitor_event_fault()`)
  try{assert.equal(await deliverVisitorProjection(A.company,result.operationId),false)}
  finally{await adminQuery('kvvi_platform','DROP TRIGGER visitor_event_fault ON visitor_link_events; DROP FUNCTION visitor_event_fault()')}
  assert.equal(await counter(link.linkId),0);assert.equal(await receiptCount(result.operationId),0)
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  assert.equal(await counter(link.linkId),1)
})
test('lost platform COMMIT confirmation retries its original projection receipt once',async()=>{
  const {link,result}=await pendingCreate(),{deliverVisitorProjection}=await projection(),platform=pool('platform'),connect=platform.connect
  let injected=false
  platform.connect=async function(...args){
    const client=await connect.apply(this,args),query=client.query
    client.query=async function(...queryArgs){
      const text=typeof queryArgs[0]==='string'?queryArgs[0]:queryArgs[0].text
      const output=await query.apply(this,queryArgs)
      if(text==='COMMIT'&&!injected){injected=true;throw new Error('injected platform COMMIT confirmation')}
      return output
    }
    return client
  }
  try{assert.equal(await deliverVisitorProjection(A.company,result.operationId),false)}
  finally{platform.connect=connect}
  assert.equal(injected,true);assert.equal(await counter(link.linkId),1)
  assert.equal((await journal(result.operationId)).projected_at,null)
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  assert.equal(await counter(link.linkId),1);assert.equal(await receiptCount(result.operationId),1)
})
test('business marker failure after platform commit repairs only the marker',async()=>{
  await adminQuery('kvvi_business',`CREATE FUNCTION public.visitor_marker_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection marker'; END $$;
    CREATE TRIGGER visitor_marker_fault BEFORE UPDATE ON visitor_submissions FOR EACH ROW WHEN(NEW.projected_at IS NOT NULL) EXECUTE FUNCTION visitor_marker_fault()`)
  let created
  try{created=await create();assert.equal(created.result.projectionPending,true)}
  finally{await adminQuery('kvvi_business','DROP TRIGGER visitor_marker_fault ON visitor_submissions; DROP FUNCTION visitor_marker_fault()')}
  const {link,result}=created,{deliverVisitorProjection}=await projection()
  assert.equal(await counter(link.linkId),1);assert.equal((await journal(result.operationId)).projected_at,null)
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  assert.equal(await counter(link.linkId),1)
})
test('projection can finish after link revocation; the committed effect is still counted',async()=>{
  const {link,result}=await pendingCreate(),{deliverVisitorProjection}=await projection()
  await pool('platform').query('UPDATE visitor_links SET revoked_at=now() WHERE link_id=$1',[link.linkId])
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  assert.equal(await counter(link.linkId),1)
})
test('company RLS prevents a different company from claiming the journal',async()=>{
  const {B}=await import('./harness.mjs'),{link,result}=await pendingCreate(),{deliverVisitorProjection}=await projection()
  assert.equal(await deliverVisitorProjection(B.company,result.operationId),false)
  assert.equal((await journal(result.operationId)).projection_attempts,1)
  assert.equal(await counter(link.linkId),0)
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
})
test('platform pool checkout has a bounded deadline and does not hold a business connection',async()=>{
  const {link,result}=await pendingCreate(),{deliverVisitorProjection}=await projection(),platform=pool('platform'),held=[]
  try{
    for(let i=0;i<8;i++)held.push(await platform.connect())
    const started=Date.now(),delivery=deliverVisitorProjection(A.company,result.operationId,{budgetMs:150})
    await new Promise(resolve=>setTimeout(resolve,40))
    assert.equal(pool('business').totalCount-pool('business').idleCount,0)
    assert.equal(await delivery,false);assert.ok(Date.now()-started<1000)
  }finally{for(const client of held)client.release()}
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  assert.equal(await counter(link.linkId),1)
})
test('a changed payload cannot reuse an already committed platform projection receipt',async()=>{
  const {link,result}=await create(),{deliverVisitorProjection}=await projection()
  await adminQuery('kvvi_business',`UPDATE visitor_submissions SET projected_at=NULL,projection_payload=jsonb_set(projection_payload,'{fields}','["changed"]') WHERE operation_id=$1`,[result.operationId])
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),false)
  assert.equal(await counter(link.linkId),1);assert.equal((await journal(result.operationId)).projected_at,null)
  await adminQuery('kvvi_business',`UPDATE visitor_submissions SET projection_payload=jsonb_set(projection_payload,'{fields}','["title"]') WHERE operation_id=$1`,[result.operationId])
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
})
test('background scans respect persisted backoff and reject unbounded batch sizes',async()=>{
  const {result}=await pendingCreate(),{flushVisitorProjections,visitorProjectionPending}=await projection()
  assert.deepEqual(await flushVisitorProjections(),{delivered:0,pending:1})
  await adminQuery('kvvi_business','UPDATE visitor_submissions SET projection_next_attempt_at=now() WHERE operation_id=$1',[result.operationId])
  assert.deepEqual(await flushVisitorProjections(),{delivered:1,pending:0})
  assert.equal(await visitorProjectionPending(),0)
  for(const limit of [0,-1,101,1.5])await assert.rejects(()=>flushVisitorProjections({limit}),/KVVI_VISITOR_PROJECTION_LIMIT_INVALID/u)
})
test('parallel delivery attempts share one stable platform receipt and event',async()=>{
  const {link,result}=await pendingCreate(),{deliverVisitorProjection}=await projection()
  const outputs=await Promise.all(Array.from({length:8},()=>deliverVisitorProjection(A.company,result.operationId)))
  assert.ok(outputs.includes(true));assert.equal(await counter(link.linkId),1);assert.equal(await receiptCount(result.operationId),1)
  assert.equal((await pool('platform').query('SELECT count(*)::int n FROM visitor_link_events WHERE submission_id=$1',[result.operationId])).rows[0].n,1)
})
test('a platform row lock times out without retaining its receipt or counter',async()=>{
  const {link,result}=await pendingCreate(),{deliverVisitorProjection}=await projection(),client=await pool('platform').connect()
  await client.query('BEGIN');await client.query('SELECT link_id FROM visitor_links WHERE link_id=$1 FOR UPDATE',[link.linkId])
  try{assert.equal(await deliverVisitorProjection(A.company,result.operationId,{budgetMs:150}),false)}
  finally{await client.query('COMMIT');client.release()}
  assert.equal(await receiptCount(result.operationId),0);assert.equal(await counter(link.linkId),0)
  assert.equal(await deliverVisitorProjection(A.company,result.operationId),true)
  assert.equal(await counter(link.linkId),1)
})
test('a fresh platform process drains persisted visitor projection without another business submission',async()=>{
  const {link,result}=await pendingCreate()
  await adminQuery('kvvi_business','UPDATE visitor_submissions SET projection_next_attempt_at=now() WHERE operation_id=$1',[result.operationId])
  const {createServer}=await import('node:net'),{spawn}=await import('node:child_process'),{fileURLToPath}=await import('node:url')
  const reservation=createServer()
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve))
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve))
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url))],{
    env:{...process.env,KVVI_PLATFORM_HOST:'127.0.0.1',KVVI_PLATFORM_PORT:String(port),KVVI_RUNTIME_URL:'http://127.0.0.1:1'},stdio:'ignore'})
  const exited=new Promise(resolve=>child.once('exit',resolve))
  try{
    const deadline=Date.now()+18000
    let drained=false
    while(Date.now()<deadline){
      assert.equal(child.exitCode,null,'owned platform exited before draining')
      try{
        const response=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(1000)}),state=await response.json()
        if(state.visitorProjectionPending===0){drained=true;break}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    assert.equal(drained,true)
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM')
    const timer=setTimeout(()=>child.kill('SIGKILL'),3000)
    try{await exited}finally{clearTimeout(timer)}
  }
  assert.equal(await counter(link.linkId),1);assert.equal(await receiptCount(result.operationId),1)
  assert.equal((await adminQuery('kvvi_business','SELECT count(*)::int n FROM business_records WHERE record_id=$1',[result.recordId])).rows[0].n,1)
})
test('a later company statistics failure cannot discard an earlier company due projection',async()=>{
  const {B}=await import('./harness.mjs'),{link,result}=await pendingCreate(),{flushVisitorProjections}=await projection()
  await adminQuery('kvvi_business','UPDATE visitor_submissions SET projection_next_attempt_at=now() WHERE operation_id=$1',[result.operationId])
  const business=pool('business'),connect=business.connect
  business.connect=async function(...args){
    const client=await connect.apply(this,args),query=client.query,release=client.release
    client.query=function(...queryArgs){
      const statement=queryArgs[0]
      if(statement?.text?.includes('SELECT count(*)::int n FROM visitor_submissions')&&statement.values?.[0]===B.company)return Promise.reject(new Error('injected later company statistics timeout'))
      return query.apply(this,queryArgs)
    }
    client.release=function(...releaseArgs){client.query=query;return release.apply(this,releaseArgs)}
    return client
  }
  try{
    const outcome=await flushVisitorProjections()
    assert.equal(outcome.delivered,1);assert.equal(outcome.pending,null)
  }finally{business.connect=connect}
  assert.equal(await counter(link.linkId),1)
})

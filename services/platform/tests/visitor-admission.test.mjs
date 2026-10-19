import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {A,B,resetDatabase,grantBaseline,adminQuery,pool,closeAll} from './harness.mjs'
import {scopeContext,applyScopeGucs} from '../src/authorization.mjs'
import {writeOperation} from '../src/record-write-operations.mjs'
import {createRecord} from '../src/refs.mjs'

const digest=value=>createHash('sha256').update(value).digest('hex')
const ctxA={companyId:A.company,userId:A.alice,sessionId:null,gateway:'VISITOR'}
const ctxB={companyId:B.company,userId:B.dave,sessionId:null,gateway:'VISITOR'}
let scopeA,scopeB
const expiries=new Map()
before(async()=>{
  await resetDatabase();await grantBaseline(A.alice);await grantBaseline(B.dave,B.company,B.dept)
  scopeA=await scopeContext(ctxA);scopeB=await scopeContext(ctxB)
  // An explicit fixture qualification on a newly owned, isolated cluster.
  // This does not enable or certify migration of any existing deployment.
  assert.equal((await adminQuery('kvvi_business','SELECT enabled FROM kvvi_visitor_private.config WHERE singleton')).rows[0].enabled,false)
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=true WHERE singleton')
})
after(closeAll)
const admissions=async()=>(await adminQuery('kvvi_business','SELECT count(*)::int n FROM kvvi_visitor_private.admissions')).rows[0].n
async function admit(client,ctx,operationId,{linkId,max=1,source=null,binding=digest('fixed binding'),expires}={}){
  expires??=expiries.get(linkId)??new Date(Date.now()+3600000);expiries.set(linkId,expires)
  return (await client.query('SELECT kvvi_visitor_private.admit($1,$2,$3,$4,$5,$6,$7,$8) AS at',
    [ctx.companyId,ctx.userId,linkId,operationId,max,binding,source===null?null:digest(source),expires])).rows[0].at
}
function submit({ctx=ctxA,scope=scopeA,linkId=randomUUID(),key=randomUUID(),max=1,source=null,title=randomUUID(),hold,binding,expires}={}){
  return writeOperation({ctx,endpoint:`VISITOR /links/${linkId}`,key,request:{data:{title}},authorize:async()=>null,
    run:async(client,{operationId})=>{
      await applyScopeGucs(client,scope)
      const at=await admit(client,ctx,operationId,{linkId,max,source,...(binding===undefined?{}:{binding}),...(expires===undefined?{}:{expires})})
      if(hold)await hold()
      const record=await createRecord(ctx,scope,{schemaCode:'general_item',data:{title}},{client})
      await client.query(`INSERT INTO visitor_submissions(company_id,operation_id,link_id,issuer_id,record_id,admitted_at,projection_payload)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[ctx.companyId,operationId,linkId,ctx.userId,record.recordId,at,{linkId,recordId:record.recordId}])
      return {status:201,body:record,audit:{companyId:ctx.companyId,actorId:ctx.userId,actorKind:'VISITOR',gateway:'VISITOR',sessionId:null,
        action:'visitor.submit',resourceKind:'visitor_link',resourceId:linkId,outcome:'ALLOW',paramsDigest:digest(title)}}
    }})
}
test('a durable receipt, one link admission, record and company projection are one business transaction',async()=>{
  const before=await admissions(),linkId=randomUUID(),key=randomUUID(),title='admission original'
  const first=await submit({linkId,key,title}),again=await submit({linkId,key,title})
  assert.equal(first.body.recordId,again.body.recordId);assert.equal(await admissions(),before+1)
  assert.equal((await adminQuery('kvvi_business','SELECT count(*)::int n FROM visitor_submissions WHERE operation_id=$1',[first.body.operationId])).rows[0].n,1)
  await assert.rejects(()=>submit({linkId,title:'another original'}),error=>error.message==='KVVI_RATE_LIMITED_LINK')
})
test('different keys concurrently consume at most the fixed lifetime link capacity',async()=>{
  const linkId=randomUUID(),before=await admissions()
  const results=await Promise.allSettled(Array.from({length:8},(_,i)=>submit({linkId,max:2,title:'parallel admission '+i})))
  assert.equal(results.filter(result=>result.status==='fulfilled').length,2)
  assert.equal(await admissions(),before+2)
  assert.ok(results.filter(result=>result.status==='rejected').every(result=>result.reason.message==='KVVI_RATE_LIMITED_LINK'))
})
test('global source admission waits across companies and sees the preceding commit',async()=>{
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET source_limit=1 WHERE singleton')
  let reached,release
  const ready=new Promise(resolve=>{reached=resolve}),gate=new Promise(resolve=>{release=resolve})
  const before=await admissions(),source='shared source commit '+randomUUID()
  const first=submit({source,hold:async()=>{reached();await gate}})
  await ready
  const second=submit({ctx:ctxB,scope:scopeB,source});void second.catch(()=>{})
  try{
    const deadline=Date.now()+3000
    let waiting=false
    while(Date.now()<deadline){
      const result=await adminQuery('kvvi_business',"SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT kvvi_visitor_private.admit%'")
      if(result.rows.length){waiting=true;break}
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(waiting,true)
    release();await first
    await assert.rejects(()=>second,error=>error.message==='KVVI_RATE_LIMITED_SOURCE')
    assert.equal(await admissions(),before+1)
  }finally{release();await Promise.allSettled([first,second]);await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET source_limit=30 WHERE singleton')}
})
test('an admission without its matching durable receipt cannot commit',async()=>{
  const client=await pool('business').connect(),before=await admissions()
  try{
    await client.query('BEGIN');await applyScopeGucs(client,scopeA)
    await admit(client,ctxA,randomUUID(),{linkId:randomUUID()})
    await assert.rejects(()=>client.query('COMMIT'),error=>error.code==='23503')
  }finally{await client.query('ROLLBACK');client.release()}
  assert.equal(await admissions(),before)
})
test('the runtime cannot read, modify, create private objects, or assume the quota owner',async()=>{
  for(const sql of ['SELECT * FROM kvvi_visitor_private.admissions',"UPDATE kvvi_visitor_private.config SET enabled=true",'CREATE TABLE kvvi_visitor_private.forbidden(id int)','SET ROLE kvvi_visitor_owner']){
    await assert.rejects(()=>pool('business').query(sql),error=>error.code==='42501')
  }
})
test('missing or mismatched company context and old isolation snapshots fail closed',async()=>{
  for(const mode of ['missing','mismatch','repeatable']){
    const client=await pool('business').connect()
    try{
      await client.query(mode==='repeatable'?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN')
      if(mode!=='missing')await applyScopeGucs(client,scopeB)
      await assert.rejects(()=>admit(client,ctxA,randomUUID(),{linkId:randomUUID()}),error=>error.message===(mode==='repeatable'?'KVVI_VISITOR_ISOLATION_UNSUPPORTED':'KVVI_NOT_ALLOWED'))
    }finally{await client.query('ROLLBACK');client.release()}
  }
})

test('a source reservation rolled back by one company can be used by the waiting other company',async()=>{
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET source_limit=1 WHERE singleton')
  let reached,release
  const ready=new Promise(resolve=>{reached=resolve}),gate=new Promise(resolve=>{release=resolve})
  const before=await admissions(),source='shared source rollback '+randomUUID()
  const first=submit({source,hold:async()=>{reached();await gate;throw new Error('injected rollback')}});void first.catch(()=>{})
  await ready
  const second=submit({ctx:ctxB,scope:scopeB,source});void second.catch(()=>{})
  try{
    await new Promise(resolve=>setTimeout(resolve,25));release()
    await assert.rejects(()=>first,/injected rollback/u)
    assert.equal((await second).status,201);assert.equal(await admissions(),before+1)
  }finally{release();await Promise.allSettled([first,second]);await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET source_limit=30 WHERE singleton')}
})
test('a queued admission checks the database time after waiting, before creating any effect',async()=>{
  let reached,release
  const ready=new Promise(resolve=>{reached=resolve}),gate=new Promise(resolve=>{release=resolve})
  const before=await admissions(),source='expiry while queued '+randomUUID()
  const first=submit({source,hold:async()=>{reached();await gate}})
  await ready
  const second=submit({ctx:ctxB,scope:scopeB,source,expires:new Date(Date.now()+60)});void second.catch(()=>{})
  try{
    await new Promise(resolve=>setTimeout(resolve,120));release();await first
    await assert.rejects(()=>second,error=>error.message==='KVVI_LINK_EXPIRED');assert.equal(await admissions(),before+1)
  }finally{release();await Promise.allSettled([first,second])}
})
test('fixed signed-link metadata cannot be enlarged after its first admission',async()=>{
  const linkId=randomUUID(),before=await admissions()
  await submit({linkId,max:1})
  await assert.rejects(()=>submit({linkId,max:2}),error=>error.message==='KVVI_VISITOR_BINDING_CHANGED')
  await assert.rejects(()=>submit({linkId,max:1,binding:digest('changed binding')}),error=>error.message==='KVVI_VISITOR_BINDING_CHANGED')
  assert.equal(await admissions(),before+1)
})
test('projection storage failure rolls back the record, receipt and quota together',async()=>{
  const before=await admissions(),title='projection storage must roll back',key=randomUUID(),linkId=randomUUID()
  const numbers=(await adminQuery('kvvi_business','SELECT * FROM sequences ORDER BY company_id,schema_code,period_key')).rows
  await adminQuery('kvvi_business',`CREATE FUNCTION public.visitor_projection_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection store'; END $$;
    CREATE TRIGGER visitor_projection_fault BEFORE INSERT ON public.visitor_submissions FOR EACH ROW EXECUTE FUNCTION public.visitor_projection_fault()`)
  try{await assert.rejects(()=>submit({title,key,linkId}),/injected projection store/u)}
  finally{await adminQuery('kvvi_business','DROP TRIGGER visitor_projection_fault ON public.visitor_submissions; DROP FUNCTION public.visitor_projection_fault()')}
  assert.equal(await admissions(),before)
  assert.equal((await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'=$1",[title])).rows[0].n,0)
  assert.equal((await adminQuery('kvvi_business','SELECT count(*)::int n FROM record_write_operations WHERE company_id=$1 AND endpoint=$2 AND idempotency_key=$3',[A.company,`VISITOR /links/${linkId}`,key])).rows[0].n,0)
  assert.deepEqual((await adminQuery('kvvi_business','SELECT * FROM sequences ORDER BY company_id,schema_code,period_key')).rows,numbers)
})
test('company projection rows retain company RLS and hide the other company',async()=>{
  const a=await submit({title:'only company A journal'}),b=await submit({ctx:ctxB,scope:scopeB,title:'only company B journal'})
  const client=await pool('business').connect()
  try{
    await client.query('BEGIN');await applyScopeGucs(client,scopeA)
    assert.equal((await client.query('SELECT operation_id FROM visitor_submissions WHERE operation_id=$1',[a.body.operationId])).rowCount,1)
    assert.equal((await client.query('SELECT operation_id FROM visitor_submissions WHERE operation_id=$1',[b.body.operationId])).rowCount,0)
    await client.query('COMMIT')
  }finally{await client.query('ROLLBACK');client.release()}
})

test('closing admission prevents new effects while an existing original-key receipt remains recoverable',async()=>{
  const linkId=randomUUID(),key=randomUUID(),title='known before gate closed'
  const first=await submit({linkId,key,title}),before=await admissions()
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=false WHERE singleton')
  try{
    assert.equal((await submit({linkId,key,title})).body.recordId,first.body.recordId)
    await assert.rejects(()=>submit(),error=>error.message==='KVVI_VISITOR_CUTOVER_REQUIRED')
    assert.equal(await admissions(),before)
  }finally{await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=true WHERE singleton')}
})

test('rerunning provision and migrations preserves the private ACL and all existing admissions',async()=>{
  const before=await admissions()
  execFileSync(process.execPath,[fileURLToPath(new URL('../src/migrate.mjs',import.meta.url))],{env:{...process.env,KVVI_RESET:'0'},stdio:'pipe'})
  assert.equal(await admissions(),before)
  for(const sql of ['SELECT * FROM kvvi_visitor_private.admissions',"UPDATE kvvi_visitor_private.config SET source_limit=999",'CREATE TABLE kvvi_visitor_private.forbidden(id int)','SET ROLE kvvi_visitor_owner']){
    await assert.rejects(()=>pool('business').query(sql),error=>error.code==='42501')
  }
  const meta=(await adminQuery('kvvi_business',`SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolbypassrls,p.provolatile,p.proparallel,p.prosecdef,p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='kvvi_visitor_private' AND p.proname='admit'`)).rows[0]
  assert.equal(meta.rolname,'kvvi_visitor_owner');assert.equal(meta.rolcanlogin,false);assert.equal(meta.rolsuper,false);assert.equal(meta.rolbypassrls,false)
  assert.equal(meta.provolatile,'v');assert.equal(meta.proparallel,'u');assert.equal(meta.prosecdef,true)
  assert.deepEqual(meta.proconfig,['search_path=pg_catalog, kvvi_visitor_private, pg_temp'])
  assert.equal((await submit({title:'after migration reapply'})).status,201)
})

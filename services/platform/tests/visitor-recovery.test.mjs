import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {A,resetDatabase,grantBaseline,makeSession,adminQuery,pool,closeAll} from './harness.mjs'
import {publishVisitorFixture} from './visitor-fixture.mjs'
import * as visitor from '../src/visitor.mjs'
let issuer
before(async()=>{await resetDatabase();await grantBaseline(A.alice);await publishVisitorFixture();issuer=await makeSession(A.alice,A.company)
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=true WHERE singleton')})
after(closeAll)
async function create(){
  const link=await visitor.issueLink({ctx:issuer.ctx,formCode:'general_item',schemaCode:'general_item',fields:['title'],actions:['create'],rowScope:{}})
  const idempotencyKey=randomUUID(),result=await visitor.submitAsVisitor({token:link.token,idempotencyKey,data:{title:'private business text '+randomUUID()}})
  return {link,idempotencyKey,result}
}
const lookup=(link,key)=>visitor.lookupVisitorSubmission({token:link.token,idempotencyKey:key})
test('original-key read confirms a committed submission without its business body or another effect',async()=>{
  const {link,idempotencyKey,result}=await create()
  const before=(await adminQuery('kvvi_business','SELECT count(*)::int n FROM business_records')).rows[0].n
  const recovered=await lookup(link,idempotencyKey.toUpperCase())
  assert.equal(recovered.status,200);assert.equal(recovered.body.state,'COMMITTED')
  assert.equal(recovered.body.idempotencyKey,idempotencyKey);assert.equal(recovered.body.recordId,result.recordId)
  assert.equal(recovered.body.operationId,result.operationId);assert.equal(recovered.body.projectionPending,false)
  assert.equal(JSON.stringify(recovered).includes('private business text'),false)
  assert.deepEqual(Object.keys(recovered.body).sort(),['state','idempotencyKey','operationId','recordId','recordNo','rowVersion','auditPending','projectionPending'].sort())
  assert.equal((await adminQuery('kvvi_business','SELECT count(*)::int n FROM business_records')).rows[0].n,before)
})
test('an absent key or a key from a different signed link stays UNKNOWN without creating anything',async()=>{
  const first=await create(),second=await create()
  for(const [link,key] of [[first.link,randomUUID()],[second.link,first.idempotencyKey]]){
    const output=await lookup(link,key)
    assert.equal(output.status,202)
    assert.deepEqual(output.body,{state:'UNKNOWN',idempotencyKey:key,retryWithSameKey:true})
  }
})
test('current hidden field permission withholds receipt metadata without revealing the field name',async()=>{
  const {link,idempotencyKey}=await create(),policy=randomUUID()
  await pool('platform').query(`INSERT INTO policies(policy_id,company_id,role_id,dimension,resource_code,actions,data_scopes,field_visibility)
    SELECT $1,$2,role_id,'FIELD','title','{}','{}','HIDDEN' FROM role_members WHERE company_id=$2 AND user_id=$3 LIMIT 1`,[policy,A.company,A.alice])
  try{
    const output=await lookup(link,idempotencyKey)
    assert.equal(output.status,403);assert.deepEqual(output.body,{error:'KVVI_NOT_ALLOWED'})
    assert.equal(JSON.stringify(output).includes('title'),false)
  }finally{await pool('platform').query("UPDATE policies SET field_visibility='VISIBLE' WHERE policy_id=$1",[policy])}
})
test('current row scope withholds the original receipt after a record transfer',async()=>{
  const {link,idempotencyKey,result}=await create()
  await adminQuery('kvvi_business','UPDATE business_records SET owner_id=$2,dept_id=$3,shop_id=$4 WHERE record_id=$1',[result.recordId,A.bob,A.otherDept,A.shop2])
  assert.deepEqual(await lookup(link,idempotencyKey),{status:403,body:{error:'KVVI_NOT_ALLOWED'}})
})
test('revoked signed links cannot recover or enumerate their former receipts',async()=>{
  const {link,idempotencyKey}=await create()
  await visitor.revokeLink({linkId:link.linkId,ctx:issuer.ctx})
  await assert.rejects(()=>lookup(link,idempotencyKey),error=>error.code==='KVVI_LINK_REVOKED')
})
test('lookup remains read-only when projection is still pending and admission is closed',async()=>{
  await adminQuery('kvvi_platform','REVOKE INSERT ON visitor_projection_receipts FROM kvvi_platform')
  let created
  try{created=await create();assert.equal(created.result.projectionPending,true)}
  finally{await adminQuery('kvvi_platform','GRANT INSERT ON visitor_projection_receipts TO kvvi_platform')}
  await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=false WHERE singleton')
  try{
    const before=(await adminQuery('kvvi_business','SELECT projection_attempts FROM visitor_submissions WHERE operation_id=$1',[created.result.operationId])).rows[0].projection_attempts
    const output=await lookup(created.link,created.idempotencyKey)
    assert.equal(output.body.state,'COMMITTED');assert.equal(output.body.projectionPending,true)
    assert.equal((await adminQuery('kvvi_business','SELECT projection_attempts FROM visitor_submissions WHERE operation_id=$1',[created.result.operationId])).rows[0].projection_attempts,before)
  }finally{await adminQuery('kvvi_business','UPDATE kvvi_visitor_private.config SET enabled=true WHERE singleton')}
})
test('receipt lookup succeeds with all submission/projection write privileges revoked',async()=>{
  const {link,idempotencyKey,result}=await create()
  await adminQuery('kvvi_platform','REVOKE INSERT,UPDATE ON visitor_links,visitor_link_events,visitor_projection_receipts,visitor_projection_scan FROM kvvi_platform')
  await adminQuery('kvvi_business','REVOKE INSERT,UPDATE ON record_write_operations,visitor_submissions FROM kvvi_business')
  try{
    assert.equal((await pool('business').query("SELECT has_table_privilege(current_user,'visitor_submissions','UPDATE') AS allowed")).rows[0].allowed,false)
    assert.equal((await lookup(link,idempotencyKey)).body.recordId,result.recordId)
    assert.equal((await lookup(link,randomUUID())).body.state,'UNKNOWN')
  }finally{
    await adminQuery('kvvi_platform','GRANT INSERT,UPDATE ON visitor_links,visitor_link_events,visitor_projection_receipts,visitor_projection_scan TO kvvi_platform')
    await adminQuery('kvvi_business','GRANT INSERT,UPDATE ON record_write_operations,visitor_submissions TO kvvi_business')
  }
})
test('a lookup rejected by revocation does not append rejection events',async()=>{
  const {link,idempotencyKey}=await create()
  await visitor.revokeLink({linkId:link.linkId,ctx:issuer.ctx})
  const before=(await pool('platform').query('SELECT count(*)::int n FROM visitor_link_events WHERE link_id=$1',[link.linkId])).rows[0].n
  await assert.rejects(()=>lookup(link,idempotencyKey),error=>error.code==='KVVI_LINK_REVOKED')
  assert.equal((await pool('platform').query('SELECT count(*)::int n FROM visitor_link_events WHERE link_id=$1',[link.linkId])).rows[0].n,before)
})
test('an in-flight original key wait is bounded and its error retains only the external original key',async()=>{
  const {link,idempotencyKey}=await create(),client=await pool('business').connect()
  await client.query('BEGIN')
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['record-write',A.company,A.alice,`VISITOR /links/${link.linkId}`,`visitor.v1.${idempotencyKey}`])])
  const started=Date.now()
  try{
    await assert.rejects(()=>lookup(link,idempotencyKey),error=>error.code==='KVVI_OPERATION_OUTCOME_UNKNOWN'&&error.key===idempotencyKey)
    assert.ok(Date.now()-started<8000)
  }finally{await client.query('COMMIT');client.release()}
  assert.equal((await lookup(link,idempotencyKey)).body.state,'COMMITTED')
})

import {before,after,test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {A,resetDatabase,makeSession,grantBaseline,adminQuery,pool,closeAll} from './harness.mjs'
import {issueLink,submitAsVisitor,revokeLink,verifyLinkSignature} from '../src/visitor.mjs'
let issuer,other
before(async()=>{
  await resetDatabase();await grantBaseline(A.alice)
  issuer=await makeSession(A.alice,A.company);other=await makeSession(A.bob,A.company)
})
after(closeAll)
const link=()=>issueLink({ctx:issuer.ctx,formCode:'general_item',schemaCode:'general_item',fields:['title'],actions:['create'],rowScope:{},maxSubmissions:2})
test('new links bind protocol, capacity, company and issuer in the verified signature',async()=>{
  const result=await link(),verified=verifyLinkSignature(result.token)
  assert.equal(verified.ok,true)
  assert.equal(verified.body.protocol,'kvvi-visitor/v2')
  assert.equal(verified.body.maxSubmissions,2)
  assert.equal(verified.body.companyId,A.company);assert.equal(verified.body.issuerUserId,A.alice)
})
test('the permanent database default classifies unqualified insertions as legacy',async()=>{
  const result=await link()
  const row=(await pool('platform').query(`INSERT INTO visitor_links(link_id,token_digest,nonce,company_id,schema_code,form_code,
    allowed_fields,allowed_actions,row_scope,issuer_user_id,issuer_authz_version,expires_at)
    SELECT $2,$3,$4,company_id,schema_code,form_code,allowed_fields,allowed_actions,row_scope,issuer_user_id,issuer_authz_version,expires_at
    FROM visitor_links WHERE link_id=$1 RETURNING submission_protocol`,[result.linkId,randomUUID(),randomUUID(),randomUUID()])).rows[0]
  assert.equal(row.submission_protocol,'legacy-unknown')
})
test('a colleague in the same company cannot revoke the issuer’s link',async()=>{
  const result=await link()
  assert.equal(await revokeLink({ctx:other.ctx,linkId:result.linkId}),false)
  assert.equal((await pool('platform').query('SELECT revoked_at FROM visitor_links WHERE link_id=$1',[result.linkId])).rows[0].revoked_at,null)
  assert.equal(await revokeLink({ctx:issuer.ctx,linkId:result.linkId}),true)
})
for(const [name,change] of [
  ['capacity','max_submissions=max_submissions+1'],
  ['field binding',"allowed_fields=ARRAY['title','amount']"],
  ['row scope',"row_scope='{\"deptId\":\"a0000000-0000-4000-8000-0000000000d3\"}'::jsonb"],
  ['token digest',"token_digest='unregistered-token-digest'"],
])test('registered '+name+' cannot disagree with the signed link',async()=>{
  const result=await link()
  await pool('platform').query(`UPDATE visitor_links SET ${change} WHERE link_id=$1`,[result.linkId])
  await assert.rejects(()=>submitAsVisitor({token:result.token,idempotencyKey:randomUUID(),data:{title:'must not write'}}),error=>error.code==='KVVI_VISITOR_BINDING_CHANGED')
})
test('a legacy row is denied new effects even with a valid signature',async()=>{
  const result=await link()
  await pool('platform').query("UPDATE visitor_links SET submission_protocol='legacy-unknown' WHERE link_id=$1",[result.linkId])
  await assert.rejects(()=>submitAsVisitor({token:result.token,idempotencyKey:randomUUID(),data:{title:'must not write'}}),error=>error.code==='KVVI_VISITOR_LEGACY_LINK')
  assert.equal((await adminQuery('kvvi_business',"SELECT count(*)::int n FROM business_records WHERE data->>'title'='must not write'")).rows[0].n,0)
})

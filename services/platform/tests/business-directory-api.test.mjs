import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { A, adminQuery, closeAll, pool } from './harness.mjs'
import { directoryFixture, api } from './directory-fixture.mjs'
import { revokeBuilderAccess, grantBuilderAccess } from '../src/mode-policy.mjs'
let f
before(async()=>{ f=await directoryFixture() })
after(closeAll)
test('eligible USER mode and employee cannot write; active builder can',async()=>{
  for(const session of [f.userBuilder,f.employee]) {
    const res=await api(session,'POST','/business-groups',{name:'forbidden'})
    assert.equal(res.status,403); assert.equal(res.body.error,'KVVI_BUILDER_REQUIRED')
  }
  const denied=await adminQuery('kvvi_audit',"SELECT count(*)::int n FROM audit_entries WHERE action='directory.denied' AND outcome='DENY'")
  assert.equal(denied.rows[0].n,2)
  assert.equal((await api(f.builder,'POST','/business-groups',{name:'sales'})).status,200)
})
test('idempotent create, version conflicts and group deletion preserve records',async()=>{
  const operationId=randomUUID()
  const first=await api(f.builder,'POST','/business-groups',{name:'orders'},operationId)
  assert.equal(first.status,200)
  const group=first.body.result
  const retry=await api(f.builder,'POST','/business-groups',{name:'orders'},operationId)
  assert.deepEqual(retry.body.result,group)
  assert.equal((await api(f.builder,'POST','/business-groups',{name:'changed'},operationId)).status,409)
  const move=await api(f.builder,'PATCH','/business-forms/general_item/group',{groupId:group.groupId,expectedVersion:0})
  assert.equal(move.status,200); assert.equal(move.body.result.version,1)
  assert.equal((await api(f.builder,'PATCH','/business-groups/'+group.groupId,{name:'renamed',expectedVersion:0})).status,409)
  const before=(await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows
  assert.equal((await api(f.builder,'DELETE','/business-groups/'+group.groupId,{expectedVersion:1})).status,200)
  const dir=await api(f.builder,'GET','/business-directory')
  assert.equal(dir.body.forms.find(x=>x.assetId==='general_item').groupId,null)
  assert.deepEqual((await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows,before)
})
test('company foreign groups/forms cannot be read or mutated; identity body is ignored',async()=>{
  const b=await api(f.other,'POST','/business-groups',{name:'B secret'})
  assert.equal(b.status,200)
  assert.equal((await api(f.builder,'PATCH','/business-groups/'+b.body.result.groupId,{name:'stolen',expectedVersion:1})).status,404)
  const dir=await api(f.builder,'GET','/business-directory')
  assert.equal(dir.body.groups.some(x=>x.name==='B secret'),false)
  assert.equal((await api(f.other,'PATCH','/business-forms/general_item/group',{groupId:null,expectedVersion:0,companyId:A.company})).status,404)
  assert.equal((await api(f.builder,'PATCH','/business-forms/hidden_item/group',{groupId:b.body.result.groupId,expectedVersion:0})).status,404)
})
test('create-only employee sees entry but not hidden forms or empty groups; legacy version is zero',async()=>{
  const dir=await api(f.employee,'GET','/business-directory')
  assert.equal(dir.status,200)
  assert.deepEqual(dir.body.forms.map(x=>x.assetId),['general_item'])
  assert.deepEqual(dir.body.forms[0].actions,['create'])
  assert.deepEqual(dir.body.groups,[])
  const builder=await api(f.builder,'GET','/business-directory')
  assert.equal(builder.body.forms.find(x=>x.assetId==='hidden_item').version,0)
  assert.equal((await api(f.employee,'GET','/business-directory?archived=true')).status,403)
})
test('archive requires confirmation, excludes ordinary directory and restores identity',async()=>{
  assert.equal((await api(f.builder,'POST','/business-forms/hidden_item/archive',{expectedVersion:0})).status,400)
  assert.equal((await api(f.builder,'POST','/business-forms/hidden_item/archive',{expectedVersion:0,confirmed:true})).status,200)
  assert.equal((await api(f.builder,'GET','/business-directory')).body.forms.some(x=>x.assetId==='hidden_item'),false)
  const archived=await api(f.builder,'GET','/business-directory?archived=true')
  assert.deepEqual(archived.body.forms.map(x=>x.assetId),['hidden_item'])
  assert.equal((await api(f.builder,'POST','/business-forms/hidden_item/restore',{expectedVersion:1,confirmed:true})).status,200)
})
test('duplicate names and malformed identifiers fail without a database error',async()=>{
  assert.equal((await api(f.builder,'POST','/business-groups',{name:'sales'})).status,409)
  for(const name of ['', 'x'.repeat(81)]) assert.equal((await api(f.builder,'POST','/business-groups',{name})).status,400)
  assert.equal((await api(f.builder,'POST','/business-groups',{name:'valid'},'not-uuid')).status,400)
})
test('revoked builder cannot replay earlier authority',async()=>{
  await revokeBuilderAccess(f.owner.ctx,A.bob)
  const out=await api(f.builder,'POST','/business-groups',{name:'after revocation'})
  assert.ok([401,403].includes(out.status))
})

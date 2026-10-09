import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { A, adminQuery, closeAll } from './harness.mjs'
import { directoryFixture, api } from './directory-fixture.mjs'
import { flushDirectoryAudit } from '../src/business-directory-audit.mjs'
let f
before(async()=>{f=await directoryFixture()})
after(closeAll)
test('audit outage leaves committed result and durable receipt, later worker retries once',async()=>{
  const signature='audit_append(uuid,text,uuid,text,uuid,text,text,text,text,text,text,text)'
  await adminQuery('kvvi_audit',`REVOKE EXECUTE ON FUNCTION ${signature} FROM kvvi_audit_writer`)
  const operationId=randomUUID()
  try {
    const out=await api(f.builder,'POST','/business-groups',{name:'durable'},operationId)
    assert.equal(out.status,200); assert.equal(out.body.auditPending,true)
    const retry=await api(f.builder,'POST','/business-groups',{name:'durable'},operationId)
    assert.deepEqual(retry.body.result,out.body.result)
    assert.equal((await flushDirectoryAudit({limit:10})).pending,1)
    assert.equal((await adminQuery('kvvi_business','SELECT count(*)::int n FROM business_directory_operations WHERE operation_id=$1',[operationId])).rows[0].n,1)
  } finally {await adminQuery('kvvi_audit',`GRANT EXECUTE ON FUNCTION ${signature} TO kvvi_audit_writer`)}
  await closeAll() // recreate connections as after restart; receipt remains in DB
  assert.deepEqual(await flushDirectoryAudit({limit:10}),{delivered:1,pending:0})
  assert.deepEqual(await flushDirectoryAudit({limit:10}),{delivered:0,pending:0})
  assert.equal((await adminQuery('kvvi_audit','SELECT count(*)::int n FROM audit_entries WHERE resource_id=$1',[operationId])).rows[0].n,1)
})
test('concurrent same-key create has one result; deletion and regroup cannot orphan',async()=>{
  const id=randomUUID()
  const responses=await Promise.all(Array.from({length:6},()=>api(f.builder,'POST','/business-groups',{name:'concurrent'},id)))
  for(const r of responses) {assert.equal(r.status,200); assert.deepEqual(r.body.result,responses[0].body.result)}
  const groupId=responses[0].body.result.groupId
  const [move,del]=await Promise.all([
    api(f.builder,'PATCH','/business-forms/general_item/group',{groupId,expectedVersion:0}),
    api(f.builder,'DELETE','/business-groups/'+groupId,{expectedVersion:1})])
  assert.equal(del.status,200); assert.ok([200,404].includes(move.status))
  const dir=await api(f.builder,'GET','/business-directory')
  assert.equal(dir.body.forms.find(x=>x.assetId==='general_item').groupId,null)
})

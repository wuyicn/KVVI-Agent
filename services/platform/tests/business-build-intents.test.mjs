import { beforeEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { directoryFixture, api } from './directory-fixture.mjs'
import { A, pool, closeAll, adminQuery } from './harness.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
let f
beforeEach(async()=>{f=await directoryFixture()})
after(closeAll)
async function group() {return (await api(f.builder,'POST','/business-groups',{name:'目标分组'})).body.result}
async function intent(groupId=null,id=randomUUID()) {
  const r=await api(f.builder,'POST','/business-build-intents',{groupId},id)
  assert.equal(r.status,201); return r.body
}
async function draft(assetId='new_form') {
  return submitDraft({ctx:f.builder.ctx,change:{assetId,nonce:randomUUID()},diffReport:{faces:DIFF_FACES},invariant:{ok:true},payload:{assetId}})
}
async function attach(i,d) {return api(f.builder,'POST',`/business-build-intents/${i.intentId}/draft`,{draftId:d.draftId,expectedVersion:i.version})}
async function publish(d,assetId='new_form') {
  await approveDraft({ctx:f.owner.ctx,draftId:d.draftId,decision:'APPROVE'})
  return publishDraft({ctx:f.owner.ctx,draftId:d.draftId,apply:async()=>({}),system:{assetId,schemaCode:assetId,name:'同名表单'}})
}
test('intent creation requires active builder authority and is idempotent with company scoped groups',async()=>{
  const g=await group(),id=randomUUID(),i=await intent(g.groupId,id)
  assert.deepEqual(await intent(g.groupId,id),i)
  assert.equal((await api(f.userBuilder,'POST','/business-build-intents',{groupId:g.groupId})).status,403)
  assert.equal((await api(f.other,'POST','/business-build-intents',{groupId:g.groupId})).status,404)
  assert.equal((await api(f.builder,'POST','/business-build-intents',{groupId:null},id)).status,409)
})
test('draft binding cannot cross company, proposer, existing asset, or overwrite its first binding',async()=>{
  const i=await intent(),d=await draft()
  assert.equal((await api(f.other,'POST',`/business-build-intents/${i.intentId}/draft`,{draftId:d.draftId,expectedVersion:1})).status,404)
  assert.equal((await attach(i,d)).status,200)
  assert.equal((await attach(i,d)).status,200)
  assert.equal((await attach(i,await draft('other_form'))).status,409)
  const otherIntent=await intent(),existing=await draft('general_item')
  assert.equal((await attach(otherIntent,existing)).status,409)
})
test('only approved publication queues grouping; worker retries preserve identifiers and append one receipt',async()=>{
  const g=await group(),i=await intent(g.groupId),d=await draft()
  assert.equal((await attach(i,d)).status,200)
  assert.equal((await publishDraft({ctx:f.owner.ctx,draftId:d.draftId,apply:async()=>({})})).ok,false)
  assert.equal((await api(f.builder,'GET','/business-directory')).body.forms.some(v=>v.assetId==='new_form'),false)
  await publish(d)
  assert.equal((await pool('platform').query('SELECT state FROM business_build_intents WHERE intent_id=$1',[i.intentId])).rows[0].state,'PENDING')
  const { flushBuildIntents }=await import('../src/business-build-intents.mjs')
  await Promise.all([flushBuildIntents({limit:10}),flushBuildIntents({limit:10})])
  const forms=(await api(f.builder,'GET','/business-directory')).body.forms
  assert.equal(forms.find(v=>v.assetId==='new_form').groupId,g.groupId)
  await flushBuildIntents({limit:10})
  assert.equal((await pool('platform').query('SELECT state FROM business_build_intents WHERE intent_id=$1',[i.intentId])).rows[0].state,'DONE')
})
test('deleting the intended group falls back to ungrouped with an explicit reason',async()=>{
  const g=await group(),i=await intent(g.groupId),d=await draft()
  await attach(i,d); await api(f.builder,'DELETE',`/business-groups/${g.groupId}`,{expectedVersion:1}); await publish(d)
  const { flushBuildIntents }=await import('../src/business-build-intents.mjs')
  await flushBuildIntents({limit:10})
  const row=(await pool('platform').query('SELECT state,result FROM business_build_intents WHERE intent_id=$1',[i.intentId])).rows[0]
  assert.equal(row.state,'DONE');assert.equal(row.result.reason,'KVVI_GROUP_REMOVED');assert.equal(row.result.groupId,null)
})
test('creation replay survives group deletion and never creates another intent',async()=>{
  const g=await group(),id=randomUUID(),i=await intent(g.groupId,id)
  await api(f.builder,'DELETE',`/business-groups/${g.groupId}`,{expectedVersion:1})
  assert.deepEqual(await intent(g.groupId,id),i)
})
test('a rejected draft can be corrected with the same intent but cannot change its asset',async()=>{
  const i=await intent(),d=await draft()
  await attach(i,d)
  await approveDraft({ctx:f.owner.ctx,draftId:d.draftId,decision:'REJECT'})
  const wrong=await draft('different_form')
  assert.equal((await api(f.builder,'POST',`/business-build-intents/${i.intentId}/draft`,{draftId:wrong.draftId,expectedVersion:2})).status,409)
  const retry=await draft()
  assert.equal((await api(f.builder,'POST',`/business-build-intents/${i.intentId}/draft`,{draftId:retry.draftId,expectedVersion:2})).status,200)
  await publish(retry)
  const {flushBuildIntents}=await import('../src/business-build-intents.mjs')
  await flushBuildIntents()
  assert.equal((await api(f.builder,'GET',`/business-build-intents/${i.intentId}`)).body.state,'DONE')
})
test('compensation recovers when grouping committed but its platform receipt did not',async()=>{
  const g=await group(),i=await intent(g.groupId),d=await draft()
  await attach(i,d);await publish(d)
  const row=(await pool('platform').query('SELECT * FROM business_build_intents WHERE intent_id=$1',[i.intentId])).rows[0]
  const {initialisePublishedForm,directoryTransaction}=await import('../src/business-directory.mjs')
  await initialisePublishedForm(row)
  const {flushBuildIntents}=await import('../src/business-build-intents.mjs')
  await flushBuildIntents()
  const receipts=await directoryTransaction(A.company,c=>c.query('SELECT * FROM business_directory_operations WHERE operation_id=$1',[row.directory_operation_id]))
  assert.equal(receipts.rows.length,1)
  assert.equal((await api(f.builder,'GET',`/business-build-intents/${i.intentId}`)).body.state,'DONE')
})
test('failed initial placement does not starve the independent audit retry',async()=>{
  const g=await group(),i=await intent(g.groupId),d=await draft()
  await attach(i,d);await publish(d)
  const {initialisePublishedForm}=await import('../src/business-directory.mjs')
  const row=(await pool('platform').query('SELECT * FROM business_build_intents WHERE intent_id=$1',[i.intentId])).rows[0]
  await initialisePublishedForm(row)
  const d2=await draft('another_new_form'),i2=await intent()
  await attach(i2,d2);await publish(d2,'another_new_form')
  await adminQuery('kvvi_business','REVOKE INSERT ON business_form_directory FROM kvvi_business')
  try {
    const {retryDirectoryJobs}=await import('../src/business-build-intents.mjs')
    const outcomes=await retryDirectoryJobs()
    assert.equal(outcomes[0].status,'rejected')
    assert.equal(outcomes[1].status,'fulfilled')
    assert.equal(outcomes[1].value.pending,0)
  } finally {await adminQuery('kvvi_business','GRANT INSERT ON business_form_directory TO kvvi_business')}
})
test('delayed grouping never restores an archived form or overwrites manual organisation',async()=>{
  const g=await group(),i=await intent(g.groupId),d=await draft()
  await attach(i,d);await publish(d)
  assert.equal((await api(f.builder,'POST','/business-forms/new_form/archive',{expectedVersion:0,confirmed:true})).status,200)
  const { flushBuildIntents }=await import('../src/business-build-intents.mjs')
  await flushBuildIntents({limit:10})
  const form=(await api(f.builder,'GET','/business-directory?archived=true')).body.forms.find(v=>v.assetId==='new_form')
  assert.equal(form.archived,true);assert.equal(form.groupId,null);assert.equal(form.version,1)
})
test('publish submission atomically binds the supplied intent and rejects foreign intentions without leaving a draft',async()=>{
  const i=await intent()
  const contracts={'business-schema':{fields:[]},'view-schema':{componentsTree:[]},'workflow-spec':{states:[]},'permission-spec':{roles:[],policies:[]},'tool-spec':{tools:[]},'app-model-command':{commands:[]}}
  const submitted=await api(f.builder,'POST','/publish/drafts',{assetId:'ui_new_form',contracts,buildIntentId:i.intentId})
  assert.equal(submitted.status,201)
  const row=(await pool('platform').query('SELECT * FROM business_build_intents WHERE intent_id=$1',[i.intentId])).rows[0]
  assert.equal(row.draft_id,submitted.body.draftId);assert.equal(row.asset_id,'ui_new_form')
  await approveDraft({ctx:f.owner.ctx,draftId:submitted.body.draftId,decision:'REJECT'})
  const corrected=await api(f.builder,'POST','/publish/drafts',{assetId:'ui_new_form',contracts,buildIntentId:i.intentId})
  assert.equal(corrected.status,201)
  const before=Number((await pool('platform').query('SELECT count(*) AS n FROM publish_drafts')).rows[0].n)
  const refused=await api(f.other,'POST','/publish/drafts',{assetId:'foreign_form',contracts,buildIntentId:i.intentId})
  assert.equal(refused.status,404)
  assert.equal(Number((await pool('platform').query('SELECT count(*) AS n FROM publish_drafts')).rows[0].n),before)
})

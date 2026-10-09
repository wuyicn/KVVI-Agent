import { randomUUID } from 'node:crypto'
import { A, B, resetDatabase, grantPlatformRole, grantBaseline, makeSession, pool } from './harness.mjs'
import { grantBuilderAccess } from '../src/mode-policy.mjs'
import { submitDraft, approveDraft, publishDraft, DIFF_FACES } from '../src/publish.mjs'
import { handleApi } from '../src/api-router.mjs'
import { handleAuth } from '../src/auth.mjs'
export async function directoryFixture() {
  await resetDatabase()
  await grantPlatformRole(A.alice,'owner')
  await grantPlatformRole(B.dave,'owner',B.company)
  const owner=(await makeSession(A.alice,A.company,'BUILDER'))
  await grantBuilderAccess(owner.ctx,A.bob)
  const builder=await makeSession(A.bob,A.company,'BUILDER')
  const userBuilder=await makeSession(A.bob,A.company,'USER')
  const employee=await makeSession(A.carol,A.company,'USER')
  const other=await makeSession(B.dave,B.company,'BUILDER')
  for (const assetId of ['general_item','hidden_item']) {
    const d=await submitDraft({ctx:builder.ctx,change:{assetId},diffReport:{faces:DIFF_FACES},invariant:{ok:true}})
    await approveDraft({ctx:owner.ctx,draftId:d.draftId,decision:'APPROVE'})
    await publishDraft({ctx:owner.ctx,draftId:d.draftId,apply:async ({diffDigest})=>({diffDigest}),system:{assetId,schemaCode:assetId,name:assetId},contracts:[]})
  }
  const role=await grantBaseline(A.carol)
  await pool('platform').query("UPDATE policies SET actions='{create}' WHERE role_id=$1 AND dimension='FORM'",[role])
  return {owner,builder,userBuilder,employee,other}
}
export async function api(session,method,path,body,operationId=randomUUID()) {
  const url=new URL(path,'http://test')
  return handleApi({method,path:'/api/v1'+url.pathname,query:url.search,
    body:body===undefined?null:JSON.stringify(body),
    headers:{authorization:'Bearer '+session.raw,'idempotency-key':operationId},
    loadSession:token=>handleAuth({method:'GET',path:'/auth/session',body:null,headers:{authorization:'Bearer '+token}})})
}

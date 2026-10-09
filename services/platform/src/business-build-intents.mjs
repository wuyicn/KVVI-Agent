/** Durable publish-to-directory intent. Publication and grouping have separate commit points. */
import { pool, withTransaction } from './db.mjs'
import { DirectoryError, requireDirectoryBuilder, directoryTransaction, uuid, initialisePublishedForm } from './business-directory.mjs'
import { flushDirectoryAudit } from './business-directory-audit.mjs'
const fail=code=>{throw new DirectoryError(code)}
const publicIntent=row=>({intentId:row.intent_id,version:row.version,state:row.state,groupId:row.group_id,assetId:row.asset_id,result:row.result})

export async function createBuildIntent(ctx,{groupId=null,operationId}={}) {
  await requireDirectoryBuilder(ctx)
  if(!uuid(operationId)||(groupId!==null&&!uuid(groupId))) fail('KVVI_DIRECTORY_INVALID')
  // Do not hold a platform connection while waiting on business: directory writers use the reverse path.
  const existing=(await pool('platform').query('SELECT * FROM business_build_intents WHERE company_id=$1 AND intent_id=$2',[ctx.companyId,operationId])).rows[0]
  const replay=row=>{
    if(row.creator_id!==ctx.userId||row.group_id!==groupId) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
    return publicIntent(row)
  }
  if(existing) return replay(existing)
  if(groupId!==null) await directoryTransaction(ctx.companyId,async c=>{
    if(!(await c.query('SELECT 1 FROM business_groups WHERE company_id=$1 AND group_id=$2',[ctx.companyId,groupId])).rows.length) fail('KVVI_DIRECTORY_NOT_FOUND')
  })
  return withTransaction('platform',async c=>{
    await c.query('INSERT INTO business_build_intents(company_id,intent_id,creator_id,session_id,group_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[ctx.companyId,operationId,ctx.userId,ctx.sessionId,groupId])
    return replay((await c.query('SELECT * FROM business_build_intents WHERE company_id=$1 AND intent_id=$2',[ctx.companyId,operationId])).rows[0])
  })
}

/** Used inside the draft insert transaction, or by the explicit builder-only attach endpoint. */
export async function bindBuildIntent(client,ctx,{intentId,draftId,expectedVersion}) {
  if(!uuid(intentId)||!uuid(draftId)||(expectedVersion!==undefined&&!Number.isSafeInteger(expectedVersion))) fail('KVVI_DIRECTORY_INVALID')
  const row=(await client.query('SELECT * FROM business_build_intents WHERE company_id=$1 AND intent_id=$2 FOR UPDATE',[ctx.companyId,intentId])).rows[0]
  if(!row||row.creator_id!==ctx.userId) fail('KVVI_DIRECTORY_NOT_FOUND')
  if(row.draft_id===draftId) return publicIntent(row)
  if(expectedVersion!==undefined&&row.version!==expectedVersion) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
  const previous=row.draft_id?(await client.query('SELECT status FROM publish_drafts WHERE draft_id=$1 FOR UPDATE',[row.draft_id])).rows[0]:null
  if(row.state!=='CREATED'&&!(row.state==='BOUND'&&previous?.status==='REJECTED')) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
  const draft=(await client.query('SELECT * FROM publish_drafts WHERE company_id=$1 AND draft_id=$2 FOR UPDATE',[ctx.companyId,draftId])).rows[0]
  if(!draft||draft.proposer_user_id!==ctx.userId) fail('KVVI_DIRECTORY_NOT_FOUND')
  const assetId=draft.payload?.assetId
  if(row.asset_id!==null&&row.asset_id!==assetId) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
  if(!['DRAFT','AWAITING_APPROVAL'].includes(draft.status)||typeof assetId!=='string'||!assetId) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
  if((await client.query('SELECT 1 FROM systems WHERE company_id=$1 AND asset_id=$2',[ctx.companyId,assetId])).rows.length) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
  return publicIntent((await client.query("UPDATE business_build_intents SET draft_id=$3,asset_id=$4,state='BOUND',version=version+1 WHERE company_id=$1 AND intent_id=$2 RETURNING *",[ctx.companyId,intentId,draftId,assetId])).rows[0])
}
export async function attachBuildIntent(ctx,input) {
  await requireDirectoryBuilder(ctx)
  if(!Number.isSafeInteger(input.expectedVersion)) fail('KVVI_DIRECTORY_INVALID')
  return withTransaction('platform',c=>bindBuildIntent(c,ctx,input))
}

/** Only persisted, published intentions may perform initial placement. Never reuses an expired browser session. */
export async function flushBuildIntents({limit=20}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new TypeError('invalid limit')
  // Release platform resources before taking a business transaction. PENDING cannot rebind;
  // concurrent workers deduplicate in the durable business receipt, then compare-and-set DONE.
  const {rows}=await pool('platform').query(`SELECT i.* FROM business_build_intents i
    JOIN publish_drafts d ON d.draft_id=i.draft_id AND d.company_id=i.company_id
    WHERE i.state='PENDING' AND d.status='PUBLISHED' AND d.payload->>'assetId'=i.asset_id
    AND EXISTS(SELECT 1 FROM systems s WHERE s.company_id=i.company_id AND s.asset_id=i.asset_id)
    ORDER BY i.created_at LIMIT $1`,[limit])
  let delivered=0
  for(const row of rows) {
    const result=await initialisePublishedForm(row)
    const updated=await pool('platform').query("UPDATE business_build_intents SET state='DONE',result=$3,version=version+1 WHERE company_id=$1 AND intent_id=$2 AND state='PENDING' AND draft_id=$4",[row.company_id,row.intent_id,result,row.draft_id])
    delivered+=updated.rowCount
  }
  return {delivered}
}
export async function buildIntentsPending() {
  return Number((await pool('platform').query("SELECT count(*) AS n FROM business_build_intents WHERE state='PENDING'")).rows[0].n)
}
/** Independent jobs settle separately: failed publication placement must not starve audit delivery. */
export function retryDirectoryJobs() {
  return Promise.allSettled([flushBuildIntents({limit:20}),flushDirectoryAudit({limit:20})])
}
export async function buildIntentRoutes({method,path,payload,session,headers}) {
  try {
    if(method==='POST'&&path==='/business-build-intents') return {status:201,body:await createBuildIntent(session,{groupId:payload?.groupId??null,operationId:headers['idempotency-key']})}
    const match=/^\/business-build-intents\/([^/]+)(\/draft)?$/u.exec(path)
    if(match&&method==='POST'&&match[2]) return {status:200,body:await attachBuildIntent(session,{intentId:match[1],draftId:payload?.draftId,expectedVersion:payload?.expectedVersion})}
    if(match&&method==='GET'&&!match[2]) {
      await requireDirectoryBuilder(session)
      if(!uuid(match[1])) fail('KVVI_DIRECTORY_INVALID')
      const row=(await pool('platform').query('SELECT * FROM business_build_intents WHERE company_id=$1 AND creator_id=$2 AND intent_id=$3',[session.companyId,session.userId,match[1]])).rows[0]
      if(!row) fail('KVVI_DIRECTORY_NOT_FOUND')
      return {status:200,body:publicIntent(row)}
    }
    return {status:404,body:{error:'KVVI_UNKNOWN_ROUTE'}}
  } catch(error) {
    if(error instanceof DirectoryError) return {status:error.code==='KVVI_BUILDER_REQUIRED'?403:error.code==='KVVI_DIRECTORY_NOT_FOUND'?404:error.code==='KVVI_DIRECTORY_VERSION_CONFLICT'?409:400,body:{error:error.code}}
    throw error
  }
}

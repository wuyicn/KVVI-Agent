import { randomUUID } from 'node:crypto'
import { withTransaction } from './db.mjs'
import { allowedGateways } from './mode-policy.mjs'
import { loadSession } from './identity.mjs'
import { canAct } from './authorization.mjs'
import { publishedSystems } from './publish.mjs'
import { digestOf } from './audit.mjs'
import { lockFormLifecycle } from './business-lifecycle.mjs'

export class DirectoryError extends Error {
  constructor(code) { super(code); this.code=code }
}
const fail=code=>{throw new DirectoryError(code)}
const invalid=()=>fail('KVVI_DIRECTORY_INVALID')
export const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
export async function isDirectoryBuilder(ctx) {
  if (ctx?.gateway!=='BUILDER' || !uuid(ctx.sessionId)) return false
  const live=await loadSession(ctx.sessionId)
  return live?.state==='ACTIVE' && live.userStatus==='ACTIVE'
    && live.companyId===ctx.companyId && live.userId===ctx.userId && live.gateway==='BUILDER'
    && live.authzVersion===live.currentAuthzVersion
    && (await allowedGateways(ctx.companyId,ctx.userId)).includes('BUILDER')
}
export async function requireDirectoryBuilder(ctx) {
  if (!await isDirectoryBuilder(ctx)) fail('KVVI_BUILDER_REQUIRED')
}
export async function directoryTransaction(companyId, fn) {
  return withTransaction('business',async c=>{
    await c.query("SELECT set_config('kvvi.company_id',$1,true)",[companyId])
    return fn(c)
  })
}
const groupOf=r=>({groupId:r.group_id,name:r.name,position:r.position,version:r.version})

/** Internal compensation from a validated, immutable PENDING published intent; no platform connection held. */
export async function initialisePublishedForm(intent) {
  const {company_id:companyId,directory_operation_id:operationId,asset_id:assetId,group_id:requested,creator_id:actorId,session_id:sessionId}=intent
  const digest=digestOf({intentId:intent.intent_id,operationId,actorId,assetId,groupId:requested})
  return directoryTransaction(companyId,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['directory:'+companyId])
    const old=(await c.query('SELECT * FROM business_directory_operations WHERE company_id=$1 AND operation_id=$2',[companyId,operationId])).rows[0]
    if(old) {
      if(old.action!=='publish.assign'||old.actor_id!==actorId||old.request_digest!==digest) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
      return old.result
    }
    await lockFormLifecycle(c,companyId,assetId,'read')
    const meta=(await c.query('SELECT * FROM business_form_directory WHERE company_id=$1 AND asset_id=$2',[companyId,assetId])).rows[0]
    const groupExists=requested===null||(await c.query('SELECT 1 FROM business_groups WHERE company_id=$1 AND group_id=$2',[companyId,requested])).rows.length>0
    const groupId=meta?meta.group_id:groupExists?requested:null
    if(!meta) await c.query('INSERT INTO business_form_directory(company_id,asset_id,group_id) VALUES($1,$2,$3)',[companyId,assetId,groupId])
    const result={assetId,groupId,version:meta?.version??1,reason:meta?'KVVI_DIRECTORY_ALREADY_MANAGED':groupExists?null:'KVVI_GROUP_REMOVED'}
    const audit={companyId,actorKind:'USER',actorId,gateway:'BUILDER',sessionId,action:'directory.publish.assign',resourceKind:'DIRECTORY_OPERATION',resourceId:operationId,outcome:'ALLOW',paramsDigest:digest,resultDigest:digestOf(result)}
    await c.query('INSERT INTO business_directory_operations(company_id,operation_id,actor_id,action,request_digest,result,audit_payload) VALUES($1,$2,$3,$4,$5,$6,$7)',[companyId,operationId,actorId,'publish.assign',digest,result,audit])
    return result
  })
}

export async function readDirectory(ctx,{archived=false}={}) {
  const builder=await isDirectoryBuilder(ctx)
  if(archived && !builder) fail('KVVI_BUILDER_REQUIRED')
  const systems=await publishedSystems(ctx.companyId)
  const {groups,metadata}=await directoryTransaction(ctx.companyId,async c=>({
    groups:(await c.query('SELECT * FROM business_groups WHERE company_id=$1 ORDER BY position,name,group_id',[ctx.companyId])).rows.map(groupOf),
    metadata:(await c.query('SELECT * FROM business_form_directory WHERE company_id=$1',[ctx.companyId])).rows,
  }))
  const entries=new Map(metadata.map(r=>[r.asset_id,r]))
  const forms=[]
  for(const system of systems) {
    const meta=entries.get(system.assetId)
    if(Boolean(meta?.archived_at)!==archived) continue
    const actions=[]
    for(const action of ['create','read','update']) if(await canAct(ctx.companyId,ctx.userId,'FORM',system.assetId,action)) actions.push(action)
    if(!builder && !actions.length) continue
    forms.push({...system,groupId:meta?.group_id??null,archived,version:meta?.version??0,actions})
  }
  const visibleGroups=new Set(forms.map(f=>f.groupId))
  return {groups:builder?groups:groups.filter(g=>visibleGroups.has(g.groupId)),forms}
}

function normalize(input) {
  const {operationId,action,target=null,expectedVersion=null,payload={}}=input??{}
  if(!uuid(operationId)) invalid()
  if(!['group.create','group.rename','group.delete','form.move','form.archive','form.restore'].includes(action)) invalid()
  if(action!=='group.create' && (!Number.isSafeInteger(expectedVersion)||expectedVersion<0)) invalid()
  if(action.startsWith('group.')&&action!=='group.create'&&!uuid(target)) invalid()
  if(action.startsWith('form.')&&(typeof target!=='string'||!target||target.length>200)) invalid()
  const args={}
  if(['group.create','group.rename'].includes(action)) {
    if(typeof payload.name!=='string') invalid()
    args.name=payload.name.trim()
    if(!args.name || [...args.name].length>80) invalid()
  }
  if(action==='form.move') {
    if(payload.groupId!==null&&!uuid(payload.groupId)) invalid()
    args.groupId=payload.groupId
  }
  if(['form.archive','form.restore'].includes(action)&&payload.confirmed!==true) invalid()
  return {operationId,action,target,expectedVersion,payload:args}
}

export async function mutateDirectory(ctx,input) {
  await requireDirectoryBuilder(ctx) // before target validation/existence, never trusts client mode flags
  const command=normalize(input)
  const {operationId,action,target,expectedVersion,payload}=command
  const digest=digestOf({actorId:ctx.userId,...command})
  try {
    return await directoryTransaction(ctx.companyId,async c=>{
      // Serialize rare directory writes per company: idempotency and group deletion share one order.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['directory:'+ctx.companyId])
      await requireDirectoryBuilder(ctx)
      const old=(await c.query('SELECT * FROM business_directory_operations WHERE company_id=$1 AND operation_id=$2',[ctx.companyId,operationId])).rows[0]
      if(old) {
        if(old.request_digest!==digest) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
        return {result:old.result,auditPending:old.audit_delivered_at===null}
      }
      let result
      if(action==='group.create') {
        result=groupOf((await c.query('INSERT INTO business_groups(company_id,group_id,name) VALUES($1,$2,$3) RETURNING *',[ctx.companyId,randomUUID(),payload.name])).rows[0])
      } else if(action.startsWith('group.')) {
        const group=(await c.query('SELECT * FROM business_groups WHERE company_id=$1 AND group_id=$2 FOR UPDATE',[ctx.companyId,target])).rows[0]
        if(!group) fail('KVVI_DIRECTORY_NOT_FOUND')
        if(group.version!==expectedVersion) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
        if(action==='group.rename') result=groupOf((await c.query('UPDATE business_groups SET name=$3,version=version+1,updated_at=now() WHERE company_id=$1 AND group_id=$2 RETURNING *',[ctx.companyId,target,payload.name])).rows[0])
        else {
          await c.query('UPDATE business_form_directory SET group_id=NULL,version=version+1 WHERE company_id=$1 AND group_id=$2',[ctx.companyId,target])
          await c.query('DELETE FROM business_groups WHERE company_id=$1 AND group_id=$2',[ctx.companyId,target])
          result={groupId:target,deleted:true}
        }
      } else {
        if(!(await publishedSystems(ctx.companyId)).some(s=>s.assetId===target)) fail('KVVI_DIRECTORY_NOT_FOUND')
        await lockFormLifecycle(c,ctx.companyId,target,action==='form.move'?'read':'archive')
        const meta=(await c.query('SELECT * FROM business_form_directory WHERE company_id=$1 AND asset_id=$2 FOR UPDATE',[ctx.companyId,target])).rows[0]
        if((meta?.version??0)!==expectedVersion) fail('KVVI_DIRECTORY_VERSION_CONFLICT')
        let groupId=meta?.group_id??null, archived=Boolean(meta?.archived_at)
        if(action==='form.move') {
          groupId=payload.groupId
          if(groupId!==null && !(await c.query('SELECT 1 FROM business_groups WHERE company_id=$1 AND group_id=$2',[ctx.companyId,groupId])).rows.length) fail('KVVI_DIRECTORY_NOT_FOUND')
        } else archived=action==='form.archive'
        const row=(await c.query(`INSERT INTO business_form_directory(company_id,asset_id,group_id,archived_at,archived_by,version)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,asset_id) DO UPDATE SET group_id=EXCLUDED.group_id,
          archived_at=EXCLUDED.archived_at,archived_by=EXCLUDED.archived_by,version=EXCLUDED.version RETURNING *`,
          [ctx.companyId,target,groupId,archived?(meta?.archived_at??new Date()):null,archived?(meta?.archived_by??ctx.userId):null,expectedVersion+1])).rows[0]
        result={assetId:target,groupId:row.group_id,archived:row.archived_at!==null,version:row.version}
      }
      const audit={companyId:ctx.companyId,actorKind:'USER',actorId:ctx.userId,gateway:ctx.gateway,sessionId:ctx.sessionId,
        action:'directory.'+action,resourceKind:'DIRECTORY_OPERATION',resourceId:operationId,outcome:'ALLOW',paramsDigest:digest,resultDigest:digestOf({operationId,result})}
      await c.query('INSERT INTO business_directory_operations(company_id,operation_id,actor_id,action,request_digest,result,audit_payload) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.companyId,operationId,ctx.userId,action,digest,result,audit])
      return {result,auditPending:true}
    })
  } catch(error) {
    if(error.code==='23505' && error.constraint==='business_groups_company_id_name_key') fail('KVVI_GROUP_NAME_EXISTS')
    throw error
  }
}

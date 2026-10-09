import { withTransaction } from './db.mjs'

export class FormArchivedError extends Error {
  constructor() { super('KVVI_FORM_ARCHIVED'); this.code='KVVI_FORM_ARCHIVED' }
}
/** Always called inside the business transaction; lock survives until commit/rollback. */
export async function lockFormLifecycle(client,companyId,assetId,mode='read') {
  if(!companyId || typeof assetId!=='string' || !assetId) throw new Error('KVVI_DIRECTORY_INVALID')
  const fn=mode==='archive'?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'
  await client.query(`SELECT ${fn}(hashtextextended($1,0))`,[JSON.stringify(['form-lifecycle',companyId,assetId])])
}
export async function assertFormActive(client,companyId,assetId) {
  const {rows}=await client.query('SELECT archived_at FROM business_form_directory WHERE company_id=$1 AND asset_id=$2',[companyId,assetId])
  if(rows[0]?.archived_at) throw new FormArchivedError()
}
export async function withActiveForm(companyId,assetId,fn) {
  return withTransaction('business',async c=>{
    await c.query("SELECT set_config('kvvi.company_id',$1,true)",[companyId])
    await lockFormLifecycle(c,companyId,assetId,'read')
    await assertFormActive(c,companyId,assetId)
    return fn(c)
  })
}

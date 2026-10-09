import { pool } from './db.mjs'
import { append } from './audit.mjs'
import { directoryTransaction } from './business-directory.mjs'

/** At-least-once, stable resourceId=operationId; a crash after append may duplicate that ID. */
export async function deliverDirectoryOperation(companyId, operationId) {
  try {
    return await directoryTransaction(companyId, async c=>{
      const row=(await c.query(`SELECT audit_payload,audit_delivered_at FROM business_directory_operations
        WHERE company_id=$1 AND operation_id=$2 FOR UPDATE`,[companyId,operationId])).rows[0]
      if(!row) return false
      if(row.audit_delivered_at!==null) return true
      await append(row.audit_payload)
      await c.query('UPDATE business_directory_operations SET audit_delivered_at=now() WHERE company_id=$1 AND operation_id=$2',[companyId,operationId])
      return true
    })
  } catch { return false } // committed business result remains successful; retry uses durable receipt
}

export async function directoryAuditPending() {
  const {rows}=await pool('platform').query('SELECT company_id FROM companies ORDER BY company_id')
  let pending=0
  for(const row of rows) pending+=await directoryTransaction(row.company_id,async c=>
    (await c.query('SELECT count(*)::int n FROM business_directory_operations WHERE company_id=$1 AND audit_delivered_at IS NULL',[row.company_id])).rows[0].n)
  return pending
}

export async function flushDirectoryAudit({limit=20}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('KVVI_DIRECTORY_INVALID')
  const {rows}=await pool('platform').query('SELECT company_id FROM companies ORDER BY company_id')
  const candidates=[]
  for(const row of rows) {
    const ops=await directoryTransaction(row.company_id,async c=>(await c.query(`SELECT operation_id,created_at FROM business_directory_operations
      WHERE company_id=$1 AND audit_delivered_at IS NULL ORDER BY created_at LIMIT $2`,[row.company_id,limit])).rows)
    candidates.push(...ops.map(op=>({...op,companyId:row.company_id})))
  }
  candidates.sort((a,b)=>a.created_at-b.created_at)
  let delivered=0
  for(const op of candidates.slice(0,limit)) if(await deliverDirectoryOperation(op.companyId,op.operation_id)) delivered++
  return {delivered,pending:await directoryAuditPending()}
}

import { randomUUID } from 'node:crypto'
import { pool, connectBefore, queryBefore } from './db.mjs'
import { append, digestOf } from './audit.mjs'

export class WriteOperationError extends Error {
  constructor(code, status, key) { super(code); this.code=code; this.status=status; this.key=key }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}
const companyScope = (client, companyId) => client.query("SELECT set_config('kvvi.company_id',$1,true)", [companyId])

/** The callback must use this client for all business effects; it returns {status,body,audit}. */
export async function writeOperation({ ctx, endpoint, key=randomUUID(), request, authorize, run }) {
  if (typeof key !== 'string' || !key || Buffer.byteLength(key)>256) {
    throw new WriteOperationError('KVVI_OPERATION_KEY_INVALID',400,key)
  }
  const digest=digestOf(canonical({ gateway:ctx.gateway, request }))
  const args=[ctx.companyId,ctx.userId,endpoint,key]
  const client=await pool('business').connect()
  let committing=false, broken=false, row
  try {
    await client.query('BEGIN')
    await companyScope(client,ctx.companyId)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['record-write',...args])])
    // A queued request or a replay also needs current permissions.
    const refusal=await authorize(client)
    if (refusal) { await client.query('ROLLBACK'); return refusal }
    row=(await client.query(`SELECT * FROM record_write_operations
      WHERE company_id=$1 AND actor_id=$2 AND endpoint=$3 AND idempotency_key=$4`,args)).rows[0]
    if (row) {
      if (row.request_digest!==digest) throw new WriteOperationError('KVVI_OPERATION_KEY_CONFLICT',409,key)
    } else {
      // Historical successes lack a payload digest/audit receipt. Never silently execute them again.
      const legacy=await pool('platform').query(`SELECT 1 FROM idempotency_keys
        WHERE company_id=$1 AND user_id=$2 AND endpoint=$3 AND idem_key=$4`,args)
      if (legacy.rows.length) throw new WriteOperationError('KVVI_OPERATION_LEGACY_RECEIPT',409,key)
      const operationId=randomUUID()
      const result=await run(client)
      if (result.status<200 || result.status>=300) { await client.query('ROLLBACK'); return result }
      if (!result.audit || result.audit.companyId!==ctx.companyId || result.audit.actorId!==ctx.userId) {
        throw new Error('KVVI_OPERATION_AUDIT_REQUIRED')
      }
      row=(await client.query(`INSERT INTO record_write_operations(company_id,actor_id,endpoint,idempotency_key,
        operation_id,request_digest,response,status_code,audit_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [...args,operationId,digest,result.body,result.status,{...result.audit,resultDigest:digestOf(canonical(result.body))}])).rows[0]
    }
    committing=true
    await client.query('COMMIT')
    committing=false
  } catch (error) {
    if (committing) {
      broken=true
      // COMMIT may have succeeded. The same key is the only permitted retry identity.
      throw new WriteOperationError('KVVI_OPERATION_OUTCOME_UNKNOWN',503,key)
    }
    try { await client.query('ROLLBACK') } catch { broken=true }
    throw error
  } finally { client.release(broken) }
  const delivered=await deliverWriteAudit(ctx.companyId,ctx.userId,row.operation_id)
  return {status:row.status_code,body:{...row.response,operationId:row.operation_id,auditPending:!delivered}}
}

async function deliveryTransaction(companyId,deadline,fn) {
  const client=await connectBefore('business',deadline)
  let broken=true
  const query=(text,values=[])=>{
    const remaining=deadline-Date.now()
    if (remaining<1) throw new Error('KVVI_AUDIT_DELIVERY_TIMEOUT')
    return client.query({text,values,query_timeout:remaining})
  }
  try {
    await query('BEGIN')
    await query("SELECT set_config('kvvi.company_id',$1,true)",[companyId])
    const result=await fn(query)
    await query('COMMIT')
    broken=false
    return result
  } finally { client.release(broken) }
}

/** Both the original payload and ID survive retries/relogin/restart. */
export async function deliverWriteAudit(companyId,actorId,operationId) {
  const deadline=Date.now()+5000

  try {
    const row=await deliveryTransaction(companyId,deadline,async query=>{
      const entry=(await query(`SELECT audit_payload,audit_delivered_at FROM record_write_operations
        WHERE company_id=$1 AND actor_id=$2 AND operation_id=$3 FOR UPDATE SKIP LOCKED`,[companyId,actorId,operationId])).rows[0]
      if (!entry || entry.audit_delivered_at!==null) return entry
      // Persist retry timing, then release the business connection before audit network I/O.
      await query(`UPDATE record_write_operations SET audit_attempts=audit_attempts+1,
        audit_next_attempt_at=now()+make_interval(secs=>least(300,5*power(2,least(audit_attempts,6)))::int)
        WHERE company_id=$1 AND actor_id=$2 AND operation_id=$3`,[companyId,actorId,operationId])
      return entry
    })
    if (!row) return false
    if (row.audit_delivered_at!==null) return true
    const remaining=deadline-Date.now()
    if (remaining<1) return false
    await append({...row.audit_payload,operationId},{queryTimeoutMs:remaining})
    await deliveryTransaction(companyId,deadline,query=>query(`UPDATE record_write_operations SET audit_delivered_at=now()
      WHERE company_id=$1 AND actor_id=$2 AND operation_id=$3`,[companyId,actorId,operationId]))
    return true
  } catch { return false } // never rerun the original business effect
}

async function pending(limit) {
  const deadline=Date.now()+5000
  const companies=(await queryBefore('platform','SELECT company_id FROM companies ORDER BY company_id',[],deadline)).rows
  const rows=[]
  let count=0
  for (const company of companies) {
    await deliveryTransaction(company.company_id,deadline,async query=>{
      count+=(await query(`SELECT count(*)::int n FROM record_write_operations
        WHERE company_id=$1 AND audit_delivered_at IS NULL`,[company.company_id])).rows[0].n
      if (limit) rows.push(...(await query(`SELECT company_id,actor_id,operation_id,created_at FROM record_write_operations
        WHERE company_id=$1 AND audit_delivered_at IS NULL AND audit_next_attempt_at<=now()
        ORDER BY audit_next_attempt_at,created_at,operation_id LIMIT $2`,[company.company_id,limit])).rows)
    })
  }
  return {count,rows}
}
export async function writeAuditPending() { return (await pending(0)).count }
export async function flushWriteAudit({limit=20}={}) {
  if (!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('KVVI_OPERATION_LIMIT_INVALID')
  const {rows}=await pending(limit)
  rows.sort((a,b)=>a.created_at-b.created_at || a.operation_id.localeCompare(b.operation_id))
  let delivered=0
  for (const row of rows.slice(0,limit)) if (await deliverWriteAudit(row.company_id,row.actor_id,row.operation_id)) delivered++
  return {delivered,pending:await writeAuditPending()}
}

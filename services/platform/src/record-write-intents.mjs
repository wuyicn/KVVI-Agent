import {randomUUID} from 'node:crypto'
import {pool} from './db.mjs'
import {WriteOperationError,writeRequestDigest,writeIntentKeyPrefix,saveWriteControlAudit,deliverWriteAudit} from './record-write-operations.mjs'

const error=(code,status=409,key)=>new WriteOperationError(code,status,key)
const view=(row,receipt,restricted=false)=>restricted?{
  state:receipt?'COMMITTED':row.status,idempotencyKey:row.idempotency_key,resultRestricted:true,
}:receipt?{
  state:'COMMITTED',idempotencyKey:row.idempotency_key,operationId:receipt.operation_id,
  statusCode:receipt.status_code,result:receipt.response,auditPending:receipt.audit_delivered_at===null,
}:{state:row.status,idempotencyKey:row.idempotency_key}

/** Durable coordination, without storing business values in a browser journal.
 * Actor/endpoint serializes prepare/ack/cancel. An existing key also takes the
 * exact business-write lock before observing its receipt or sealing it.
 */
export async function recordWriteIntent({ctx,endpoint,action,request,key,authorize}) {
  if (!['get','prepare','cancel','acknowledge'].includes(action)) throw error('KVVI_BAD_REQUEST',400)
  // Only a read or insert below can establish the server's durable key.
  if (action==='get'||action==='prepare') key=undefined
  if (['cancel','acknowledge'].includes(action) && (typeof key!=='string'||!key||Buffer.byteLength(key)>256)) {
    throw error('KVVI_OPERATION_KEY_INVALID',400,key)
  }
  const client=await pool('business').connect()
  const scope=[ctx.companyId,ctx.userId,endpoint]
  let result,controlOperationId,committing=false,broken=true
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('kvvi.company_id',$1,true),set_config('statement_timeout','5000',true)",[ctx.companyId])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['record-write-intent',...scope])])
    let row
    if (action==='get'||action==='prepare') {
      row=(await client.query(`SELECT * FROM record_write_intents WHERE company_id=$1 AND actor_id=$2 AND endpoint=$3
        AND status IN ('PREPARED','COMMITTED')`,scope)).rows[0]
    } else {
      row=(await client.query(`SELECT * FROM record_write_intents
        WHERE company_id=$1 AND actor_id=$2 AND endpoint=$3 AND idempotency_key=$4`,[...scope,key])).rows[0]
    }
    if (row) key=row.idempotency_key
    let receipt
    if (row) {
      if (row.gateway!==ctx.gateway) throw error('KVVI_NOT_ALLOWED',403,key)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['record-write',...scope,key])])
      // A writer may have completed while we waited on the key.
      row=(await client.query(`SELECT * FROM record_write_intents
        WHERE company_id=$1 AND actor_id=$2 AND endpoint=$3 AND idempotency_key=$4`,[...scope,key])).rows[0]
      receipt=(await client.query(`SELECT * FROM record_write_operations
        WHERE company_id=$1 AND actor_id=$2 AND endpoint=$3 AND idempotency_key=$4`,[...scope,key])).rows[0]
      if (receipt && receipt.request_digest!==row.request_digest) throw error('KVVI_OPERATION_KEY_CONFLICT',409,key)
    }
    const fields=row?.request_fields??Object.keys(request?.data??{})
    const refusal=await authorize(fields,client,receipt)
    // Revoked business access still hides the result. An authenticated owner
    // can seal/acknowledge their own metadata, so revocation cannot strand an
    // active key and block all later permitted work. No business run occurs.
    if (refusal && (!row || action==='prepare')) {
      await client.query('ROLLBACK');broken=false
      return {status:refusal.status,body:{error:'KVVI_NOT_ALLOWED'}}
    }
    if (action==='get') {
      result={status:200,body:row?view(row,receipt,Boolean(refusal)):{state:'EMPTY'}}
    } else if (action==='prepare') {
      const digest=writeRequestDigest(ctx,request)
      if (row && row.request_digest!==digest) throw error('KVVI_OPERATION_PENDING_DIFFERENT_INPUT',409,key)
      if (!row) {
        key=writeIntentKeyPrefix(ctx)+randomUUID()
        row=(await client.query(`INSERT INTO record_write_intents(company_id,actor_id,endpoint,idempotency_key,
          gateway,request_digest,request_fields,status) VALUES($1,$2,$3,$4,$5,$6,$7,'PREPARED') RETURNING *`,
          [...scope,key,ctx.gateway,digest,fields.slice().sort()])).rows[0]
        result={status:200,body:view(row)}
        controlOperationId=await saveWriteControlAudit(client,ctx,endpoint+' [prepare]',key,
          {requestDigest:digest},result.body,'record.write.prepare')
      } else result={status:200,body:view(row,receipt)}
    } else {
      if (!row) throw error('KVVI_OPERATION_INTENT_NOT_FOUND',404,key)
      if (action==='cancel') {
        if (receipt) result={status:200,body:view(row,receipt,Boolean(refusal))}
        else if (row.status==='CANCELED') result={status:200,body:view(row)}
        else if (row.status!=='PREPARED') throw error('KVVI_OPERATION_OUTCOME_UNKNOWN',503,key)
        else {
          await client.query(`UPDATE record_write_intents SET status='CANCELED',updated_at=now()
            WHERE company_id=$1 AND actor_id=$2 AND endpoint=$3 AND idempotency_key=$4`,[...scope,key])
          result={status:200,body:{state:'CANCELED',idempotencyKey:key}}
          controlOperationId=await saveWriteControlAudit(client,ctx,endpoint+' [cancel]',key,{},result.body,'record.write.cancel')
        }
      } else {
        if (!receipt) throw error('KVVI_OPERATION_NOT_COMMITTED',409,key)
        if (row.status==='CANCELED') throw error('KVVI_OPERATION_KEY_CONFLICT',409,key)
        if (row.status!=='ACKNOWLEDGED') {
          await client.query(`UPDATE record_write_intents SET status='ACKNOWLEDGED',updated_at=now()
            WHERE company_id=$1 AND actor_id=$2 AND endpoint=$3 AND idempotency_key=$4`,[...scope,key])
          result={status:200,body:{state:'ACKNOWLEDGED',idempotencyKey:key}}
          controlOperationId=await saveWriteControlAudit(client,ctx,endpoint+' [acknowledge]',key,{},result.body,'record.write.acknowledge')
        } else result={status:200,body:{state:'ACKNOWLEDGED',idempotencyKey:key}}
      }
    }
    committing=true
    await client.query('COMMIT');committing=false;broken=false
  } catch (failure) {
    if (committing||failure.code==='57014') throw error('KVVI_OPERATION_OUTCOME_UNKNOWN',503,key)
    throw failure
  } finally {client.release(broken)}
  if (controlOperationId) result.body.intentAuditPending=!await deliverWriteAudit(ctx.companyId,ctx.userId,controlOperationId)
  return result
}

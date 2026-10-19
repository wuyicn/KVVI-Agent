import {connectBefore,queryBefore} from './db.mjs'
import {writeRequestDigest} from './record-write-operations.mjs'

async function transaction(database,companyId,deadline,run){
  const client=await connectBefore(database,deadline)
  let broken=true
  const query=(text,values=[])=>{
    const remaining=deadline-Date.now()
    if(remaining<1)throw new Error('KVVI_VISITOR_PROJECTION_TIMEOUT')
    return client.query({text,values,query_timeout:remaining})
  }
  try{
    await query('BEGIN')
    await query("SELECT set_config('statement_timeout',$1,true)",[String(Math.max(1,deadline-Date.now()))])
    if(database==='business')await query("SELECT set_config('kvvi.company_id',$1,true)",[companyId])
    const result=await run(query)
    await query('COMMIT');broken=false
    return result
  }finally{client.release(broken)}
}
function payloadOf(row){
  const payload=row.projection_payload
  if(!payload||payload.companyId!==row.company_id||payload.issuerUserId!==row.issuer_id||payload.linkId!==row.link_id||payload.recordId!==row.record_id
    ||payload.admittedAt!==row.admitted_at.toISOString()||!Array.isArray(payload.fields)||!payload.fields.every(field=>typeof field==='string')
    ||(payload.sourceIp!==null&&typeof payload.sourceIp!=='string'))throw new Error('KVVI_VISITOR_PROJECTION_INVALID')
  return payload
}
/** Only projects a committed company journal; it never creates another business effect. */
export async function deliverVisitorProjection(companyId,operationId,{budgetMs=5000}={}){
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>5000)throw new Error('KVVI_VISITOR_PROJECTION_BUDGET_INVALID')
  const deadline=Date.now()+budgetMs
  try{
    const row=await transaction('business',companyId,deadline,async query=>{
      const entry=(await query(`SELECT * FROM visitor_submissions WHERE company_id=$1 AND operation_id=$2 FOR UPDATE SKIP LOCKED`,[companyId,operationId])).rows[0]
      if(!entry||entry.projected_at!==null)return entry
      await query(`UPDATE visitor_submissions SET projection_attempts=projection_attempts+1,
        projection_next_attempt_at=now()+make_interval(secs=>least(300,5*power(2,least(projection_attempts,6)))::int)
        WHERE company_id=$1 AND operation_id=$2`,[companyId,operationId])
      return entry
    })
    if(!row)return false
    if(row.projected_at!==null)return true
    const payload=payloadOf(row),digest=writeRequestDigest({gateway:'VISITOR'},{projection:payload})
    // The business connection is released before any platform I/O.
    await transaction('platform',companyId,deadline,async query=>{
      const inserted=await query(`INSERT INTO visitor_projection_receipts(company_id,operation_id,link_id,issuer_id,payload_digest)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(company_id,operation_id) DO NOTHING RETURNING operation_id`,[companyId,operationId,row.link_id,row.issuer_id,digest])
      if(!inserted.rows.length){
        const known=(await query('SELECT payload_digest FROM visitor_projection_receipts WHERE company_id=$1 AND operation_id=$2',[companyId,operationId])).rows[0]
        if(known?.payload_digest!==digest)throw new Error('KVVI_VISITOR_PROJECTION_CONFLICT')
        return
      }
      const link=await query(`UPDATE visitor_links SET submissions=submissions+1,
        used_at=CASE WHEN used_at IS NULL THEN $4::timestamptz ELSE least(used_at,$4::timestamptz) END
        WHERE company_id=$1 AND issuer_user_id=$2 AND link_id=$3 RETURNING link_id`,[companyId,row.issuer_id,row.link_id,row.admitted_at])
      if(link.rows.length!==1)throw new Error('KVVI_VISITOR_PROJECTION_LINK_MISSING')
      await query(`INSERT INTO visitor_link_events(link_id,company_id,issuer_user_id,kind,source_ip,at,detail,submission_id)
        VALUES($1,$2,$3,'SUBMITTED',$4,$5,$6,$7)`,[row.link_id,companyId,row.issuer_id,payload.sourceIp,row.admitted_at,{recordId:row.record_id,fields:payload.fields},operationId])
    })
    await transaction('business',companyId,deadline,query=>query(`UPDATE visitor_submissions SET projected_at=now()
      WHERE company_id=$1 AND operation_id=$2`,[companyId,operationId]))
    return true
  }catch{return false} // a lost platform COMMIT reply is retried through the platform receipt
}
async function pending(limit,deadline){
  const companies=(await queryBefore('platform','SELECT company_id FROM companies ORDER BY company_id',[],deadline)).rows
  let count=0
  const rows=[]
  for(const company of companies){
    await transaction('business',company.company_id,deadline,async query=>{
      count+=(await query('SELECT count(*)::int n FROM visitor_submissions WHERE company_id=$1 AND projected_at IS NULL',[company.company_id])).rows[0].n
      if(limit)rows.push(...(await query(`SELECT company_id,operation_id,admitted_at FROM visitor_submissions
        WHERE company_id=$1 AND projected_at IS NULL AND projection_next_attempt_at<=now()
        ORDER BY projection_next_attempt_at,admitted_at,operation_id LIMIT $2`,[company.company_id,limit])).rows)
    })
  }
  return {count,rows}
}
export async function visitorProjectionPending(){return (await pending(0,Date.now()+5000)).count}
async function nextCompany(deadline){
  return transaction('platform',null,deadline,async query=>{
    const cursor=(await query('SELECT last_company_id FROM visitor_projection_scan WHERE singleton FOR UPDATE SKIP LOCKED')).rows[0]
    if(!cursor)return null
    let company=(await query('SELECT company_id FROM companies WHERE $1::uuid IS NULL OR company_id>$1 ORDER BY company_id LIMIT 1',[cursor.last_company_id])).rows[0]
    if(!company)company=(await query('SELECT company_id FROM companies ORDER BY company_id LIMIT 1')).rows[0]
    if(!company)return null
    // Advance durably before entering a potentially unavailable company database.
    await query('UPDATE visitor_projection_scan SET last_company_id=$1 WHERE singleton',[company.company_id])
    return company.company_id
  })
}
export async function flushVisitorProjections({limit=20}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('KVVI_VISITOR_PROJECTION_LIMIT_INVALID')
  const deadline=Date.now()+5000,visited=new Set()
  let delivered=0,attempted=0
  while(Date.now()<deadline&&attempted<limit){
    let companyId
    try{companyId=await nextCompany(deadline)}catch{break}
    if(!companyId||visited.has(companyId))break
    visited.add(companyId)
    try{
      const rows=await transaction('business',companyId,deadline,async query=>(await query(`SELECT operation_id FROM visitor_submissions
        WHERE company_id=$1 AND projected_at IS NULL AND projection_next_attempt_at<=now()
        ORDER BY projection_next_attempt_at,admitted_at,operation_id LIMIT $2`,[companyId,limit-attempted])).rows)
      for(const row of rows){
        const remaining=deadline-Date.now()
        if(remaining<1)break
        attempted++
        if(await deliverVisitorProjection(companyId,row.operation_id,{budgetMs:remaining}))delivered++
      }
    }catch{ /* keep earlier progress; the cursor already moved past this company */ }
  }
  // Statistics are observational, never a prerequisite for delivering an earlier row.
  return {delivered,pending:await visitorProjectionPending().catch(()=>null)}
}

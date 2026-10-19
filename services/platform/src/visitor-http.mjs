import {isIP} from 'node:net'
import {submitAsVisitor,lookupVisitorSubmission,VisitorError} from './visitor.mjs'
import {WriteOperationError} from './record-write-operations.mjs'
import {RecordStateError} from './record-state.mjs'
import {FieldRuleError} from './field-rules.mjs'

export const VISITOR_HEADERS=Object.freeze({'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'})
export const isVisitorPath=path=>path==='/visitor'||path.startsWith('/visitor/')
const endpoints=new Set(['/visitor/submit','/visitor/receipt'])
const invalidLink=new Set(['KVVI_LINK_MALFORMED','KVVI_LINK_BAD_SIGNATURE','KVVI_LINK_ALG_UNSUPPORTED','KVVI_LINK_UNKNOWN_KEY','KVVI_LINK_UNKNOWN','KVVI_LINK_REPLAY'])

/** Capability-only transport: no browser session, caller identity, proxy header or body source is used. */
export async function handleVisitor({method,path,query='',headers={},body,sourceIp}){
  if(!endpoints.has(path))return {status:404,body:{error:'KVVI_NOT_FOUND'}}
  if(method!=='POST')return {status:405,body:{error:'KVVI_METHOD_NOT_ALLOWED'},headers:{allow:'POST'}}
  if(query)return {status:400,body:{error:'KVVI_VISITOR_QUERY_FORBIDDEN'}}
  if(!body||typeof body!=='object'||Array.isArray(body))return {status:400,body:{error:'KVVI_BAD_REQUEST'}}
  const allowed=path==='/visitor/submit'?['token','data']:['token']
  if(Object.keys(body).some(key=>!allowed.includes(key))||typeof body.token!=='string'
    ||(path==='/visitor/submit'&&!Object.hasOwn(body,'data')))return {status:400,body:{error:'KVVI_BAD_REQUEST'}}
  if(typeof sourceIp!=='string'||!isIP(sourceIp))return {status:503,body:{error:'KVVI_VISITOR_SOURCE_UNAVAILABLE'}}
  const source=sourceIp.startsWith('::ffff:')&&isIP(sourceIp.slice(7))===4?sourceIp.slice(7):sourceIp
  const input={token:body.token,idempotencyKey:headers['idempotency-key']}
  try{
    if(path==='/visitor/receipt')return await lookupVisitorSubmission(input)
    return {status:201,body:await submitAsVisitor({...input,data:body.data,sourceIp:source})}
  }catch(error){
    if(error instanceof WriteOperationError)return {status:error.status,body:{error:error.code,idempotencyKey:error.key,
      ...(error.code==='KVVI_OPERATION_OUTCOME_UNKNOWN'?{retryWithSameKey:true}:{})}}
    if(error instanceof VisitorError){
      if(invalidLink.has(error.code))return {status:401,body:{error:'KVVI_VISITOR_LINK_INVALID'}}
      const status=error.code.startsWith('KVVI_RATE_LIMITED')?429:
        error.code==='KVVI_VISITOR_CUTOVER_REQUIRED'||error.code==='KVVI_LINK_STATUS_UNAVAILABLE'?503:
        error.code==='KVVI_OPERATION_KEY_INVALID'||error.code==='KVVI_VISITOR_SOURCE_INVALID'?400:403
      return {status,body:{error:error.code}}
    }
    if(error instanceof RecordStateError||error instanceof FieldRuleError)return {status:error.status??400,body:{error:error.code}}
    if(error.code==='KVVI_FORM_ARCHIVED')return {status:409,body:{error:error.code}}
    if(error.code==='KVVI_RUNTIME_CONTRACT_INCOMPLETE')return {status:503,body:{error:error.code}}
    if(error.message==='KVVI_CONTRACT_CONTENT_TAMPERED')return {status:409,body:{error:'KVVI_CONTRACT_CONTENT_TAMPERED'}}
    console.error(JSON.stringify({event:'visitor-request-unavailable'}))
    return {status:500,body:{error:'KVVI_INTERNAL_ERROR'}}
  }
}

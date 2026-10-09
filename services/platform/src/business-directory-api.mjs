import { readDirectory, mutateDirectory, DirectoryError } from './business-directory.mjs'
import { deliverDirectoryOperation } from './business-directory-audit.mjs'
import { appendDenial, digestOf } from './audit.mjs'
const statuses={KVVI_BUILDER_REQUIRED:403,KVVI_DIRECTORY_NOT_FOUND:404,KVVI_DIRECTORY_VERSION_CONFLICT:409,KVVI_GROUP_NAME_EXISTS:409,KVVI_DIRECTORY_INVALID:400,KVVI_FORM_ARCHIVED:409}
export async function directoryRoutes({method,path,query='',payload,session,headers}) {
  try {
    if(path==='/business-directory'&&method==='GET') {
      return {status:200,body:await readDirectory(session,{archived:new URLSearchParams(query).get('archived')==='true'})}
    }
    let action,target
    const parts=path.split('/').filter(Boolean).map(decodeURIComponent)
    if(parts[0]==='business-groups') {
      if(parts.length===1&&method==='POST') action='group.create'
      if(parts.length===2&&method==='PATCH') action='group.rename'
      if(parts.length===2&&method==='DELETE') action='group.delete'
      target=parts[1]
    }
    if(parts[0]==='business-forms'&&parts.length===3) {
      if(parts[2]==='group'&&method==='PATCH') action='form.move'
      if(['archive','restore'].includes(parts[2])&&method==='POST') action='form.'+parts[2]
      target=parts[1]
    }
    if(!action) return {status:404,body:{error:'KVVI_UNKNOWN_ROUTE'}}
    const body=await mutateDirectory(session,{operationId:headers['idempotency-key'],action,target,expectedVersion:payload?.expectedVersion,payload:payload??{}})
    body.auditPending=!await deliverDirectoryOperation(session.companyId,headers['idempotency-key'])
    return {status:200,body}
  } catch(error) {
    if(error instanceof DirectoryError) {
      await appendDenial({companyId:session.companyId,actorKind:'USER',actorId:session.userId,
        gateway:session.gateway,sessionId:session.sessionId??null,action:'directory.denied',
        reason:error.code,paramsDigest:digestOf({method,path})}).catch(()=>{})
      return {status:statuses[error.code]??400,body:{error:error.code}}
    }
    if(error instanceof URIError) return {status:400,body:{error:'KVVI_DIRECTORY_INVALID'}}
    throw error
  }
}

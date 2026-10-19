import {vi} from 'vitest'
export const entrance={companyId:'company',userId:'user',sessionId:'session',gateway:'USER'}
export const entranceIdentity=JSON.stringify(Object.values(entrance))
/** Protocol-aware server around each test's business responses, with receipts
 * retained across fresh stores. The business handler receives business writes
 * only; protocol routes are explicit rather than positional response mocks. */
export function businessFetch(handler:(url:string,init?:RequestInit)=>Promise<Response>) {
  type Receipt={state:'COMMITTED';idempotencyKey:string;operationId:string;statusCode:number;result:unknown;auditPending:boolean}
  const active=new Map<string,{state:'PREPARED';idempotencyKey:string;body:unknown}|Receipt>()
  const receipts=new Map<string,Receipt>()
  let sequence=0,lose=false,currentEntrance={...entrance}
  const businessPath=(base:string)=>base.includes('/records/')?base.replace(/\/write-intent$/u,''):base.replace(/\/write-intent$/u,'/records')
  const fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
    const namespace=JSON.stringify([currentEntrance.companyId,currentEntrance.userId,currentEntrance.gateway])
    const scoped=(path:string)=>namespace+':'+path
    const key=new Headers(init?.headers).get('idempotency-key')
    if(url==='/auth/session')return Response.json(currentEntrance)
    if(url.endsWith('/write-receipt')) {
      const endpoint=businessPath(url.replace(/\/write-receipt$/u,'/write-intent')),receipt=receipts.get(scoped(endpoint)+':'+key)
      return receipt?Response.json(receipt):Response.json({state:'UNKNOWN',idempotencyKey:key,retryWithSameKey:true},{status:202})
    }
    const control=url.match(/^(.*\/write-intent)\/(cancel|acknowledge)$/u)
    if(control){
      const endpoint=businessPath(control[1]!),receipt=receipts.get(scoped(endpoint)+':'+key)
      if(control[2]==='cancel'&&receipt)return Response.json(receipt)
      if(control[2]==='acknowledge'&&!receipt)return Response.json({error:'KVVI_OPERATION_NOT_COMMITTED'},{status:409})
      active.delete(scoped(endpoint));return Response.json({state:control[2]==='cancel'?'CANCELED':'ACKNOWLEDGED',idempotencyKey:key})
    }
    if(url.endsWith('/write-intent')){
      const endpoint=businessPath(url),previous=active.get(scoped(endpoint))
      const visible=previous?.state==='PREPARED'?{state:previous.state,idempotencyKey:previous.idempotencyKey}:previous
      if(init?.method==='GET')return Response.json(visible??{state:'EMPTY'})
      if(previous)return Response.json(visible)
      const prepared={state:'PREPARED' as const,idempotencyKey:'prepared-'+(++sequence),body:JSON.parse(String(init?.body))}
      active.set(scoped(endpoint),prepared)
      return Response.json({state:prepared.state,idempotencyKey:prepared.idempotencyKey})
    }
    const result=await handler(url,init)
    if(['POST','PATCH'].includes(init?.method??'')&&/\/records(?:\/[^/]+)?$/u.test(url)&&result.ok){
      const body=await result.clone().json(),original=key??'legacy-fixture'
      const receipt:Receipt={state:'COMMITTED',idempotencyKey:original,operationId:'operation-'+original,
        statusCode:init?.method==='POST'?201:200,result:body,auditPending:false}
      receipts.set(scoped(url)+':'+original,receipt);active.set(scoped(url),receipt)
      if(lose){lose=false;throw new Error('injected-lost-business-reply')}
    }
    return result
  })
  return Object.assign(fetcher,{loseNextBusinessReply:()=>{lose=true},committedCount:()=>receipts.size,
    setEntrance:(next:typeof entrance)=>{currentEntrance={...next}}})
}

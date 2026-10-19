/** Memory holds only the current frozen body. Durable ownership lives in PG. */
import {readEntrance,getRecordWriteIntent,getRecordWriteReceipt,prepareRecordWriteIntent,
  cancelRecordWriteIntent,acknowledgeRecordWriteIntent,createRecord,updateRecord} from './api.ts'
import type {ApiResult,RecordWriteInput,RecordWriteIntent,RecordWriteTarget} from './api.ts'

type Failure=Extract<ApiResult<never>,{ok:false}>
export interface RecordWriteSnapshot {
  readonly phase:'loading'|'ready'|'pending'|'committed'|'settled'|'blocked'
  readonly busy:boolean
  readonly intent:RecordWriteIntent|null
  readonly canRetry:boolean
  readonly error?:Failure
}
export function createRecordWriteController(target:RecordWriteTarget, options:{expectedIdentity?:string;isCurrent?:()=>boolean;requestTimeoutMs?:number}={}) {
  target={...target}
  const timeoutMs=options.requestTimeoutMs??6500
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000) throw new Error('KVVI_BAD_REQUEST_TIMEOUT')
  let snapshot:RecordWriteSnapshot={phase:'loading',busy:false,intent:null,canRetry:false}
  let disposed=false, running=false, owner=options.expectedIdentity, frozen:RecordWriteInput|null=null, originalKey:string|undefined, retryAllowed=false
  let bodyBoundKey:string|undefined, retryRefusal:Failure|undefined
  const listeners=new Set<()=>void>(), reads=new AbortController()
  const isCurrent=()=>!disposed&&(options.isCurrent?.()??true)
  function publish(phase:RecordWriteSnapshot['phase'],intent=snapshot.intent,error?:Failure) {
    if(!isCurrent()) return
    snapshot={phase,busy:running,intent,canRetry:phase==='pending'&&retryAllowed&&retryRefusal===undefined
      &&frozen!==null&&originalKey!==undefined&&bodyBoundKey===originalKey,
      ...(error===undefined?{}:{error})}
    for(const listener of listeners) listener()
  }
  const fail=(failure:Failure)=>publish('pending',snapshot.intent,failure)
  const unknown=(status=202):Failure=>({ok:false,status,code:'KVVI_OPERATION_OUTCOME_UNKNOWN',
    ...(originalKey===undefined?{}:{idempotencyKey:originalKey,retryWithSameKey:true})})
  /** Aborting an HTTP wait does not cancel a possible server-side effect. */
  async function requestBefore<T>(send:(signal:AbortSignal)=>Promise<ApiResult<T>>,uncertain=false):Promise<ApiResult<T>> {
    const io=new AbortController()
    let end!:(failure:Failure)=>void
    const stopped=new Promise<Failure>(resolve=>{end=resolve})
    const abort=()=>{end({ok:false,status:0,code:'KVVI_ABORTED'});io.abort()}
    reads.signal.addEventListener('abort',abort,{once:true})
    const timer=setTimeout(()=>{
      end(uncertain?unknown(0):{ok:false,status:0,code:'KVVI_UNREACHABLE'})
      io.abort()
    },timeoutMs)
    try {
      if(reads.signal.aborted) {abort();return await stopped}
      return await Promise.race([send(io.signal),stopped])
    } catch {return uncertain?unknown(0):{ok:false,status:0,code:'KVVI_UNREACHABLE'}}
    finally {clearTimeout(timer);reads.signal.removeEventListener('abort',abort)}
  }
  async function verifyOwner() {
    if(!isCurrent()) return false
    const entrance=await requestBefore(signal=>readEntrance(signal))
    if(!isCurrent()) return false
    if(!entrance.ok) {publish('blocked',null,entrance);return false}
    const who=entrance.value
    if(who===null||typeof who!=='object'||Array.isArray(who)
      || ![who.companyId,who.userId,who.sessionId].every(value=>typeof value==='string'&&value!=='')
      || !['USER','BUILDER'].includes(who.gateway)) {
      publish('blocked',null,{ok:false,status:200,code:'KVVI_BAD_RESPONSE'});return false
    }
    const actual=JSON.stringify([who.companyId,who.userId,who.sessionId,who.gateway])
    if(owner===undefined) owner=actual
    if(owner!==actual) {
      frozen=null;originalKey=undefined;bodyBoundKey=undefined;retryRefusal=undefined;retryAllowed=false
      publish('blocked',null,{ok:false,status:409,code:'KVVI_WRITE_IDENTITY_CHANGED'});return false
    }
    return true
  }
  async function exclusive<T>(work:()=>Promise<T>):Promise<T|undefined> {
    if(!isCurrent()||running) return undefined
    running=true;publish(snapshot.phase,snapshot.intent,snapshot.error)
    try {return await work()}
    finally {running=false;publish(snapshot.phase,snapshot.intent,snapshot.error)}
  }
  const knownResult=()=>snapshot.phase==='committed'&&snapshot.intent!==null&&'result' in snapshot.intent?snapshot.intent.result:undefined
  async function load() {
    if(!await verifyOwner()) return
    let receiptError:Failure|undefined
    if(originalKey!==undefined) {
      const receipt=await requestBefore(signal=>getRecordWriteReceipt(target,originalKey!,signal))
      if(!await verifyOwner()) return
      if(receipt.ok) {retryAllowed=false;publish('committed',receipt.value);return}
      receiptError=receipt
    }
    const active=await requestBefore(signal=>getRecordWriteIntent(target,signal))
    if(!await verifyOwner()) return
    if(!active.ok) {retryAllowed=false;fail(active);return}
    if(originalKey!==undefined && (active.value.state==='EMPTY'||!('idempotencyKey' in active.value)||active.value.idempotencyKey!==originalKey)) {
      // A peer may have sealed/acked the old key and prepared a different one.
      // An absent old receipt is still unknown, so keep the original identity.
      retryAllowed=false
      publish('pending',{state:'PREPARED',idempotencyKey:originalKey},receiptError??unknown());return
    }
    if(active.value.state==='EMPTY') {frozen=null;bodyBoundKey=undefined;retryRefusal=undefined;retryAllowed=false;publish('ready',active.value);return}
    if('idempotencyKey' in active.value) originalKey=active.value.idempotencyKey
    retryAllowed=frozen!==null&&bodyBoundKey===originalKey&&retryRefusal===undefined
      &&active.value.state==='PREPARED'&&!('resultRestricted' in active.value)
    publish(active.value.state==='COMMITTED'?'committed':'pending',active.value,retryRefusal)
  }
  async function writeFrozen() {
    if(frozen===null||originalKey===undefined||bodyBoundKey!==originalKey||!await verifyOwner()) return undefined
    const input=frozen,key=originalKey
    const result=await requestBefore(signal=>target.recordId===undefined?createRecord(target.assetId,input.data,key,signal)
      :updateRecord(target.assetId,target.recordId,input.data,input.rowVersion!,key,signal),true)
    if(!await verifyOwner()) return undefined
    if(!result.ok) {
      if(result.status===409) {retryAllowed=false;retryRefusal={...result,idempotencyKey:originalKey}}
      fail({...result,idempotencyKey:originalKey});return undefined
    }
    // Success must be validated as the original receipt, even if another tab
    // has already acknowledged it or prepared a subsequent active intent.
    const receipt=await requestBefore(signal=>getRecordWriteReceipt(target,originalKey!,signal))
    if(!await verifyOwner()) return undefined
    if(!receipt.ok) {fail(receipt);return undefined}
    retryAllowed=false;publish('committed',receipt.value)
    return knownResult()
  }
  return {
    getSnapshot:()=>snapshot,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener)}},
    isCurrent,
    refresh:()=>exclusive(load),
    submit:(input:RecordWriteInput)=>exclusive(async()=>{
      if(snapshot.phase!=='ready'||!await verifyOwner()) return undefined
      retryRefusal=undefined
      try {frozen=JSON.parse(JSON.stringify(input)) as RecordWriteInput}
      catch {publish('ready',snapshot.intent,{ok:false,status:400,code:'KVVI_BAD_REQUEST'});return undefined}
      publish('pending')
      const preparedInput=frozen
      const prepared=await requestBefore(signal=>prepareRecordWriteIntent(target,preparedInput!,signal),true)
      if(!await verifyOwner()) return undefined
      if(!prepared.ok) {retryAllowed=false;fail(prepared);return undefined}
      if(prepared.value.state==='COMMITTED') {originalKey=prepared.value.idempotencyKey;retryAllowed=false;publish('committed',prepared.value);return knownResult()}
      if(prepared.value.state!=='PREPARED') {fail({ok:false,status:200,code:'KVVI_BAD_RESPONSE'});return undefined}
      originalKey=prepared.value.idempotencyKey;bodyBoundKey=originalKey;retryAllowed=true;publish('pending',prepared.value)
      return writeFrozen()
    }),
    retry:()=>exclusive(async()=>{
      if(!await verifyOwner()) return undefined
      if(snapshot.phase==='committed') return knownResult()
      if(snapshot.phase!=='pending'||frozen===null||originalKey===undefined||!snapshot.canRetry) return undefined
      await load()
      const result=knownResult()
      if(result!==undefined) return result
      if(!snapshot.canRetry) return undefined
      return writeFrozen()
    }),
    cancel:async()=>Boolean(await exclusive(async()=>{
      if(snapshot.intent===null||!('idempotencyKey' in snapshot.intent)||!await verifyOwner()) return false
      const key=snapshot.intent.idempotencyKey
      const result=await requestBefore(signal=>cancelRecordWriteIntent(target,key,signal),true)
      if(!await verifyOwner()) return false
      if(!result.ok) {fail(result);return false}
      if(result.value.state==='COMMITTED') {retryAllowed=false;publish('committed',result.value);return false}
      frozen=null;originalKey=undefined;bodyBoundKey=undefined;retryRefusal=undefined;retryAllowed=false;publish('settled',result.value);return true
    })),
    acknowledge:async()=>Boolean(await exclusive(async()=>{
      if(snapshot.phase!=='committed'||snapshot.intent?.state!=='COMMITTED'||!await verifyOwner()) return false
      const key=snapshot.intent.idempotencyKey
      const result=await requestBefore(signal=>acknowledgeRecordWriteIntent(target,key,signal),true)
      if(!await verifyOwner()) return false
      if(!result.ok) {fail(result);return false}
      frozen=null;originalKey=undefined;bodyBoundKey=undefined;retryRefusal=undefined;retryAllowed=false;publish('settled',result.value);return true
    })),
    dispose:()=>{disposed=true;reads.abort();frozen=null;originalKey=undefined;bodyBoundKey=undefined;retryRefusal=undefined;retryAllowed=false;listeners.clear()},
  }
}
export type RecordWriteController=ReturnType<typeof createRecordWriteController>

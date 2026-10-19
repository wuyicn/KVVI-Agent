/** Visible, explicit controls for the durable write protocol. */
import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import type {ReactNode} from 'react'
import {Button} from '@deepseek-ai/dsh-client-ui-primitives'
import {createRecordWriteController} from './record-write.ts'
import type {RecordWriteController,RecordWriteSnapshot} from './record-write.ts'
import type {ApiResult,RecordWriteInput,RecordWriteResult,RecordWriteTarget} from './api.ts'
import type {Copy} from './FormView.tsx'
import {ReadFailure} from './ReadFailure.tsx'
import css from './business.module.css'

const loading:RecordWriteSnapshot={phase:'loading',busy:true,intent:null,canRetry:false}
const emptySubscribe=()=>()=>{}
const loadingSnapshot=()=>loading
type Failure=Extract<ApiResult<never>,{ok:false}>
export function RecordWriteGuard({target,identity,generation,copy,onCommitted,onView,onFailure,onReload,children}:{
  readonly target:RecordWriteTarget
  readonly identity?:string
  /** Change only while reloading the parent projection/record. */
  readonly generation:number
  readonly copy:Copy
  readonly onCommitted:(result:RecordWriteResult)=>void
  readonly onView?:(result:RecordWriteResult)=>void
  readonly onFailure?:(failure:Failure)=>void
  readonly onReload:()=>void
  readonly children:(write:{busy:boolean;submit:(input:RecordWriteInput)=>Promise<RecordWriteResult|undefined>})=>ReactNode
}):ReactNode {
  const scope=JSON.stringify([target.assetId,target.recordId??null,identity??null,generation])
  const currentScope=useRef(scope);currentScope.current=scope
  const callbacks=useRef({onCommitted,onView,onFailure,onReload});callbacks.current={onCommitted,onView,onFailure,onReload}
  const [binding,setBinding]=useState<{scope:string;controller:RecordWriteController}|null>(null)
  const lastError=useRef<Failure|undefined>()
  useEffect(()=>{
    // Create in the effect: StrictMode cleanup must never dispose the next
    // occurrence's controller or reopen an already disposed instance.
    const controller=createRecordWriteController(target,{...(identity===undefined?{}:{expectedIdentity:identity}),
      isCurrent:()=>currentScope.current===scope})
    setBinding({scope,controller});void controller.refresh()
    return ()=>{controller.dispose()}
  },[scope])
  const controller=binding?.scope===scope?binding.controller:null
  const snapshot=useSyncExternalStore(controller?.subscribe??emptySubscribe,controller?.getSnapshot??loadingSnapshot,loadingSnapshot)
  useEffect(()=>{
    if(snapshot.error===undefined) {lastError.current=undefined;return}
    if(controller?.isCurrent()&&lastError.current!==snapshot.error) {
      lastError.current=snapshot.error;callbacks.current.onFailure?.(snapshot.error)
    }
  },[controller,snapshot.error,onFailure])
  if(controller===null||snapshot.phase==='loading')return <p role="status">{copy('panel.loading')}</p>
  const deliver=async(work:()=>Promise<RecordWriteResult|undefined>,view=false)=>{
    const result=await work()
    if(result!==undefined&&controller.isCurrent()){
      const completed=view?(callbacks.current.onView??callbacks.current.onCommitted):callbacks.current.onCommitted
      completed(result);return result
    }
    return undefined
  }
  const settle=async(action:'cancel'|'acknowledge')=>{
    if(await controller[action]()&&controller.isCurrent())callbacks.current.onReload()
  }
  if(snapshot.error?.code==='KVVI_WRITE_IDENTITY_CHANGED')return <div role="alert" className={css.notice}>
    <p>{copy('recovery.identityChanged')}</p><Button onClick={onReload}>{copy('recovery.reload')}</Button>
  </div>
  if(snapshot.phase==='blocked'||snapshot.error?.code==='KVVI_FORM_ARCHIVED')return <ReadFailure
    error={snapshot.error?.code??'KVVI_NOT_ALLOWED'} copy={copy}
    onRetry={()=>{if(snapshot.error?.code==='KVVI_FORM_ARCHIVED')onReload();else void controller.refresh()}}/>
  const restricted=snapshot.intent!==null&&'resultRestricted' in snapshot.intent
  const hasKey=snapshot.intent!==null&&'idempotencyKey' in snapshot.intent
  const permissionFailure=['KVVI_NOT_ALLOWED','KVVI_FIELD_NOT_WRITABLE'].includes(snapshot.error?.code??'')
  const uncertain=snapshot.error!==undefined&&(snapshot.error.status===0||snapshot.error.status>=500
    ||['KVVI_OPERATION_OUTCOME_UNKNOWN','KVVI_BAD_RESPONSE'].includes(snapshot.error.code))
  return <>
    {snapshot.phase==='pending'?<div className={css.notice} role="status">
      <p>{copy(hasKey?'recovery.pending':'recovery.pendingUnidentified')}</p>
      <Button disabled={snapshot.busy} onClick={()=>{void controller.refresh()}}>{copy('recovery.check')}</Button>
      {snapshot.canRetry?<Button disabled={snapshot.busy} onClick={()=>{void deliver(controller.retry)}}>{copy('recovery.retry')}</Button>:null}
      {hasKey?<Button disabled={snapshot.busy} onClick={()=>{void settle('cancel')}}>{copy('recovery.cancel')}</Button>:null}
    </div>:snapshot.phase==='committed'?<div className={css.notice} role="status">
      <p>{copy(restricted?'recovery.savedRestricted':'recovery.saved')}</p>
      {snapshot.intent!==null&&'result' in snapshot.intent?<Button disabled={snapshot.busy}
        onClick={()=>{void deliver(controller.retry,true)}}>{copy('recovery.view')}</Button>:null}
      <Button disabled={snapshot.busy} onClick={()=>{void settle('acknowledge')}}>{copy('recovery.acknowledge')}</Button>
    </div>:snapshot.phase==='settled'?<div className={css.notice} role="status">
      <p>{copy('recovery.settled')}</p><Button onClick={onReload}>{copy('recovery.reload')}</Button>
    </div>:null}
    {snapshot.error===undefined?null:<div role="alert" className={css.notice}>
      <p>{copy(snapshot.error.currentRowVersion!==undefined?'detail.conflict':snapshot.error.code==='KVVI_FIELD_DUPLICATE'?'form.duplicate'
        :permissionFailure?'form.denied':uncertain?'recovery.uncertain':'form.writeFailed',{currentRowVersion:String(snapshot.error.currentRowVersion??'')})}</p>
      <details><summary>{copy('form.diagnostics')}</summary><code>{snapshot.error.code}</code></details>
    </div>}
    {restricted||permissionFailure||snapshot.phase==='settled'?null:children({busy:snapshot.busy||snapshot.phase!=='ready',
      submit:input=>deliver(()=>controller.submit(input))})}
  </>
}

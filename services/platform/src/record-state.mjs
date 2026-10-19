/** Record data edits use the record's pinned, digest-checked workflow. */
import {contractAt,latestContract} from './contracts.mjs'
import {canAct} from './authorization.mjs'
import {judgeTransition,kindOf} from './workflow.mjs'

export class RecordStateError extends Error {
  constructor(code,status=403) {super(code);this.code=code;this.status=status}
}
/** A JSONB concatenation with an array/scalar is not an empty object patch. */
export function recordData(value) {
  if(value===undefined)return {}
  if(value===null||typeof value!=='object'||Array.isArray(value)
    ||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new RecordStateError('KVVI_RECORD_DATA_INVALID',400)
  return value
}
/** No request flag or risk approval can make a terminal record editable. */
export async function assertRecordEditable(ctx,record,{data,toState,transitionAction}={}) {
  const hasData=Object.keys(recordData(data)).length>0
  if(toState!=null&&(typeof transitionAction!=='string'||transitionAction===''))throw new RecordStateError('KVVI_TRANSITION_ACTION_REQUIRED')
  const {schemaCode,state,workflowVersion}=record
  const contract=workflowVersion==null?await latestContract(ctx.companyId,'workflow-spec',schemaCode)
    :await contractAt(ctx.companyId,'workflow-spec',schemaCode,workflowVersion)
  if(workflowVersion!=null&&contract===null)throw new RecordStateError('KVVI_WORKFLOW_VERSION_MISSING')
  // Legacy/no-workflow data has one ordinary state. Do not infer semantics
  // for arbitrary state strings when no authoritative definition exists.
  const states=contract?.content?.states
  if(contract===null||Array.isArray(states)&&states.length===0){
    if(state!=='draft')throw new RecordStateError('KVVI_UNKNOWN_STATE')
    if(toState!=null)throw new RecordStateError('KVVI_TRANSITION_NOT_DEFINED')
    return
  }
  if(!Array.isArray(states))throw new RecordStateError('KVVI_WORKFLOW_INVALID')
  const matches=states.filter(candidate=>candidate?.state_code===state)
  if(matches.length!==1)throw new RecordStateError('KVVI_UNKNOWN_STATE')
  const current=matches[0]
  if(typeof current.initial!=='boolean'||typeof current.terminal!=='boolean')throw new RecordStateError('KVVI_WORKFLOW_INVALID')
  if(current.terminal)throw new RecordStateError('KVVI_TERMINAL_STATE')
  if(toState!=null){
    const kind=kindOf(contract.content,transitionAction)
    const permitted=kind===null?false:await canAct(ctx.companyId,ctx.userId,'FLOW',schemaCode,kind,{state})
    const verdict=judgeTransition(contract.content,{from:state,action:transitionAction,actorUserId:ctx.userId,
      submitterUserId:record.ownerId,hasFlowPermission:permitted})
    if(!verdict.allowed)throw new RecordStateError(verdict.reason)
    if(verdict.toState!==toState)throw new RecordStateError('KVVI_TRANSITION_TARGET_MISMATCH')
  }
  if(hasData&&!current.initial)throw new RecordStateError('KVVI_RECORD_CHANGE_APPROVAL_REQUIRED')
}

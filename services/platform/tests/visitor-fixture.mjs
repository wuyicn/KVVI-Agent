import {A,grantPlatformRole,makeSession} from './harness.mjs'
import {submitDraft,approveDraft,publishDraft,DIFF_FACES} from '../src/publish.mjs'
/** A real published six-contract system; platform roles do not grant Bob FORM create. */
export async function publishVisitorFixture(){
  await grantPlatformRole(A.alice,'owner');await grantPlatformRole(A.bob,'owner')
  const author=await makeSession(A.alice,A.company),approver=await makeSession(A.bob,A.company)
  const assetId='general_item',specs={
    'business-schema':{schema_code:assetId,fields:[{field_code:'title',type:'short_text'},{field_code:'amount',type:'integer'}]},
    'view-schema':{componentsTree:[]},
    'workflow-spec':{states:[{state_code:'collecting',initial:true,terminal:false}],transitions:[]},
    'permission-spec':{roles:[],policies:[]},'tool-spec':{tools:[]},'app-model-command':{commands:[]},
  }
  const draft=await submitDraft({ctx:author.ctx,change:{assetId},diffReport:{faces:DIFF_FACES},invariant:{ok:true}})
  await approveDraft({ctx:approver.ctx,draftId:draft.draftId,decision:'APPROVE'})
  await publishDraft({ctx:approver.ctx,draftId:draft.draftId,apply:async({diffDigest})=>({diffDigest}),
    system:{assetId,schemaCode:assetId,name:'Visitor acceptance'},
    contracts:Object.entries(specs).map(([contractType,content])=>({contractType,content,assetId}))})
}

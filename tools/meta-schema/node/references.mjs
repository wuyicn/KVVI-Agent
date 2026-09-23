/** Fixed identity, scope grants, recursive real validators and historical snapshots. */
import { isDeepStrictEqual as equal } from 'node:util';
import { diagnostic, sortedUnique } from './diagnostics.mjs';
import { identity, exactKey, boundContext } from './context.mjs';
import { validateStructure, validateDefinition } from './structure.mjs';
import { resolveAsset, resolveCapability, contentDigest } from './view_registry.mjs';
import { declaredParameterRefs } from './view_reference_declarations.mjs';
import { validateBusiness } from './business.mjs';
import { validateView } from './view.mjs';
import { validateApp } from './app.mjs';
import { walk } from './view_safety.mjs';
const contracts={BUSINESS_SCHEMA:'business-schema/v1',VIEW_SCHEMA:'view-schema/lce-safe-v1',APP_SPEC:'app-spec/v1alpha1'};
const ids={BUSINESS_SCHEMA:'schema_id',VIEW_SCHEMA:'view_id',APP_SPEC:'app_id'};
const codes={BUSINESS_SCHEMA:'schema_code',VIEW_SCHEMA:'view_code',APP_SPEC:'app_code'};
const platform=new Set(['FIELD_TYPE_REGISTRY','COMPONENT_REGISTRY','CAPABILITY_REGISTRY','CAPABILITY','SEQUENCE_POLICY']);
const child=(prefix,key)=>prefix && prefix!=='$'?prefix+'.'+key:String(key);
const namespace=ref=>JSON.stringify(['scope_type','scope_id','app_id','module_id','asset_type'].map(k=>ref[k]));
function* refsIn(spec,kind,prefix,context) {
  if(kind==='BUSINESS_SCHEMA') {
    yield [spec.field_type_registry_ref,child(prefix,'field_type_registry_ref')];
    if(spec.record_number) yield [spec.record_number.sequence_policy_ref,child(prefix,'record_number.sequence_policy_ref')];
  } else if(kind==='APP_SPEC') {
    for(const slot of ['businessSchemaRefs','viewRefs','workflowRefs','permissionRefs'])
      for(const [i,ref] of spec[slot].entries()) yield [ref,child(prefix,`${slot}[${i}]`)];
  } else if(kind==='VIEW_SCHEMA') {
    for(const slot of ['businessSchemaRef','componentRegistryRef']) yield [spec[slot],child(prefix,slot)];
    // Only schema-declared reference slots; message keys are inert data.
    const referenceBody=Object.fromEntries(Object.entries(spec).filter(([key])=>key!=='i18n'));
    for(const [value,path] of walk(referenceBody,prefix)) {
      const slot=value?.type==='ActionRef'?'actionRef':value?.type==='DataQueryRef'?'queryRef':null;
      if(slot) {
        yield [value[slot],child(path,slot)];
        const parameterSlot=slot==='actionRef'?'input':'params';
        const [capability,status]=resolveCapability(value[slot],context);
        if(status==='ok')yield* declaredParameterRefs(capability.inputSchema,value[parameterSlot]??{},child(path,parameterSlot));
      }
    }
  }
}
function allowed(ref,source,context,templateSource=false) {
  if(ref.scope_type==='PLATFORM_CONTROL') return platform.has(ref.asset_type) && ref.app_id===null && ref.module_id===null;
  if(ref.scope_type==='TEMPLATE' && templateSource) return ref.asset_type==='BUSINESS_SCHEMA';
  if(ref.scope_type!==source.scope_type || ref.scope_id!==source.scope_id) return false;
  if(ref.app_id===source.app_id) return true;
  const purpose=context.current.purpose;
  if(!purpose) return false;
  const sides=new Set(context.grants.filter(g=>g.source_app_id===source.app_id && g.purpose===purpose && equal(g.target,ref)).map(g=>g.side));
  return sides.has('source') && sides.has('target');
}
const prefixed=(errors,prefix)=>errors.map(e=>({...e,path:e.path==='$'?prefix:child(prefix,e.path)}));
export function validateReferences(contract,entry,value,context) {
  const kind=Object.keys(contracts).find(k=>contracts[k]===contract);
  const prefix=entry==='spec'?'$':'spec', spec=entry==='spec'?value:value.spec, current=context.current;
  const errors=[],visiting=new Set(),validated=new Set();
  const add=(code,path)=>errors.push(diagnostic(code,path));
  const snapshotFor=ref=>context.snapshots.find(s=>exactKey(s.ref)===exactKey(ref) && s.ref.digest===ref.digest)?.registered;
  function metadata(ref,content,path,published=true) {
    const snap=snapshotFor(ref), depKind=ref.asset_type;
    if(!snap) {add('REFERENCE_NOT_FOUND',path);return null;}
    const expected={contract_version:contracts[depKind],scope_type:ref.scope_type,scope_id:ref.scope_id,version:ref.version,checksum:ref.digest};
    if(Object.entries(expected).some(([k,v])=>!equal(snap[k],v)) || !equal(snap.spec,content)) {add('REFERENCE_INVALID',path);return null;}
    const shape=validateStructure(contracts[depKind],'registered',snap);
    if(shape.length) {errors.push(...prefixed(shape,path));return null;}
    if(published && !['PUBLISHED','SUPERSEDED'].includes(snap.lifecycle)) {add('REFERENCE_INVALID',path);return null;}
    for(const other of context.snapshots) {
      if(identity(other.ref)===identity(ref)) {
        if(other.registered[ids[depKind]]!==snap[ids[depKind]] || other.registered.spec?.[codes[depKind]]!==content[codes[depKind]]) {add('REFERENCE_INVALID',path);return null;}
      } else if(namespace(other.ref)===namespace(ref) && (other.registered[ids[depKind]]===snap[ids[depKind]] || other.registered.spec?.[codes[depKind]]===content[codes[depKind]])) {add('REFERENCE_INVALID',path);return null;}
    }
    return snap;
  }
  function resolve(ref,path,source,templateSource=false) {
    const shape=validateDefinition(Object.hasOwn(ref,'capability_code')?'CapabilityRef':'AssetRef',ref);
    if(shape.length) {errors.push(...prefixed(shape,path));return null;}
    if(!allowed(ref,source,context,templateSource)) {add('REFERENCE_OUT_OF_SCOPE',path);return null;}
    const depKind=ref.asset_type;
    if(['WORKFLOW','PERMISSION'].includes(depKind)) {add('DEPENDENCY_VALIDATOR_UNAVAILABLE',path);return null;}
    const [content,status]=resolveAsset(ref,context);
    if(status!=='ok') {
      add(status==='digest'?(depKind==='CAPABILITY'?'VIEW_CAPABILITY_DIGEST_MISMATCH':'REFERENCE_DIGEST_MISMATCH'):'REFERENCE_NOT_FOUND',path);return null;
    }
    const key=exactKey(ref);
    if(visiting.has(key)) {add('REFERENCE_INVALID',path);return null;}
    if(validated.has(key)) return content;
    if(contracts[depKind]) {
      const shape=validateStructure(contracts[depKind],'spec',content);
      if(shape.length) {errors.push(...prefixed(shape,child(path,'spec')));return null;}
      const snap=metadata(ref,content,path);
      if(!snap) return null;
      visiting.add(key);const before=errors.length;
      checkSpec(depKind,content,ref,child(path,'spec'));
      if(snap.source_ref) resolve(snap.source_ref,child(path,'source_ref'),ref,true);
      visiting.delete(key);if(errors.length===before) validated.add(key);
    } else if(platform.has(depKind)) {
      if(!content || typeof content!=='object' || content.fixture!==true) {add('REFERENCE_INVALID',path);return null;}
      if(Object.hasOwn(content,'state') && content.state!=='PUBLISHED') {add('REFERENCE_INVALID',path);return null;}
      if(Object.hasOwn(content,'version') && content.version!==ref.version) {add('REFERENCE_INVALID',path);return null;}
      if(depKind==='FIELD_TYPE_REGISTRY' && (!equal(content.types,context.business.enabled_types) || !equal(content.index_capabilities,context.business.index_capabilities) || !equal(content.generators,context.business.generators) || !equal(content.money_rules,context.business.money_rules))) {add('REFERENCE_INVALID',path);return null;}
      validated.add(key);
    } else {add('DEPENDENCY_VALIDATOR_UNAVAILABLE',path);return null;}
    return content;
  }
  function checkSpec(assetKind,body,source,path) {
    const before=errors.length,resolved=new Map();
    for(const [ref,refPath] of refsIn(body,assetKind,path,context)) {
      const content=resolve(ref,refPath,source);
      if(content!==null) resolved.set(exactKey(ref),content);
    }
    if(assetKind==='VIEW_SCHEMA' && context.view) {
      if(context.view.capability_registry_ref===null) add('DEPENDENCY_VALIDATOR_UNAVAILABLE',child(path,'componentRegistryRef'));
      else resolve(context.view.capability_registry_ref,child(path,'componentRegistryRef'),source);
    }
    if(errors.length!==before) return;
    if(assetKind==='APP_SPEC') body.viewRefs.forEach((ref,i)=>{
      const view=resolved.get(exactKey(ref));
      if(view && !body.businessSchemaRefs.some(r=>equal(r,view.businessSchemaRef))) add('APPSPEC_INVALID',child(path,`viewRefs[${i}]`));
    });
    const validators={BUSINESS_SCHEMA:validateBusiness,VIEW_SCHEMA:validateView,APP_SPEC:validateApp};
    errors.push(...validators[assetKind](body,boundContext(context,source,true),path));
  }
  if(current.asset_type!==kind) return [diagnostic('REFERENCE_INVALID',prefix)];
  for(const item of context.snapshots) {
    const r=item.ref,s=item.registered;
    if(r.asset_type!==kind || namespace(r)!==namespace(current)) continue;
    const same=identity(r)===identity(current);
    if(same && s[ids[kind]]!==current.stable_id) add('REFERENCE_INVALID',ids[kind]);
    if((same && s.spec?.[codes[kind]]!==spec[codes[kind]]) || (!same && s.spec?.[codes[kind]]===spec[codes[kind]]))
      add(kind==='BUSINESS_SCHEMA'?'SCHEMA_CODE_INVALID':kind==='APP_SPEC'?'APPSPEC_INVALID':'VIEW_REFERENCE_VERSION_CONFLICT',child(prefix,codes[kind]));
  }
  if(entry==='compiled-draft' && value.base_version!==current.active_version) add('BASE_VERSION_CONFLICT','base_version');
  if(entry!=='registered') for(const history of context.histories) {
    if(identity(history.target)!==identity(current)) continue;
    const prior=history.previous_ref, body=history.business_history;
    if(prior) {
      const [content,status]=resolveAsset(prior,context);
      if(identity(prior)!==identity(current) || prior.version!==current.active_version || status!=='ok' || (body && !equal(content,body.previous_spec))) add('REFERENCE_INVALID',child(prefix,codes[kind]));
      else resolve(prior,entry==='compiled-draft'?'base_version':child(prefix,codes[kind]),current);
    } else if(current.active_version!==0 || body) add('REFERENCE_INVALID',child(prefix,codes[kind]));
  }
  if(entry==='registered') {
    if(contentDigest(spec)!==value.checksum) add('CONTRACT_CHECKSUM_MISMATCH','checksum');
    else {
      const exact=context.snapshots.find(s=>identity(s.ref)===identity(current) && s.ref.version===value.version);
      if(!exact) add('REFERENCE_INVALID','version');
      else {
        const trusted=exact.registered;
        for(const key of ['contract_version',ids[kind],'scope_type','scope_id','version','base_version','lifecycle','canonicalization_profile','audit']) if(!equal(value[key],trusted[key])) add('REFERENCE_INVALID',key);
        if(kind==='BUSINESS_SCHEMA' && !equal(value.source_ref,trusted.source_ref)) add('REFERENCE_INVALID','source_ref');
        if(!equal(value.spec,trusted.spec) || value.checksum!==exact.ref.digest) add('CONTRACT_CHECKSUM_MISMATCH','checksum');
        if(!errors.length) metadata(exact.ref,spec,'$',false);
      }
    }
  }
  if(errors.length) return sortedUnique(errors);
  if(entry==='compiled-draft' && current.active_version>0) {
    const active=context.snapshots.find(s=>identity(s.ref)===identity(current) && s.ref.version===current.active_version);
    if(!active) return [diagnostic('REFERENCE_NOT_FOUND','base_version')];
    resolve(active.ref,'base_version',current);
    if(errors.length) return sortedUnique(errors);
    if(kind==='BUSINESS_SCHEMA' || kind==='VIEW_SCHEMA') {
      const history=context.histories.find(h=>identity(h.target)===identity(current));
      if(!history || !equal(history.previous_ref,active.ref) || (kind==='BUSINESS_SCHEMA' && !history.business_history)) return [diagnostic('REFERENCE_INVALID','base_version')];
    }
  }
  checkSpec(kind,spec,current,prefix);
  if(entry==='registered' && value.source_ref) resolve(value.source_ref,'source_ref',current,true);
  return sortedUnique(errors);
}

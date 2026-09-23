/** Independently strict private context parsing; never parse raw trust with JSON.parse. */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadBundle, BundleLoadError, validateStructure } from './structure.mjs';
import { validateBusiness } from './business.mjs';
import { resolveAsset } from './view_registry.mjs';
import { isDeepStrictEqual as equal } from 'node:util';
export class ContextInvalid extends Error {}
export class RegistryConfigurationInvalid extends Error {}
// FIX2 private Registry profile; installed ajv-formats cannot enlarge this set.
const REGISTRY_FORMATS = new Set(['date', 'date-time', 'uuid']);
function validateRegistrySchemas(context,ajv,schemas) {
  const known=new Set('$schema $id $ref $defs $comment title description default examples type enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum maxLength minLength pattern format maxItems minItems uniqueItems maxContains minContains maxProperties minProperties required dependentRequired properties patternProperties additionalProperties unevaluatedProperties propertyNames items prefixItems contains dependentSchemas allOf anyOf oneOf not if then else readOnly writeOnly deprecated contentEncoding contentMediaType contentSchema'.split(' '));
  const pointerToken=key=>encodeURIComponent(String(key).replace(/~/g,'~0').replace(/\//g,'~1'));
  function visit(schema,root,definitions,pointer='') {
    if(typeof schema==='boolean') return;
    if(!schema || typeof schema!=='object' || Array.isArray(schema)) throw new RegistryConfigurationInvalid();
    if(Object.keys(schema).some(k=>!known.has(k))) throw new RegistryConfigurationInvalid();
    if(Object.hasOwn(schema,'format') && !REGISTRY_FORMATS.has(schema.format)) throw new RegistryConfigurationInvalid();
    if(schema.$ref!==undefined) {
      if(typeof schema.$ref!=='string') throw new RegistryConfigurationInvalid();
      const separator=schema.$ref.indexOf('#');
      const id=separator<0?schema.$ref:schema.$ref.slice(0,separator);
      const fragment=separator<0?'':schema.$ref.slice(separator+1);
      let target=!id || id===root.$id?root:[...schemas.values()].find(s=>s.$id===id);
      if(!target || (fragment && !fragment.startsWith('/'))) throw new RegistryConfigurationInvalid();
      for(const token of fragment.split('/').slice(1)) {
        const key=token.replace(/~1/g,'/').replace(/~0/g,'~');
        if(target===null || typeof target!=='object' || !Object.hasOwn(target,key))throw new RegistryConfigurationInvalid();
        target=target[key];
      }
      if(typeof target!=='boolean' && (!target || typeof target!=='object' || Array.isArray(target))) throw new RegistryConfigurationInvalid();
    }
    for(const k of ['$defs','properties','patternProperties','dependentSchemas']) for(const [name,n] of Object.entries(schema[k]??{})) {
      const child=pointer+'/'+k+'/'+pointerToken(name);
      if(k==='$defs')definitions.push(child);
      visit(n,root,definitions,child);
    }
    for(const k of ['additionalProperties','unevaluatedProperties','propertyNames','items','contains','not','if','then','else','contentSchema']) if(schema[k]!==undefined) visit(schema[k],root,definitions,pointer+'/'+k);
    for(const k of ['prefixItems','allOf','anyOf','oneOf']) for(const [i,n] of (schema[k]??[]).entries()) visit(n,root,definitions,pointer+'/'+k+'/'+i);
  }
  try {
    let ordinal=0;
    for(const asset of context.fake_assets) {
      const c=asset.content;if(!c || typeof c!=='object')continue;
      const definitions=asset.ref.asset_type==='COMPONENT_REGISTRY'?(c.components??[]).filter(c=>c && Object.hasOwn(c,'propsSchema')).map(c=>c.propsSchema):asset.ref.asset_type==='CAPABILITY'?['inputSchema','outputSchema','errorSchema'].filter(k=>Object.hasOwn(c,k)).map(k=>c[k]):[];
      for(const schema of definitions) {
        const refs=[],rootId=schema.$id??'urn:kvvi:tool-private:registry-schema:'+ordinal++;
        visit(schema,schema,refs);
        ajv.addSchema(schema,rootId);
        ajv.getSchema(rootId); // Strict complete root first, including parent type context.
        for(const pointer of refs) if(!ajv.getSchema(rootId+'#'+pointer)) throw new RegistryConfigurationInvalid();
      }
    }
  } catch(error) {throw new RegistryConfigurationInvalid();}
}
const keys=['scope_type','scope_id','app_id','module_id','asset_type','asset_id'];
export const identity=ref=>JSON.stringify(keys.map(k=>k==='asset_id'?(ref.asset_id??ref.capability_code):ref[k]));
export const exactKey=ref=>JSON.stringify([identity(ref),ref.version]);
export function parseContext(raw) {
  const c14n=fileURLToPath(new URL('../../../protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/node/kvvi-json-c14n.mjs',import.meta.url));
  const run=spawnSync(process.execPath,[c14n,'--profile','kvvi-json-c14n/v1'],{input:raw,timeout:10000,maxBuffer:16*1024*1024});
  if(run.error || run.status!==0 || run.stderr.length) throw new ContextInvalid();
  const context=JSON.parse(JSON.parse(run.stdout.toString('utf8')).canonical);
  const {ajv,schemas}=loadBundle();
  const schema=JSON.parse(readFileSync(new URL('../context.schema.json',import.meta.url),'utf8'));
  if(!ajv.compile(schema)(context)) throw new ContextInvalid();
  for(const name of ['fake_assets','snapshots']) {
    const refs=context[name].map(x=>exactKey(x.ref));
    if(new Set(refs).size!==refs.length) throw new ContextInvalid();
  }
  const histories=context.histories.map(h=>identity(h.target));
  if(new Set(histories).size!==histories.length) throw new ContextInvalid();
  for(const rules of Object.values(context.business.money_rules)) if(rules.scale>rules.precision) throw new ContextInvalid();
  validateRegistrySchemas(context,ajv,schemas);
  return context;
}
export function boundContext(context,target=null,historical=false) {
  const result={...context,business:{...context.business,history:null}};
  // null means unknown/not applicable, never evidence of an empty deletion set.
  // The CompiledDraft reference gate requires exact active history for existing Views.
  if(context.view) result.view={...context.view,deleted_node_ids:null};
  if(!historical) {
    const history=context.histories.find(h=>identity(h.target)===identity(target??context.current));
    if(history) {
      const prior=history.previous_ref,body=history.business_history;
      let bound=!prior && !body && context.current.active_version===0;
      if(prior) {
        const [content,status]=resolveAsset(prior,context);
        bound=identity(prior)===identity(target??context.current) && prior.version===context.current.active_version && status==='ok' && (!body || equal(content,body.previous_spec));
        if(bound && body) bound=!validateStructure('business-schema/v1','spec',content).length && !validateBusiness(content,result,'').length;
      }
      if(bound) {result.business.history=body;if(result.view) result.view.deleted_node_ids=history.deleted_node_ids;}
    }
  }
  return result;
}

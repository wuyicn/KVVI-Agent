/** Project trusted Schema declarations; Ajv owns applicability and annotations. */
import { loadBundle, invocationResource } from './structure.mjs';
import { childPath } from './view_safety.mjs';
const dynamicKeys=new Set(['props','actions','input','params','i18n']);
const baseKeys=['scope_type','scope_id','app_id','module_id','asset_type','version','digest'];
const layouts=[new Set([...baseKeys,'asset_id']),new Set([...baseKeys,'capability_code'])];
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const pointerToken=key=>encodeURIComponent(String(key).replace(/~/g,'~0').replace(/\//g,'~1'));
const childUri=(uri,...tokens)=>uri+(uri.includes('#')?'':'#')+'/'+tokens.map(pointerToken).join('/');
function locate(value,target,path=[]) {
  if(value===target)return path;
  if(value && typeof value==='object')for(const [key,nested] of Object.entries(value)) {
    const found=locate(nested,target,[...path,key]);if(found)return found;
  }
  return null;
}

const projectionResources=Symbol('parameter declaration engines');
function projectionEngine(root) {
  const cache=invocationResource(projectionResources,()=>new Map());
  if(cache.has(root))return cache.get(root);
  const {ajv,schemas}=loadBundle(undefined,true),common=schemas.get('common.schema.json');
  const terminals=new Set([common.$defs.AssetRef,common.$defs.CapabilityRef]);
  const rootId=root.$id??'urn:kvvi:tool-private:parameter-input';
  ajv.addSchema(root,rootId);
  ajv.getSchema(rootId); // Check the complete registered definition in strict mode first.
  // Fragment compilation cannot inherit the parent's type context. This lint-only
  // option does not alter instance validation; the complete definition stays strict.
  ajv.opts.strictTypes=false;
  const result={ajv,terminals,rootId,annotationChecks:new Map(),constantChecks:new WeakMap(),patternChecks:new Map()};
  cache.set(root,result);
  return result;
}

export function* declaredParameterRefs(root,value,prefix) {
  const {ajv,terminals,rootId,annotationChecks,constantChecks,patternChecks}=projectionEngine(root);
  const visited=new Set();
  function* constant(declaration,instance,path,dynamic) {
    if(object(declaration)) {
      const keys=Object.keys(declaration);
      if(layouts.some(layout=>keys.length===layout.size && keys.every(key=>layout.has(key)))) {yield [instance,path];return;}
      for(const [key,nested] of Object.entries(declaration))
        yield* constant(nested,instance[key],childPath(path,key,dynamic),dynamicKeys.has(key));
    } else if(Array.isArray(declaration)) {
      for(const [index,nested] of declaration.entries()) yield* constant(nested,instance[index],childPath(path,index),false);
    }
  }
  function evaluatedWithoutOwnKeyword(validator,uri,instance) {
    // Cache the isolated check, never its per-instance applicability/annotations.
    if(!annotationChecks.has(uri)) {
      const source=validator.schemaEnv.root.schema,owner=validator.schemaEnv.root.baseId;
      const tokens=locate(source,validator.schema),copy=structuredClone(source);
      let node=copy;for(const token of tokens)node=node[token];delete node.unevaluatedProperties;
      const {ajv:annotations}=loadBundle(undefined,true);annotations.removeSchema(owner);annotations.addSchema(copy,owner);
      annotations.getSchema(owner);annotations.opts.strictTypes=false;
      annotationChecks.set(uri,annotations.getSchema(uri));
    }
    const check=annotationChecks.get(uri);check(instance);
    const props=check.evaluated?.props;
    return new Set(props===true?Object.keys(instance):Object.keys(props??{}));
  }
  function* project(uri,instance,path,dynamic=false) {
    const validator=ajv.getSchema(uri),schema=validator.schema;
    if(typeof schema==='boolean')return;
    if(terminals.has(schema)) {yield [instance,path];return;}
    // Ajv may already dereference a pure $ref. Descendants belong to the
    // returned Schema's actual resource, not the caller's pointer location.
    const tokens=locate(validator.schemaEnv.root.schema,schema);
    uri=validator.schemaEnv.root.baseId+(tokens.length?'#/'+tokens.map(pointerToken).join('/'):'');
    const key=JSON.stringify([uri,path]);if(visited.has(key))return;visited.add(key);
    if(schema.$ref)yield* project(new URL(schema.$ref,validator.schemaEnv.baseId).href,instance,path,dynamic);
    // Recursive dependencies reach projection before their parameter check.
    // Only a matching const supplies locations; validateView still rejects
    // mismatches through the complete registered inputSchema.
    if(Object.hasOwn(schema,'const')) {
      if(!constantChecks.has(schema))constantChecks.set(schema,ajv.compile({const:schema.const}));
      if(constantChecks.get(schema)(instance))yield* constant(schema.const,instance,path,dynamic);
    }
    for(const keyword of ['allOf','anyOf','oneOf'])
      for(const [index] of (schema[keyword]??[]).entries()) {
        const branch=childUri(uri,keyword,index);
        if(keyword==='allOf' || ajv.getSchema(branch)(instance))yield* project(branch,instance,path,dynamic);
      }
    if(Object.hasOwn(schema,'if')) {
      const matched=ajv.getSchema(childUri(uri,'if'))(instance);
      if(matched)yield* project(childUri(uri,'if'),instance,path,dynamic);
      const branch=matched?'then':'else';if(Object.hasOwn(schema,branch))yield* project(childUri(uri,branch),instance,path,dynamic);
    }
    if(object(instance)) {
      const properties=schema.properties??{},matched=new Set(Object.keys(properties));
      for(const prop of Object.keys(properties))if(Object.hasOwn(instance,prop))
        yield* project(childUri(uri,'properties',prop),instance[prop],childPath(path,prop,dynamic),dynamicKeys.has(prop));
      for(const pattern of Object.keys(schema.patternProperties??{})) {
        if(!patternChecks.has(pattern))patternChecks.set(pattern,ajv.compile({type:'string',pattern}));
        const matches=patternChecks.get(pattern);
        for(const [prop,item] of Object.entries(instance))if(matches(prop)) {
          matched.add(prop);yield* project(childUri(uri,'patternProperties',pattern),item,childPath(path,prop,dynamic),dynamicKeys.has(prop));
        }
      }
      if(Object.hasOwn(schema,'additionalProperties'))for(const prop of Object.keys(instance))if(!matched.has(prop))
        yield* project(childUri(uri,'additionalProperties'),instance[prop],childPath(path,prop,dynamic),dynamicKeys.has(prop));
      for(const prop of Object.keys(schema.dependentSchemas??{}))if(Object.hasOwn(instance,prop))
        yield* project(childUri(uri,'dependentSchemas',prop),instance,path,dynamic);
      if(Object.hasOwn(schema,'unevaluatedProperties')) {
        const evaluated=evaluatedWithoutOwnKeyword(validator,uri,instance);
        for(const prop of Object.keys(instance))if(!evaluated.has(prop))
          yield* project(childUri(uri,'unevaluatedProperties'),instance[prop],childPath(path,prop,dynamic),dynamicKeys.has(prop));
      }
    } else if(Array.isArray(instance)) {
      const heads=schema.prefixItems??[];
      for(let i=0;i<Math.min(heads.length,instance.length);i++)yield* project(childUri(uri,'prefixItems',i),instance[i],childPath(path,i));
      if(Object.hasOwn(schema,'items'))for(let i=heads.length;i<instance.length;i++)yield* project(childUri(uri,'items'),instance[i],childPath(path,i));
      if(Object.hasOwn(schema,'contains'))for(const [i,item] of instance.entries())
        if(ajv.getSchema(childUri(uri,'contains'))(item))yield* project(childUri(uri,'contains'),item,childPath(path,i));
    }
  }
  yield* project(rootId,value,prefix,true);
}

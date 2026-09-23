/** D06 local composition. Dependency bodies are checked by references. */
import { isDeepStrictEqual } from 'node:util';
import { diagnostic, sortedUnique } from './diagnostics.mjs';
import { validateSecrets } from './secret_safety.mjs';
export function validateApp(spec, context, prefix) {
  const errors=validateSecrets(spec, prefix);
  const add=path=>errors.push(diagnostic('APPSPEC_INVALID', (prefix && prefix!=='$' ? prefix+'.':'')+path));
  for(const slot of ['businessSchemaRefs','viewRefs','workflowRefs','permissionRefs']) {
    const seen=new Set();
    spec[slot].forEach((ref,i)=>{
      const identity=JSON.stringify(['scope_type','scope_id','app_id','module_id','asset_type','asset_id'].map(k=>ref[k]));
      if(seen.has(identity)) add(`${slot}[${i}]`);
      seen.add(identity);
    });
  }
  const codes=new Set(),paths=new Set();
  spec.navigation.forEach((route,i)=>{
    if(codes.has(route.route_code)) add(`navigation[${i}].route_code`);
    if(paths.has(route.path)) add(`navigation[${i}].path`);
    codes.add(route.route_code); paths.add(route.path);
    if(!spec.viewRefs.some(r=>isDeepStrictEqual(r,route.viewRef))) add(`navigation[${i}].viewRef`);
  });
  return sortedUnique(errors);
}

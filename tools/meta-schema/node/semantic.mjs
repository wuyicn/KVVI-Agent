/** Task-scoped semantic dispatch; later tasks replace fail-closed handlers. */

import { diagnostic } from "./diagnostics.mjs";
import { validateBusiness } from "./business.mjs";
export { validateBusiness };
import { validateView } from "./view.mjs";
export { validateView };
import { validateApp } from './app.mjs';
import { resolveAsset } from './view_registry.mjs';
import { validateStructure } from './structure.mjs';
export { validateApp };

function unavailable(pathPrefix) {
  return [diagnostic("DEPENDENCY_VALIDATOR_UNAVAILABLE", pathPrefix)];
}

export function validateSemantic(contract, entry, value, context) {
  const pathPrefix = entry === "spec" ? "$" : "spec";
  if (
    context === null ||
    context?.fixture !== true ||
    context?.suite_revision !== "0a-core-r1"
  ) {
    return [diagnostic("TRUSTED_CONTEXT_REQUIRED", pathPrefix)];
  }
  const spec = entry === "spec" ? value : value.spec;
  if(contract==='view-schema/lce-safe-v1') {
    const [body,status]=resolveAsset(spec.businessSchemaRef,context);
    if(status==='ok' && validateStructure('business-schema/v1','spec',body).length) return [];
  }
  const validators = new Map([
    ["business-schema/v1", validateBusiness],
    ["view-schema/lce-safe-v1", validateView],
    ["app-spec/v1alpha1", validateApp],
  ]);
  return validators.get(contract)(spec, context, pathPrefix);
}

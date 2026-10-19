/** Static validation only. The host supplies a real, authorized registry resolver. */
import { isDeepStrictEqual as equal } from 'node:util';
import { canonicalizeBytes, canonicalizeJson } from './canonical.mjs';
import { resolveComponentCatalog } from './component_catalog.mjs';
import { loadBundle, validateDefinition, validateStructure } from './structure.mjs';
import { checkViewTree } from './view_tree.mjs';
import { childPath } from './view_safety.mjs';
import { diagnostic, sortedUnique } from './diagnostics.mjs';

const IDENTITY_KEYS = ['scope_type', 'scope_id', 'app_id', 'module_id', 'asset_type', 'asset_id'];
const identity = ref => Object.fromEntries(IDENTITY_KEYS.map(k => [k, ref[k]]));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const namespaceMatches = (a, b) => ['scope_type', 'scope_id', 'app_id', 'module_id'].every(k => equal(a[k], b[k]));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u.test(value);

function report(errors, dependencies = []) {
  return { valid: errors.length === 0, errors: sortedUnique(errors), dependencies,
    validationScope: 'STATIC_VIEW_AND_REFERENCE', releaseApproved: false };
}

function unsupported(spec) {
  const errors = [];
  for (const key of ['queries', 'i18n']) if (Object.hasOwn(spec, key)) errors.push(diagnostic('VIEW_FEATURE_UNSUPPORTED', key));
  const stack = spec.componentsTree.map((node, i) => [node, `componentsTree[${i}]`]);
  while (stack.length) {
    const [node, path] = stack.pop();
    for (const key of ['condition', 'loop', 'loopArgs', 'actions'])
      if (Object.hasOwn(node, key)) errors.push(diagnostic('VIEW_FEATURE_UNSUPPORTED', childPath(path, key)));
    for (const [i, child] of (node.children ?? []).entries()) stack.push([child, `${path}.children[${i}]`]);
  }
  return errors;
}

/**
 * The callback is executable host code, never a request-provided snapshot/flag.
 * It must read exact registration and publication records and verify approval
 * binding/current access. Supplying metadata is not itself proof of that work.
 * Legacy published_contracts without these identities must resolve to null.
 */
export function createProductionViewChecker({ resolvePublishedBusiness }) {
  if (typeof resolvePublishedBusiness !== 'function') throw new TypeError('trusted registry resolver required');
  async function checkValidated(rawViewBytes, trustedContext) {
    let spec;
    try { spec = JSON.parse(canonicalizeBytes(rawViewBytes).canonical); }
    catch (error) { return report([diagnostic(error.errorCode ?? 'CANON_JSON_INVALID', '$')]); }
    const shape = validateStructure('view-schema/lce-safe-v1', 'spec', spec);
    if (shape.length) return report(shape);
    let context;
    try { context = structuredClone(trustedContext); }
    catch { return report([diagnostic('TRUSTED_CONTEXT_REQUIRED', '$')]); }
    const source = context?.sourceIdentity, expected = context?.expectedBusinessRef;
    if (!object(source) || !equal(Object.keys(source).sort(), [...IDENTITY_KEYS].sort()) ||
        validateDefinition('AssetRef', { ...source, version: 1, digest: `sha256:${'0'.repeat(64)}` }).length ||
        source.scope_type !== 'TENANT' || source.asset_type !== 'VIEW_SCHEMA' ||
        !object(expected) || validateDefinition('AssetRef', expected).length ||
        expected.asset_type !== 'BUSINESS_SCHEMA' || !namespaceMatches(source, expected)) {
      return report([diagnostic('TRUSTED_CONTEXT_REQUIRED', '$')]);
    }
    const { ajv, schemas } = loadBundle();
    const nodeIdSchema = schemas.get('view-schema.lce-safe-v1.schema.json').$defs.ViewNode.properties.id;
    if (!ajv.compile({ type: 'array', items: nodeIdSchema })(context.deletedNodeIds))
      return report([diagnostic('TRUSTED_HISTORY_REQUIRED', '$')]);
    const unsupportedErrors = unsupported(spec);
    if (unsupportedErrors.length) return report(unsupportedErrors);
    let catalog;
    try { catalog = resolveComponentCatalog(spec.componentRegistryRef); }
    catch (error) {
      return report([diagnostic(error.code === 'CATALOG_REFERENCE_MISMATCH' ? 'VIEW_COMPONENT_UNREGISTERED' : 'DEPENDENCY_VALIDATOR_UNAVAILABLE', 'componentRegistryRef')]);
    }
    const dependencies = [structuredClone(spec.componentRegistryRef)];
    const ref = spec.businessSchemaRef;
    const fail = code => report([diagnostic(code, 'businessSchemaRef')], dependencies);
    if (!namespaceMatches(source, ref)) return fail('ASSET_REF_OUT_OF_SCOPE');
    if (ref.asset_id !== expected.asset_id) return fail('ASSET_NOT_FOUND');
    if (ref.version !== expected.version) return fail('VIEW_REFERENCE_VERSION_CONFLICT');
    if (ref.digest !== expected.digest) return fail('ASSET_DIGEST_MISMATCH');
    let snapshot;
    try {
      const resolved = await resolvePublishedBusiness(structuredClone(ref));
      snapshot = resolved === null || resolved === undefined ? null : structuredClone(resolved);
    } catch { return fail('DEPENDENCY_VALIDATOR_UNAVAILABLE'); }
    if (!snapshot) return fail('ASSET_NOT_FOUND');
    if (!equal(snapshot.ref, ref)) return fail('ASSET_NOT_FOUND');
    const registered = snapshot.registered;
    if (!object(registered)) return fail('ASSET_REGISTRATION_UNAVAILABLE');
    if (!['PUBLISHED', 'SUPERSEDED'].includes(registered.lifecycle)) return fail('ASSET_NOT_PUBLISHED');
    if (validateStructure('business-schema/v1', 'registered', registered).length)
      return fail('ASSET_REGISTRATION_UNAVAILABLE');
    const registration = snapshot.registration, publication = snapshot.publication;
    if (!object(registration) || !object(publication) || !equal(registration.identity, identity(ref)) ||
        registration.schema_id !== registered.schema_id || registration.schema_code !== registered.spec.schema_code ||
        !equal(publication.reference, ref) || publication.schema_id !== registered.schema_id ||
        publication.schema_code !== registered.spec.schema_code ||
        !id(publication.published_record_id) || !id(publication.approved_record_id))
      return fail('ASSET_REGISTRATION_UNAVAILABLE');
    if (registered.scope_type !== ref.scope_type || registered.scope_id !== ref.scope_id || registered.version !== ref.version)
      return fail('ASSET_REGISTRATION_UNAVAILABLE');
    let digest;
    try { digest = canonicalizeJson(JSON.stringify(registered.spec)).digest; }
    catch { return fail('ASSET_DIGEST_MISMATCH'); }
    if (registered.canonicalization_profile !== 'kvvi-json-c14n/v1' || registered.checksum !== ref.digest || digest !== ref.digest)
      return fail('ASSET_DIGEST_MISMATCH');
    dependencies.push(structuredClone(ref));
    return report(checkViewTree(spec, { components: catalog.components, modelFields: registered.spec.fields,
      deletedNodeIds: context.deletedNodeIds, allowRoot: definition => definition.allowedParents.includes('$root') }), dependencies);
  }
  return Object.freeze({
    async check(rawViewBytes, trustedContext) {
      try { return await checkValidated(rawViewBytes, trustedContext); }
      catch { return report([diagnostic('DEPENDENCY_VALIDATOR_UNAVAILABLE', '$')]); }
    },
  });
}

/** Internal identity reservation, never a public schema upload or publication. */
import { withTransaction } from './db.mjs';
import { requireDirectoryBuilder, uuid } from './business-directory.mjs';
import { loadBundle, validateDefinition } from '../../../tools/meta-schema/node/structure.mjs';
import { canonicalizeJson } from '../../../tools/meta-schema/node/canonical.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Namespace comes from the host's authorized plan, not a schema_code guess.
 * No HTTP/AI route invokes this API. Full app/module policy remains separate.
 */
export async function reserveBusinessIdentity(ctx, request) {
  let context, input;
  try { context = structuredClone(ctx); input = structuredClone(request); }
  catch { fail('KVVI_REGISTRY_INPUT_INVALID'); }
  if (!uuid(context?.companyId) || !uuid(context?.userId) || !uuid(context?.sessionId) || context.gateway !== 'BUILDER')
    fail('KVVI_BUILDER_REQUIRED');
  if (!keys(input, ['namespace', 'schemaCode', 'traceId']) || !keys(input.namespace, ['app_id', 'module_id', 'asset_id']) ||
      typeof input.traceId !== 'string' || input.traceId.length === 0) fail('KVVI_REGISTRY_INPUT_INVALID');
  // pg's UTF-8 transport replaces lone surrogates; PostgreSQL text also cannot
  // represent U+0000. Reject before transport rather than aliasing identities.
  try { canonicalizeJson(JSON.stringify(input)); }
  catch { fail('KVVI_REGISTRY_INPUT_INVALID'); }
  if ([...Object.values(input.namespace), input.schemaCode, input.traceId].some(value => typeof value === 'string' && value.includes('\0')))
    fail('KVVI_REGISTRY_INPUT_INVALID');
  const identity = { scope_type: 'TENANT', scope_id: context.companyId, ...input.namespace, asset_type: 'BUSINESS_SCHEMA' };
  if (validateDefinition('AssetRef', { ...identity, version: 1, digest: `sha256:${'0'.repeat(64)}` }).length)
    fail('KVVI_REGISTRY_INPUT_INVALID');
  const { ajv, schemas } = loadBundle();
  if (!ajv.compile(schemas.get('business-schema.v1.schema.json').$defs.MachineCode)(input.schemaCode))
    fail('KVVI_REGISTRY_INPUT_INVALID');
  return withTransaction('platform', async client => {
    await client.query("SELECT set_config('kvvi.company_id',$1,true),set_config('kvvi.user_id',$2,true),set_config('kvvi.session_id',$3,true)",
      [context.companyId, context.userId, context.sessionId]);
    await client.query('SELECT kvvi_registry_private.lock_business_namespace($1,$2,$3)',
      [context.companyId, input.namespace.app_id, input.namespace.module_id]);
    // Standard revocation updates the account version before ending sessions.
    // Borrow the same client throughout; no checkout while holding the lock.
    await client.query('SELECT 1 FROM users WHERE user_id=$1 FOR SHARE', [context.userId]);
    await client.query('SELECT 1 FROM sessions WHERE session_id=$1 FOR SHARE', [context.sessionId]);
    await client.query('SELECT 1 FROM memberships WHERE company_id=$1 AND user_id=$2 FOR SHARE', [context.companyId, context.userId]);
    await requireDirectoryBuilder(context, client);
    const { rows } = await client.query('SELECT * FROM kvvi_registry_private.reserve_business_identity($1,$2,$3,$4,$5,$6,$7,$8)',
      [context.companyId, input.namespace.app_id, input.namespace.module_id, input.namespace.asset_id,
        input.schemaCode, context.userId, context.sessionId, input.traceId]);
    if (rows.length !== 1) fail('KVVI_REGISTRY_UNAVAILABLE');
    const row = rows[0];
    return { identity: { scope_type: 'TENANT', scope_id: row.company_id, app_id: row.app_id, module_id: row.module_id,
      asset_type: 'BUSINESS_SCHEMA', asset_id: row.asset_id }, schema_id: row.schema_id, schema_code: row.schema_code,
      created_by: row.created_by, created_session_id: row.created_session_id, created_at: row.created_at.toISOString(), trace_id: row.trace_id };
  });
}

import { beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { A, B, resetDatabase, grantPlatformRole, makeSession, adminQuery, pool, closeAll } from './harness.mjs';
import { reserveBusinessIdentity } from '../src/business-identity.mjs';
import { grantBuilderAccess, revokeBuilderAccess } from '../src/mode-policy.mjs';

let builder, foreign, employee;
const request = () => ({ namespace: { app_id: 'app-one', module_id: 'module-one', asset_id: 'stable-object-42' },
  schemaCode: 'general_item', traceId: 'identity-test-' + randomUUID() });
beforeEach(async () => {
  await resetDatabase();
  await grantPlatformRole(A.alice, 'owner'); await grantPlatformRole(B.dave, 'owner', B.company);
  builder = (await makeSession(A.alice, A.company, 'BUILDER')).ctx;
  foreign = (await makeSession(B.dave, B.company, 'BUILDER')).ctx;
  employee = (await makeSession(A.carol, A.company)).ctx;
});
after(closeAll);
const rows = () => adminQuery('kvvi_platform', 'SELECT * FROM kvvi_registry_private.business_identities');

test('parallel identity reservation generates one stable UUID and immutable database creation provenance', async () => {
  const input = request();
  const earliest = (await adminQuery('kvvi_platform', 'SELECT clock_timestamp() AS at')).rows[0].at;
  const results = await Promise.all(Array.from({ length: 32 }, () => reserveBusinessIdentity(builder, input)));
  assert.equal(new Set(results.map(x => x.schema_id)).size, 1);
  const result = results[0];
  assert.match(result.schema_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(result.identity, { scope_type: 'TENANT', scope_id: A.company, ...input.namespace, asset_type: 'BUSINESS_SCHEMA' });
  assert.notEqual(result.schema_id, input.namespace.asset_id); assert.notEqual(result.schema_id, input.schemaCode);
  assert.equal(result.schema_code, input.schemaCode); assert.equal(result.created_by, A.alice);
  assert.equal(result.created_session_id, builder.sessionId); assert.equal(result.trace_id, input.traceId);
  assert.ok(new Date(result.created_at) >= earliest);
  assert.equal((await rows()).rowCount, 1);
  const retried = await reserveBusinessIdentity(builder, { ...input, traceId: 'later-attempt' });
  assert.deepEqual(retried, result);
  for (const key of ['version', 'lifecycle', 'registered', 'checksum', 'releaseApproved']) assert.equal(Object.hasOwn(result, key), false);
});

test('company app module and explicit null dimensions retain distinct stable identities', async () => {
  const input = request();
  const results = [await reserveBusinessIdentity(builder, input), await reserveBusinessIdentity(foreign, input)];
  for (const namespace of [
    { ...input.namespace, app_id: 'app-two' }, { ...input.namespace, module_id: 'module-two' },
    { ...input.namespace, app_id: null }, { ...input.namespace, module_id: null },
    { ...input.namespace, app_id: null, module_id: null },
    { ...input.namespace, app_id: 'null', module_id: null },
  ]) results.push(await reserveBusinessIdentity(builder, { ...input, namespace }));
  assert.equal(new Set(results.map(x => x.schema_id)).size, 8); assert.equal((await rows()).rowCount, 8);
});

test('parallel different assets cannot take the same namespace code and huge stable IDs retain their exact identity', async () => {
  const input = request();
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveBusinessIdentity(builder,
    { ...input, namespace: { ...input.namespace, asset_id: 'candidate-' + i } })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.ok(results.filter(x => x.status === 'rejected').every(x => /KVVI_REGISTRY_CODE_CONFLICT/u.test(x.reason.message)));
  const huge = { ...input, namespace: { app_id: 'a'.repeat(12000), module_id: '😀'.repeat(2000), asset_id: 'z'.repeat(12000) } };
  const saved = await reserveBusinessIdentity(builder, huge);
  assert.deepEqual(saved.identity.app_id, huge.namespace.app_id);
  assert.deepEqual(await reserveBusinessIdentity(builder, huge), saved);
});

test('changing the bound schema code or assigning it to another asset fails without replacing the original mapping', async () => {
  const input = request(), saved = await reserveBusinessIdentity(builder, input);
  await assert.rejects(() => reserveBusinessIdentity(builder, { ...input, schemaCode: 'other_code' }), /KVVI_REGISTRY_IDENTITY_CONFLICT/u);
  await assert.rejects(() => reserveBusinessIdentity(builder, { ...input, namespace: { ...input.namespace, asset_id: 'another-object' } }), /KVVI_REGISTRY_CODE_CONFLICT/u);
  assert.deepEqual(await reserveBusinessIdentity(builder, input), saved); assert.equal((await rows()).rowCount, 1);
});

test('identity input rejects omitted dimensions and caller-supplied server identity or lifecycle fields', async () => {
  const input = request();
  const missing = structuredClone(input); delete missing.namespace.app_id;
  for (const candidate of [missing, { ...input, schema_id: randomUUID() }, { ...input, lifecycle: 'PUBLISHED' },
    { ...input, namespace: { ...input.namespace, scope_id: B.company } }, { ...input, schemaCode: 'bad\n' }])
    await assert.rejects(() => reserveBusinessIdentity(builder, candidate), /KVVI_REGISTRY_INPUT_INVALID/u);
  assert.equal((await rows()).rowCount, 0);
});

test('invalid Unicode cannot alias a valid replacement-character identity through the PostgreSQL transport', async () => {
  const input = request();
  const valid = { ...input, namespace: { ...input.namespace, asset_id: '\uFFFD' } };
  const saved = await reserveBusinessIdentity(builder, valid);
  for (const field of ['app_id', 'module_id', 'asset_id']) {
    for (const invalid of ['\uD800', '\uDC00', 'nul\u0000id'])
      await assert.rejects(() => reserveBusinessIdentity(builder, { ...input, namespace: { ...input.namespace, [field]: invalid } }), /KVVI_REGISTRY_INPUT_INVALID/u);
  }
  for (const traceId of ['trace\uD800', 'trace\u0000'])
    await assert.rejects(() => reserveBusinessIdentity(builder, { ...input, traceId }), /KVVI_REGISTRY_INPUT_INVALID/u);
  assert.deepEqual(await reserveBusinessIdentity(builder, valid), saved); assert.equal((await rows()).rowCount, 1);
});

test('employee forged cross-company ended and stale sessions cannot reserve identities', async () => {
  await assert.rejects(() => reserveBusinessIdentity(employee, request()), /KVVI_BUILDER_REQUIRED/u);
  await assert.rejects(() => reserveBusinessIdentity({ ...builder, companyId: B.company }, request()), /KVVI_BUILDER_REQUIRED/u);
  await adminQuery('kvvi_platform', 'UPDATE users SET authz_version=authz_version+1 WHERE user_id=$1', [A.alice]);
  await assert.rejects(() => reserveBusinessIdentity(builder, request()), /KVVI_BUILDER_REQUIRED/u);
  await adminQuery('kvvi_platform', "UPDATE sessions SET state='ENDED',ended_by='LOGOUT',ended_at=now() WHERE session_id=$1", [foreign.sessionId]);
  await assert.rejects(() => reserveBusinessIdentity(foreign, request()), /KVVI_BUILDER_REQUIRED/u);
  assert.equal((await rows()).rowCount, 0);
});

test('a reservation queued on current identity authorization observes revocation before any mapping is inserted', async () => {
  const gate = await pool('platform').connect();
  await gate.query('BEGIN'); await gate.query('SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE', [A.alice]);
  const pending = reserveBusinessIdentity(builder, request()); void pending.catch(() => {});
  try {
    let waited = false; const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const waiting = await adminQuery('kvvi_platform', "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%users%FOR SHARE%'");
      if (waiting.rowCount) { waited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waited, true, 'must reach the actual user lock');
    await gate.query('UPDATE users SET authz_version=authz_version+1 WHERE user_id=$1', [A.alice]);
    await gate.query('COMMIT');
    await assert.rejects(() => pending, /KVVI_BUILDER_REQUIRED/u); assert.equal((await rows()).rowCount, 0);
  } finally { await gate.query('ROLLBACK'); gate.release(); await Promise.allSettled([pending]); }
});

test('a reservation waiting on the namespace lock rechecks actual Builder withdrawal after the wait', async () => {
  await grantBuilderAccess(builder, A.bob);
  const delegated = (await makeSession(A.bob, A.company, 'BUILDER')).ctx;
  const gate = await pool('platform').connect(), input = request();
  await gate.query('BEGIN');
  await gate.query("SELECT set_config('kvvi.company_id',$1,true),set_config('kvvi.user_id',$2,true),set_config('kvvi.session_id',$3,true)", [A.company, A.alice, builder.sessionId]);
  await gate.query('SELECT kvvi_registry_private.lock_business_namespace($1,$2,$3)', [A.company, input.namespace.app_id, input.namespace.module_id]);
  const pending = reserveBusinessIdentity(delegated, input); void pending.catch(() => {});
  try {
    let waited = false; const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await adminQuery('kvvi_platform', "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT kvvi_registry_private.lock_business_namespace%'")).rowCount) { waited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waited, true);
    await revokeBuilderAccess(builder, A.bob);
    await gate.query('COMMIT');
    await assert.rejects(() => pending, /KVVI_BUILDER_REQUIRED/u);
    assert.equal((await rows()).rowCount, 0);
  } finally { await gate.query('ROLLBACK'); gate.release(); await Promise.allSettled([pending]); }
});

test('private storage rejects direct SQL mutations and the controlled function requires matching transaction context', async () => {
  const input = request(), saved = await reserveBusinessIdentity(builder, input);
  for (const statement of [
    'SELECT * FROM kvvi_registry_private.business_identities',
    "INSERT INTO kvvi_registry_private.business_identities DEFAULT VALUES",
    "UPDATE kvvi_registry_private.business_identities SET schema_code='changed'",
    'DELETE FROM kvvi_registry_private.business_identities', 'TRUNCATE kvvi_registry_private.business_identities',
    'CREATE TABLE kvvi_registry_private.untrusted(x integer)', 'SET ROLE kvvi_registry_owner',
  ]) await assert.rejects(() => pool('platform').query(statement), error => error.code === '42501');
  const sql = 'SELECT * FROM kvvi_registry_private.reserve_business_identity($1,$2,$3,$4,$5,$6,$7,$8)';
  const values = [A.company, 'app-one', 'module-one', 'stable-object-42', 'general_item', A.alice, builder.sessionId, 'direct-test'];
  await assert.rejects(() => pool('platform').query(sql, values), /KVVI_REGISTRY_CONTEXT_REQUIRED/u);
  const client = await pool('platform').connect();
  try {
    for (const context of [[B.company, A.alice, builder.sessionId], [A.company, '', builder.sessionId],
      [A.company, A.alice, ''], [A.company, A.bob, builder.sessionId], [A.company, A.alice, foreign.sessionId]]) {
      await client.query('BEGIN');
      await client.query("SELECT set_config('kvvi.company_id',$1,true),set_config('kvvi.user_id',$2,true),set_config('kvvi.session_id',$3,true)", context);
      await assert.rejects(() => client.query(sql, values), /KVVI_REGISTRY_CONTEXT_REQUIRED/u);
      await client.query('ROLLBACK');
    }
  } finally { await client.query('ROLLBACK'); client.release(); }
  await assert.rejects(() => adminQuery('kvvi_platform', "UPDATE kvvi_registry_private.business_identities SET schema_code='changed'"), /KVVI_REGISTRY_IMMUTABLE/u);
  await assert.rejects(() => adminQuery('kvvi_platform', 'DELETE FROM kvvi_registry_private.business_identities'), /KVVI_REGISTRY_IMMUTABLE/u);
  await assert.rejects(() => adminQuery('kvvi_platform', 'TRUNCATE kvvi_registry_private.business_identities'), /KVVI_REGISTRY_IMMUTABLE/u);
  assert.deepEqual(await reserveBusinessIdentity(builder, input), saved);
});

test('the function rolls back with its host transaction and forced RLS does not expose other company identities to its owner', async () => {
  const input = request(); await reserveBusinessIdentity(builder, input); await reserveBusinessIdentity(foreign, input);
  const client = await pool('platform').connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('kvvi.company_id',$1,true),set_config('kvvi.user_id',$2,true),set_config('kvvi.session_id',$3,true)", [A.company, A.alice, builder.sessionId]);
    await client.query('SELECT * FROM kvvi_registry_private.reserve_business_identity($1,$2,$3,$4,$5,$6,$7,$8)',
      [A.company, 'rollback-app', null, 'rollback-object', 'rollback_code', A.alice, builder.sessionId, 'rollback-test']);
    await client.query('ROLLBACK');
  } finally { await client.query('ROLLBACK'); client.release(); }
  assert.equal((await rows()).rowCount, 2);
  const missing = await adminQuery('kvvi_platform', 'BEGIN; SET LOCAL ROLE kvvi_registry_owner; SELECT count(*)::int n FROM kvvi_registry_private.business_identities; ROLLBACK');
  assert.equal(missing[2].rows[0].n, 0);
  const scoped = await adminQuery('kvvi_platform', "BEGIN; SET LOCAL ROLE kvvi_registry_owner; SELECT set_config('kvvi.company_id','" + A.company + "',true); SELECT count(*)::int n FROM kvvi_registry_private.business_identities; ROLLBACK");
  assert.equal(scoped[3].rows[0].n, 1);
});

test('incremental migration preserves mappings and never manufactures identities for legacy published contracts', async () => {
  const input = request(), saved = await reserveBusinessIdentity(builder, input);
  const draftId = randomUUID();
  await adminQuery('kvvi_platform', "INSERT INTO publish_drafts(draft_id,company_id,proposer_user_id,status,change_digest,approved_by) VALUES($1,$2,$3,'PUBLISHED','legacy-change',$4)", [draftId, A.company, A.alice, A.bob]);
  const legacyRecord = (await adminQuery('kvvi_platform', "INSERT INTO publish_records(draft_id,company_id,change_digest,approved_by,published_by,diff_digest) VALUES($1,$2,'legacy-change',$3,$3,'legacy-diff') RETURNING record_id", [draftId, A.company, A.bob])).rows[0].record_id;
  await adminQuery('kvvi_platform', "INSERT INTO published_contracts(company_id,contract_type,asset_id,version,digest,content,published_record) VALUES($1,'business-schema','legacy-system',1,'old-digest','{\"fields\":[]}', $2)", [A.company, legacyRecord]);
  const legacyCount = (await adminQuery('kvvi_platform', 'SELECT count(*)::int n FROM published_contracts')).rows[0].n;
  assert.equal(legacyCount, 1, 'a real legacy row must exist before migration');
  execFileSync(process.execPath, [fileURLToPath(new URL('../src/migrate.mjs', import.meta.url))], { env: { ...process.env, KVVI_RESET: '0' }, stdio: 'pipe' });
  // Emulate a lost connection after SQL42's COMMIT but before applyFile writes
  // its separate ledger row. Existing identities must survive the actual rerun.
  await adminQuery('kvvi_platform', "DELETE FROM schema_migrations WHERE file='42-business-identities.sql'");
  execFileSync(process.execPath, [fileURLToPath(new URL('../src/migrate.mjs', import.meta.url))], { env: { ...process.env, KVVI_RESET: '0' }, stdio: 'pipe' });
  assert.equal((await adminQuery('kvvi_platform', "SELECT 1 FROM schema_migrations WHERE file='42-business-identities.sql'")).rowCount, 1);
  assert.deepEqual(await reserveBusinessIdentity(builder, input), saved);
  assert.equal((await rows()).rowCount, 1);
  assert.equal((await adminQuery('kvvi_platform', 'SELECT count(*)::int n FROM published_contracts')).rows[0].n, legacyCount);
  await assert.rejects(() => pool('platform').query('SELECT * FROM kvvi_registry_private.business_identities'), error => error.code === '42501');
  await assert.rejects(() => pool('platform').query('CREATE TABLE kvvi_registry_private.after_migrate(x integer)'), error => error.code === '42501');
  await assert.rejects(() => pool('platform').query('SET ROLE kvvi_registry_owner'), error => error.code === '42501');
});

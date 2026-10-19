import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { append, verifyChain } from '../src/audit.mjs'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, adminQuery } from './harness.mjs'

before(resetDatabase)
after(closeAll)
const entry = {
  companyId: A.company, actorKind: 'USER', actorId: A.alice, gateway: 'USER',
  action: 'record.update', resourceKind: 'record', resourceId: randomUUID(),
  outcome: 'ALLOW', paramsDigest: 'test-digest',
}

test('response loss: retrying the same operation appends one audit entry', async () => {
  const operationId = randomUUID()
  const first = await append({ ...entry, operationId }) // discard response as if transport lost it
  const retried = await append({ ...entry, operationId })
  assert.equal(retried, first)
  const { rows } = await adminQuery('kvvi_audit',
    'SELECT count(*)::int n FROM audit_entries WHERE entry_hash=$1', [first])
  assert.equal(rows[0].n, 1)
  assert.equal((await verifyChain()).ok, true)
})

test('concurrent deliveries across connections append exactly once', async () => {
  const operationId = randomUUID()
  const hashes = await Promise.all(Array.from({ length: 16 }, () => append({ ...entry, operationId })))
  assert.equal(new Set(hashes).size, 1)
  const { rows } = await adminQuery('kvvi_audit',
    'SELECT count(*)::int n FROM audit_operation_receipts WHERE operation_id=$1', [operationId])
  assert.equal(rows[0].n, 1)
  assert.equal((await verifyChain()).ok, true)
})

test('the same operation cannot change payload, actor or company', async () => {
  const operationId = randomUUID()
  await append({ ...entry, operationId })
  for (const change of [{ paramsDigest: 'changed' }, { actorId: A.bob }, { companyId: B.company }]) {
    await assert.rejects(() => append({ ...entry, ...change, operationId }),
      /KVVI_AUDIT_OPERATION_CONFLICT/)
  }
})

test('receipt insertion failure rolls back its audit entry too', async () => {
  const { rows: before } = await adminQuery('kvvi_audit', 'SELECT count(*)::int n FROM audit_entries')
  await adminQuery('kvvi_audit', `CREATE FUNCTION reject_audit_receipt() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'injected receipt storage failure'; END $$;
    CREATE TRIGGER reject_receipt BEFORE INSERT ON audit_operation_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_audit_receipt()`)
  try {
    await assert.rejects(() => append({ ...entry, operationId: randomUUID() }), /injected receipt/)
  } finally {
    await adminQuery('kvvi_audit', 'DROP TRIGGER reject_receipt ON audit_operation_receipts; DROP FUNCTION reject_audit_receipt()')
  }
  const { rows: after } = await adminQuery('kvvi_audit', 'SELECT count(*)::int n FROM audit_entries')
  assert.equal(after[0].n, before[0].n)
})

test('writer cannot read, insert or mutate receipts; reader cannot deliver', async () => {
  for (const name of ['audit', 'auditRead']) {
    await assert.rejects(() => pool(name).query('CREATE FUNCTION public.receipt_privilege_probe() RETURNS text LANGUAGE sql AS $$ SELECT \'bad\' $$'), { code: '42501' })
  }
  for (const sql of ['SELECT * FROM audit_operation_receipts',
    `INSERT INTO audit_operation_receipts VALUES (gen_random_uuid(),'digest','hash')`]) {
    await assert.rejects(() => pool('audit').query(sql), { code: '42501' })
  }
  const before = (await adminQuery('kvvi_audit', 'SELECT * FROM audit_operation_receipts ORDER BY operation_id')).rows
  for (const privilege of ['UPDATE', 'DELETE']) {
    const { rows } = await pool('audit').query(
      `SELECT has_table_privilege(current_user,'audit_operation_receipts',$1) allowed`, [privilege])
    assert.equal(rows[0].allowed, false)
  }
  // PostgreSQL rewrites DO INSTEAD NOTHING rules before permission checks; verify no effect.
  await pool('audit').query('UPDATE audit_operation_receipts SET request_digest=\'changed\'')
  await pool('audit').query('DELETE FROM audit_operation_receipts')
  assert.deepEqual((await adminQuery('kvvi_audit', 'SELECT * FROM audit_operation_receipts ORDER BY operation_id')).rows, before)
  await assert.rejects(() => pool('auditRead').query(
    `SELECT audit_append_once($1,$2,'USER',$3,'USER',NULL,'record.update','record','x','ALLOW',NULL,NULL,NULL)`,
    [randomUUID(), A.company, A.alice]), { code: '42501' })
})

test('migration retry after SQL commit but before ledger recording preserves deliveries', async () => {
  const operationId = randomUUID()
  const hash = await append({ ...entry, operationId })
  await adminQuery('kvvi_audit', "DELETE FROM schema_migrations WHERE file='35-audit-operation-receipts.sql'")
  execFileSync(process.execPath, [fileURLToPath(new URL('../src/migrate.mjs',import.meta.url))], { env: process.env, stdio: 'pipe' })
  assert.equal(await append({ ...entry, operationId }), hash)
})

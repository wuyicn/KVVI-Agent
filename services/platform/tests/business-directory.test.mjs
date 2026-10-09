import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { A, B, resetDatabase, adminQuery, closeAll, pool } from './harness.mjs'
import { withTransaction } from '../src/db.mjs'
before(resetDatabase)
after(closeAll)

test('directory migration creates tenant-scoped metadata without copying records', async () => {
  const found = await adminQuery('kvvi_business', "SELECT to_regclass('business_groups') AS groups")
  assert.equal(found.rows[0].groups, 'business_groups')
  const {rows} = await adminQuery('kvvi_business','SELECT * FROM business_form_directory')
  assert.equal(rows.length,0)
  assert.equal((await adminQuery('kvvi_business','SELECT count(*)::int AS n FROM business_records')).rows[0].n,5)
})
test('cross-company group reference is rejected by the database', async () => {
  const gid=randomUUID()
  await adminQuery('kvvi_business','INSERT INTO business_groups(company_id,group_id,name) VALUES($1,$2,$3)',[B.company,gid,'B group'])
  await assert.rejects(adminQuery('kvvi_business','INSERT INTO business_form_directory(company_id,asset_id,group_id) VALUES($1,$2,$3)',[A.company,'general_item',gid]), {code:'23503'})
})
test('runtime role sees only the selected company; missing scope sees nothing', async () => {
  await adminQuery('kvvi_business','INSERT INTO business_groups(company_id,group_id,name) VALUES($1,$2,$3)',[A.company,randomUUID(),'A group'])
  assert.equal((await pool('business').query('SELECT * FROM business_groups')).rows.length,0)
  await withTransaction('business',async c => {
    await c.query("SELECT set_config('kvvi.company_id',$1,true)",[A.company])
    assert.deepEqual((await c.query('SELECT name FROM business_groups')).rows.map(r=>r.name),['A group'])
    await assert.rejects(c.query('INSERT INTO business_groups(company_id,group_id,name) VALUES($1,$2,$3)',[B.company,randomUUID(),'forged']),{code:'42501'})
  })
})
test('incremental rerun preserves all records and metadata', async () => {
  const snapshot=async () => (await adminQuery('kvvi_business','SELECT * FROM business_records ORDER BY record_id')).rows
  const before=await snapshot()
  execFileSync(process.execPath,['src/migrate.mjs'],{env:{...process.env,KVVI_RESET:'0'},stdio:'pipe'})
  assert.deepEqual(await snapshot(),before)
  const ledger=await adminQuery('kvvi_business',"SELECT count(*)::int n FROM schema_migrations WHERE file='31-business-directory.sql'")
  assert.equal(ledger.rows[0].n,1)
})

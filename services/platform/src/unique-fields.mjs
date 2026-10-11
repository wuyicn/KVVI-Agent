/** Published UNIQUE indexes apply across all company records, not just visible rows. */
import { FieldRuleError } from './field-rules.mjs'
import { pool } from './db.mjs'

const pendingError = () => {
  const error = new FieldRuleError('KVVI_UNIQUE_PUBLICATION_PENDING', [])
  error.status = 409
  return error
}

async function draftStatus(companyId, draftId) {
  const { rows } = await pool('platform').query('SELECT status FROM publish_drafts WHERE company_id=$1 AND draft_id=$2', [companyId, draftId])
  return rows[0]?.status
}

/** The draft identity and matching model must both prove completion; identical content alone is insufficient. */
async function pendingPublication(client, companyId, assetId, model) {
  const { rows } = await client.query('SELECT draft_id, expected_model=$3::jsonb AS same_model FROM business_rule_publications WHERE company_id=$1 AND asset_id=$2',
    [companyId, assetId, JSON.stringify(model)])
  const pending = rows[0]
  if (pending?.same_model && await draftStatus(companyId, pending.draft_id) === 'PUBLISHED') {
    await client.query('DELETE FROM business_rule_publications WHERE company_id=$1 AND asset_id=$2', [companyId, assetId])
    return undefined
  }
  return pending
}

/** Called under the form lock after reading the published model. */
export async function assertUniquePublicationReady(client, companyId, assetId, model) {
  if (await pendingPublication(client, companyId, assetId, model)) throw pendingError()
}

/** Commit this fence before publishing the model; only the same draft may resume an unfinished publication. */
export async function stageUniquePublication(client, companyId, assetId, draftId, model, publishedModel) {
  if (await draftStatus(companyId, draftId) !== 'APPROVED') throw pendingError()
  await pendingPublication(client, companyId, assetId, publishedModel)
  const { rows } = await client.query('SELECT draft_id, expected_model=$3::jsonb AS same_model FROM business_rule_publications WHERE company_id=$1 AND asset_id=$2',
    [companyId, assetId, JSON.stringify(model)])
  if (rows.length && (rows[0].draft_id !== draftId || !rows[0].same_model)) throw pendingError()
  await client.query('INSERT INTO business_rule_publications(company_id,asset_id,draft_id,expected_model) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
    [companyId, assetId, draftId, JSON.stringify(model)])
}

/** Serialize writes and publication before reading the current model or record. */
export async function lockUniqueFields(client, companyId, assetId) {
  const { rows } = await client.query("SELECT current_setting('transaction_isolation') AS isolation")
  if (rows[0].isolation !== 'read committed') throw new Error('KVVI_UNIQUE_ISOLATION_REQUIRED')
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('field-unique',$1::uuid,$2::text)::text,0))", [companyId, assetId])
}

/** Null data checks existing rows before publication; errors reveal no conflicting record. */
export async function assertUniqueFields(client, companyId, assetId, model, data = null, excluded = null) {
  if (model?.indexes === undefined) return
  const invalid = () => { throw new FieldRuleError('KVVI_UNIQUE_RULE_INVALID', []) }
  if (!Array.isArray(model.indexes)) invalid()
  const declared = new Map((model.fields ?? []).map(f => [f.field_code, f]))
  const numberField = model.record_number?.field_code
  if (numberField !== undefined) declared.set(numberField, { type: 'short_text' })
  const names = new Set()
  for (const index of model.indexes) {
    if (!index || !['NORMAL', 'UNIQUE'].includes(index.kind)) invalid()
    if (index.kind === 'NORMAL') continue
    const fields = index.fields
    if (typeof index.index_code !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(index.index_code) || names.has(index.index_code)
        || !Array.isArray(fields) || fields.length < 1 || fields.length > 4
        || new Set(fields).size !== fields.length
        || fields.some(f => typeof f !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(f)
          || !declared.has(f) || declared.get(f).type === 'long_text')) invalid()
    names.add(index.index_code)
    // Generated record numbers already have a company/form-scoped database unique constraint.
    if (numberField !== undefined && fields.includes(numberField)) continue
    const { rows } = await client.query('SELECT kvvi_unique_conflict($1,$2,$3,$4,$5) AS conflict',
      [companyId, assetId, fields, data === null ? null : JSON.stringify(data), excluded])
    if (rows[0].conflict) {
      const error = new FieldRuleError(data === null ? 'KVVI_UNIQUE_EXISTING_DUPLICATES' : 'KVVI_FIELD_DUPLICATE', [])
      error.status = 409
      throw error
    }
  }
}

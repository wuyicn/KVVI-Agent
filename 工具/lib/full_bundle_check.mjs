/**
 * 全量 bundle 的结构校验器 —— 覆盖 cli.mjs 不支持的那些契约。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 *
 * `tools/meta-schema/node/cli.mjs` 的 `CONTRACTS` 白名单**只有三个**：
 * business-schema/v1、view-schema/lce-safe-v1、app-spec/v1alpha1。
 * 它加载的 bundle 是 `0a-core-r1`，而那个 bundle 里也只有这三个 schema。
 *
 * 但 `contracts/meta-schemas/0a-full-r1/` 有 **14 个 schema**（13 契约 + common），
 * 且带有 69 条 workflow-spec、34 条 tool-spec 等用例。
 *
 * ── 本脚本做与不做什么 ────────────────────────────────────────────────────
 *
 * **做**：加载全量 schema，对实例做**结构校验**（ajv + 与官方一致的 format 定义）。
 *
 * **不做**：语义校验与引用校验。那需要一个契约专用的语义模块
 * （如 business 的 `business.mjs`、view 的 `view.mjs`），
 * 而 **workflow-spec / tool-spec 没有这样的模块**。
 *
 * **所以本脚本给不出「完整校验」的结论** —— 它的输出里会显式写明这一点，
 * 不让人误以为跑过了就万事大吉。
 *
 * 用法：node full_bundle_check.mjs <contract-id> <instance.json>
 *   contract-id 形如 workflow-spec-v1alpha1（schema 的 $id 末段）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from '../../tools/meta-schema/node/node_modules/ajv/dist/2020.js'
import addFormats from '../../tools/meta-schema/node/node_modules/ajv-formats/dist/index.js'
import { validDate, validDatetime } from '../../tools/meta-schema/node/values.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BUNDLE = resolve(ROOT, 'contracts/meta-schemas/0a-full-r1')
const ID_PREFIX = 'urn:kvvi:meta-schema:0a-full-r1:'

/** 建一个与官方定义一致的校验器。format 定义取自 meta-schema/node/values.mjs。 */
function buildEngine() {
  const ajv = new Ajv2020({
    strict: false, allErrors: true, coerceTypes: false,
    useDefaults: false, removeAdditional: false, validateFormats: true,
  })
  addFormats(ajv)
  // 与官方一致：UUID 用固定语法，不用 ajv-formats 的 URN 扩展
  ajv.addFormat('uuid', {
    type: 'string',
    validate: v => /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(v),
  })
  ajv.addFormat('date', { type: 'string', validate: validDate })
  ajv.addFormat('date-time', { type: 'string', validate: validDatetime })
  for (const f of readdirSync(BUNDLE).filter(x => x.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(readFileSync(resolve(BUNDLE, f), 'utf8')))
  }
  return ajv
}

const [, , contractId, instancePath] = process.argv
if (!contractId || !instancePath) {
  process.stdout.write(JSON.stringify({
    error: 'usage: node full_bundle_check.mjs <contract-id> <instance.json>',
  }) + '\n')
  process.exit(1)
}

let validate
try {
  validate = buildEngine().getSchema(`${ID_PREFIX}${contractId}#/$defs/Spec`)
} catch (e) {
  process.stdout.write(JSON.stringify({ error: 'engine_failed', detail: String(e.message).slice(0, 300) }) + '\n')
  process.exit(1)
}
if (!validate) {
  process.stdout.write(JSON.stringify({ error: 'no_spec_definition', contract: contractId }) + '\n')
  process.exit(1)
}

const instance = JSON.parse(readFileSync(instancePath, 'utf8'))
const valid = Boolean(validate(instance))
const errors = (validate.errors ?? []).slice(0, 20).map(e => ({
  code: e.keyword, path: e.instancePath || '$', message: e.message,
}))

process.stdout.write(JSON.stringify({
  suite_revision: '0a-full-r1',
  contract: contractId,
  stage: 'structure',
  // ★ 显式声明本校验的边界，避免被读成「完整校验通过」
  scope: 'structure_only',
  coverage_note: '本契约在 cli.mjs 的 CONTRACTS 白名单之外，'
    + '且没有契约专用的语义模块；此结果不含语义校验与引用校验。',
  validation: { valid, errors },
  release_approved: false,
}, null, 2) + '\n')
process.exit(valid ? 0 : 2)

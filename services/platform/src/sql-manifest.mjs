/**
 * 迁移清单：**哪个库跑哪些 SQL 文件，只有这一处定义。**
 *
 * ── 为什么把它单独拿出来 ────────────────────────────────────────────────
 *
 * 这份名单此前只写在 `migrate.mjs` 的 `main()` 里（十二行 `applyFile`）。
 * 于是「哪个库该有哪些迁移」这件事**只有执行迁移的那一方知道** ——
 * 而另一件需要它的事是「**检查库跟没跟上代码**」：
 * 换了发行包、库还停在上一版，症状是平台起来了、第一次写请求才炸
 * （实测：`关系 "publish_drafts" 的 "payload" 字段不存在`，服务当场退出）。
 * 要提前判出来，就得有第二处知道这份名单 —— 而名单写两处，就会漂移一处。
 *
 * 所以：清单在这里，`migrate.mjs` 与平台启动期的自检都从它取。
 *
 * ## 迁移文件名与顺序
 *
 * 前缀号是**全局**递增的，不是每库一套：`20-business.sql` 排在
 * `19-instance-bootstrap.sql` 之后、`21-systems-and-contracts.sql` 之前，
 * 尽管它们落在不同的库上。跨库的先后关系是有意的（业务表要在平台表之后建），
 * 所以顺序由本文件的顺序决定，**不靠文件名排序**。
 *
 * @module kvvi-platform/sql-manifest
 */

/** 三个库各跑哪些文件，按执行顺序。 */
export const MIGRATIONS = Object.freeze({
  kvvi_platform: Object.freeze([
    '10-platform.sql',
    '15-visitor.sql',
    '16-publish.sql',
    '17-rate.sql',
    '18-retention.sql',
    '19-instance-bootstrap.sql',
    '21-systems-and-contracts.sql',
    '22-platform-mode-grants.sql',
    '23-idempotency.sql',
    '24-draft-payload.sql',
    '25-policy-flow-state.sql',
    '27-policy-field-required.sql',
    '28-company-branding.sql',
    '32-business-build-intents.sql',
  ]),
  // ⚠️ 业务库的迁移**同样按顺序**：26 依赖 20 建出来的 `business_records`，
  // 34 依赖 20 的函数（`kvvi_guc*`）与策略。
  kvvi_business: Object.freeze(['20-business.sql', '26-record-workflow-version.sql', '31-business-directory.sql', '33-field-uniqueness.sql', '34-scope-by-resource.sql']),
  kvvi_audit: Object.freeze(['30-audit.sql']),
})

/** 库名，按执行顺序。 */
export const DATABASES = Object.freeze(Object.keys(MIGRATIONS))

/**
 * 一个库的迁移是否都已在账本里。
 *
 * @param {string[]} applied 该库 `schema_migrations.file` 的全部取值
 * @param {string} database 库名
 * @returns {{behind: string[], extra: string[]}} 缺的、以及账本里多出来的
 */
export function schemaDelta(applied, database) {
  const want = new Set(MIGRATIONS[database] ?? [])
  const have = new Set(applied)
  return {
    // 顺序按清单，不按账本 —— 缺哪几个一目了然。
    behind: [...want].filter((file) => !have.has(file)),
    // 多出来的通常是**回滚**：库比代码新。这同样是不能忽略的状态，
    // 所以它单独返回，而不是被当成「没缺就是好」。
    extra: [...have].filter((file) => !want.has(file)).sort(),
  }
}

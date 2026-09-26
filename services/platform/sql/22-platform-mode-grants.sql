-- 迁移 22：搭建模式的显式授权表。
--
-- ── 为什么单独一个文件 ────────────────────────────────────────────────────
--
-- 这张表原先被加进了 `10-platform.sql`。对**已有数据的库**，那个文件早已
-- 应用过并记在 `schema_migrations` 里，于是迁移器跳过它 —— 表**永远不会被建**。
-- 而 `migrate.mjs` 随后执行 `GRANT DELETE ON rate_events, platform_mode_grants`，
-- 整个迁移以 `relation "platform_mode_grants" does not exist` 失败。
--
-- **这就是「已发布出去的迁移文件不再改」那条纪律存在的原因**：
-- 往旧文件里加新结构，在新库上正确，在旧库上静默失效，
-- 而失败信息指向的是后面的 GRANT，看不出根因。
--
-- ── 它是什么 ──────────────────────────────────────────────────────────────
--
-- 成员天然拥有 USER 网关；BUILDER 只能由**所有者身份**或**本表里的一条显式
-- 授权**产生。调用方提交的 `gateway` 只是意图，不作为资格来源（补充需求 §6.1）。
CREATE TABLE IF NOT EXISTS platform_mode_grants (
  company_id uuid NOT NULL REFERENCES companies(company_id),
  user_id    uuid NOT NULL REFERENCES users(user_id),
  gateway    text NOT NULL CHECK (gateway = 'BUILDER'),
  granted_by uuid NOT NULL REFERENCES users(user_id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, gateway),
  FOREIGN KEY (company_id, user_id) REFERENCES memberships(company_id, user_id)
);

CREATE INDEX IF NOT EXISTS platform_mode_grants_by_granter
  ON platform_mode_grants (company_id, granted_by);

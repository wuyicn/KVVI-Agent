-- S2 修复：数据范围按资源（schema_code）维度解析（PRD §2.5.1、§9.9.2）。
--
-- ── 修的是什么 ──────────────────────────────────────────────────────────
--
-- 此前 `scopeContext` 把「该账号在某公司**所有资源**上的 DATA 档位」取并集，
-- RLS 把这个并集原样套到**每一条**记录上 —— 于是「在 public_item 上授了
-- COMPANY」会泄漏到「只有 SELF 的 general_item」上，拿到别人 general_item 的读权。
--
-- 根因是授权上下文**丢失了资源维度**：档位是「资源 × 档位」的二维事实，
-- 并集把它压成了一维。
--
-- ── 怎么修 ──────────────────────────────────────────────────────────────
--
-- 应用层（`authorization.mjs`）改为按 `resource_code` 分组后，把整张表
-- 以 JSON 塞进 GUC `kvvi.scopes_by_resource`（形如
-- `{"*":["SELF"],"public_item":["COMPANY"]}`）。
-- 这里的函数对一行记录的 `schema_code` 解析出**属于这个资源**的档位 =
-- `scopes_by_resource[schema_code] ∪ scopes_by_resource['*']`。
--
-- 于是 RLS 在数据库里、按**每一行的真实 schema_code** 做资源维度的过滤 ——
-- 这同时覆盖了「应用层知道 schema」的 HTTP 路径与「按 id 读、应用层不知道
-- schema」的命令路径（后者由 RLS 自己看行里的 schema_code）。
--
-- ── fail-closed 保证 ─────────────────────────────────────────────────────
--
-- GUC 未设置 / 空对象 / 该资源与 '*' 都没有条目时，函数返回空数组，
-- 下面的 OR 全为 false → 一行都读不到。这与原 `kvvi.scopes` 的 fail-closed
-- 语义一致（见 `20-business.sql` 的注释）。

CREATE OR REPLACE FUNCTION kvvi_scopes_for(code text) RETURNS text[]
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(
              nullif(current_setting('kvvi.scopes_by_resource', true), '')::jsonb -> code)),
      ARRAY[]::text[])
      ||
      COALESCE(
      ARRAY(SELECT jsonb_array_elements_text(
              nullif(current_setting('kvvi.scopes_by_resource', true), '')::jsonb -> '*')),
      ARRAY[]::text[])
  $$;

DROP POLICY IF EXISTS tenant_and_scope ON business_records;
CREATE POLICY tenant_and_scope ON business_records
  USING (
    company_id = kvvi_guc_uuid('kvvi.company_id')
    AND (
         'COMPANY' = ANY (kvvi_scopes_for(schema_code))
      OR ('DEPARTMENT' = ANY (kvvi_scopes_for(schema_code))
          AND dept_id = kvvi_guc_uuid('kvvi.dept_id'))
      OR ('DEPARTMENT_AND_CHILDREN' = ANY (kvvi_scopes_for(schema_code))
          AND dept_id = ANY (kvvi_guc_list('kvvi.dept_subtree')::uuid[]))
      OR ('STORE' = ANY (kvvi_scopes_for(schema_code))
          AND shop_id = kvvi_guc_uuid('kvvi.shop_id'))
      OR ('SELF' = ANY (kvvi_scopes_for(schema_code))
          AND owner_id = kvvi_guc_uuid('kvvi.user_id'))
    )
  );

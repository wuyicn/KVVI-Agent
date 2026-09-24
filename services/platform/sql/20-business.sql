-- KVVI 业务系统库（PRD §4.6.1「业务系统数据库」）
--
-- ⚠️ **隔离的第二个执行点就在这里**，而且是**独立于应用代码**的那一个。
--
-- §9.9 的主保障是「会话创建时绑定公司 + 引用绑租户」，那都在应用层。
-- 本文件提供的是**纵深防御**：即使应用层判错、跑飞、或将来有人改了调用路径，
-- 只要连接上设置的租户 GUC 是对的，**跨公司行就读不出来**。
--
-- 为什么必须让 RLS 也承担一份：应用层的检查是「同一份代码既决定又检查」，
-- 它无法独立地证伪自己。RLS 由**数据库**执行，是可独立观测的第二个判断者 ——
-- 测试可以直接绕过应用层（自己 set 好 GUC 再 SELECT）来验证它。

-- ── GUC 读取helper ───────────────────────────────────────────────────
--
-- 全部用 `current_setting(name, true)`（缺失返回 NULL 而不是报错），
-- 并经 `nullif(...,'')` 去掉空串。**未设置时一律判否** —— fail-closed：
-- 忘记设置上下文的结果是「什么都读不到」，不是「什么都读到」。

CREATE OR REPLACE FUNCTION kvvi_guc(name text) RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting(name, true), '') $$;

CREATE OR REPLACE FUNCTION kvvi_guc_uuid(name text) RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting(name, true), '')::uuid $$;

CREATE OR REPLACE FUNCTION kvvi_guc_list(name text) RETURNS text[]
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(
      string_to_array(nullif(current_setting(name, true), ''), ','),
      ARRAY[]::text[])
  $$;

-- ── 业务记录 ────────────────────────────────────────────────────────
--
-- 归属字段（dept / shop / owner）与 `company_id` 同表，是因为五档数据范围的
-- 判定全都要用它们 —— 把它们拆到别的表会让每条读都多一次连接，
-- 而**多一次连接就多一个可能忘记加租户条件的地方**。
CREATE TABLE IF NOT EXISTS business_records (
  record_id   uuid PRIMARY KEY,
  company_id  uuid NOT NULL,
  schema_code text NOT NULL,
  dept_id     uuid,
  shop_id     uuid,
  owner_id    uuid NOT NULL,
  state       text NOT NULL DEFAULT 'draft',
  record_no   text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_version bigint NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 单号在同一公司内唯一：**由数据库保证**，不是由应用层的「先查再插」保证。
  UNIQUE (company_id, schema_code, record_no)
);

CREATE INDEX IF NOT EXISTS records_tenant ON business_records (company_id, schema_code);

-- ── 五档数据范围策略（§2.5.1）──────────────────────────────────────
--
-- ⚠️ **按实际可访问集合判定，不按档位编号比较**。
-- §2.5.1 明确：店铺与部门的包含关系未规定、二者可能交叉，
-- 因此 `['SELF','STORE']` 与 `['DEPARTMENT']` 之间**不存在编号大小关系**。
-- 下面写的是每个档位各自的谓词，档位之间取**并集**（`OR`）。
--
-- 三处**保守**（fail-closed）的设计：
--   1. 未设置的 GUC 为 NULL，比较结果为 NULL → 该行被过滤，不是被放行；
--   2. 档位数组为空 → 整个 OR 为 false → 一行都读不到；
--   3. `COMPANY` 档位**仍然先要求 `company_id` 相等** → 它只在本公司内是「全部」。
ALTER TABLE business_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_and_scope ON business_records;
CREATE POLICY tenant_and_scope ON business_records
  USING (
    company_id = kvvi_guc_uuid('kvvi.company_id')
    AND (
         'COMPANY' = ANY (kvvi_guc_list('kvvi.scopes'))
      OR ('DEPARTMENT' = ANY (kvvi_guc_list('kvvi.scopes'))
          AND dept_id = kvvi_guc_uuid('kvvi.dept_id'))
      OR ('DEPARTMENT_AND_CHILDREN' = ANY (kvvi_guc_list('kvvi.scopes'))
          AND dept_id = ANY (kvvi_guc_list('kvvi.dept_subtree')::uuid[]))
      OR ('STORE' = ANY (kvvi_guc_list('kvvi.scopes'))
          AND shop_id = kvvi_guc_uuid('kvvi.shop_id'))
      OR ('SELF' = ANY (kvvi_guc_list('kvvi.scopes'))
          AND owner_id = kvvi_guc_uuid('kvvi.user_id'))
    )
  );

-- 写路径单独给策略：USING 管「读得到哪些行」，WITH CHECK 管「写得进哪些行」。
-- 只给 USING 会让 `INSERT` 落在默认策略上 —— 那是个静默的缺口。
DROP POLICY IF EXISTS tenant_and_scope_write ON business_records;
CREATE POLICY tenant_and_scope_write ON business_records FOR INSERT
  WITH CHECK (company_id = kvvi_guc_uuid('kvvi.company_id'));

DROP POLICY IF EXISTS tenant_and_scope_update ON business_records;
CREATE POLICY tenant_and_scope_update ON business_records FOR UPDATE
  USING (company_id = kvvi_guc_uuid('kvvi.company_id')
         AND owner_id = kvvi_guc_uuid('kvvi.user_id'))
  WITH CHECK (company_id = kvvi_guc_uuid('kvvi.company_id'));

-- ── 单号序列（0B-9：并发下不重号）──────────────────────────────────
--
-- 放在业务库里，是为了让「取号」与「落库」能在**同一个事务**里完成。
-- 跨库事务不存在，把序列表放到平台库会让取号与插入之间出现一个
-- 必然要回收的缺口 —— 那个缺口就是重号的来源。
--
-- 取号用 `UPDATE ... RETURNING`：行锁保证同一 (公司, 模型, 周期) 的
-- 并发调用被串行化，**数据库层面**保证唯一，不靠应用层重试。
CREATE TABLE IF NOT EXISTS sequences (
  company_id  uuid NOT NULL,
  schema_code text NOT NULL,
  period_key  text NOT NULL,
  prefix      text NOT NULL,
  width       integer NOT NULL DEFAULT 6,
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, schema_code, period_key)
);

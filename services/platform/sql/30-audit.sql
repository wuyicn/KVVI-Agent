-- KVVI 审计库（PRD §4.6.1「审计存储」、§9.11.2「审计日志的完整性与访问控制」）
--
-- ⚠️ **独立数据库**，不与平台库、业务库共库（§4.6.1）。
-- 同库意味着同一把管理员钥匙既能改业务数据、又能删审计 ——
-- 那样「审计不可篡改」就只是一句纪律。
--
-- §9.11.2 的四条要求，逐条落在下面的具体构造上：
--
--   防篡改存储        → 追加写 + 哈希链（RULE 拦 UPDATE/DELETE + entry_hash 链）
--   读权限独立        → 只用本库的角色读；平台库/业务库的连接**没有**本库权限
--   完整性可验证      → verifyChain() 重算整条链，任何一处改动都会被检出
--   敏感值不入日志    → 只记 params_digest / result_digest（摘要），不记明文

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS audit_entries (
  seq           bigserial PRIMARY KEY,
  company_id    uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- 谁
  actor_kind    text NOT NULL CHECK (actor_kind IN ('USER', 'AGENT', 'SYSTEM')),
  actor_id      uuid,
  -- 从哪个网关发起的。搭建动作与使用动作必须能分开统计（§9.6.5）。
  gateway       text CHECK (gateway IN ('USER', 'BUILDER')),
  session_id    uuid,
  -- 做了什么
  action        text NOT NULL,
  resource_kind text,
  resource_id   text,
  -- 结果：**拒绝也要留痕**，且必须写明理由 —— 没有拒绝记录的审计
  -- 只能回答「谁做了什么」，不能回答「谁被拦了什么」。
  outcome       text NOT NULL CHECK (outcome IN ('ALLOW', 'DENY')),
  reason        text,
  -- 敏感值不入日志：只记摘要（§9.11.1、§9.11.2）
  params_digest text,
  result_digest text,
  -- 哈希链
  prev_hash     text NOT NULL,
  entry_hash    text NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_by_company ON audit_entries (company_id, seq);
CREATE INDEX IF NOT EXISTS audit_by_actor ON audit_entries (actor_id, seq);

-- ── 追加写：拦掉 UPDATE / DELETE ─────────────────────────────────────
--
-- ⚠️ 用 RULE 而不是只 REVOKE：`REVOKE` 挡不住表所有者与超级用户，
-- 而「有权限者即可删改」正是 §9.11.2 要防的那种实现。
-- RULE 对所有者同样生效（超级用户仍可 `ALTER TABLE ... DISABLE RULE`，
-- 但那是一次**可被 DDL 审计看见**的动作，而不是一条静默的 DELETE）。
DROP RULE IF EXISTS audit_no_update ON audit_entries;
CREATE RULE audit_no_update AS ON UPDATE TO audit_entries DO INSTEAD NOTHING;
DROP RULE IF EXISTS audit_no_delete ON audit_entries;
CREATE RULE audit_no_delete AS ON DELETE TO audit_entries DO INSTEAD NOTHING;

-- ── 哈希链 ──────────────────────────────────────────────────────────
--
-- entry_hash = sha256( 前一条的 entry_hash || 本条的规范化内容 )
--
-- 「规范化内容」用 jsonb 的**键序无关**文本表示（`jsonb::text` 会按键排序），
-- 因此重算不依赖写入时字段的书写顺序。
-- 链的起点用 64 个 0 —— 显式常量比「空值」更难被悄悄改成「任意值」。
CREATE OR REPLACE FUNCTION audit_entry_hash(
  prev text, company_id uuid, occurred_at timestamptz, actor_kind text,
  actor_id uuid, gateway text, session_id uuid, action text,
  resource_kind text, resource_id text, outcome text, reason text,
  params_digest text, result_digest text
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(
    prev || '|' || jsonb_build_object(
      'company_id', company_id, 'occurred_at', occurred_at,
      'actor_kind', actor_kind, 'actor_id', actor_id, 'gateway', gateway,
      'session_id', session_id, 'action', action,
      'resource_kind', resource_kind, 'resource_id', resource_id,
      'outcome', outcome, 'reason', reason,
      'params_digest', params_digest, 'result_digest', result_digest
    )::text,
  'sha256'), 'hex') $$;

-- 写入走这个函数，**不直接 INSERT** —— 链的接续必须由一处负责，
-- 否则「谁来填 prev_hash」会变成每个调用点各写一遍。
CREATE OR REPLACE FUNCTION audit_append(
  p_company_id uuid, p_actor_kind text, p_actor_id uuid, p_gateway text,
  p_session_id uuid, p_action text, p_resource_kind text, p_resource_id text,
  p_outcome text, p_reason text, p_params_digest text, p_result_digest text
) RETURNS text LANGUAGE plpgsql
-- ⚠️ SECURITY DEFINER 是**刻意的**，而且范围很窄：
-- 写者角色只拿到本函数的 EXECUTE，**连 INSERT/SELECT 都没有**。
-- 不这样做的话，函数内部的「取链尾」需要调用者有 SELECT，
-- 于是「写者读不到审计」这条必须让位于实现方便 —— 而它正是 §9.11.2 的要求。
-- 函数体固定且只做一件事（读链尾 + 插入一条），没有可注入的分支。
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev text;
  -- ⚠️ **必须截到毫秒**。PostgreSQL 的 timestamptz 是微秒精度，
  -- 而校验方（Node 的 Date）是毫秒精度 —— 直接用 now() 会让
  -- 「写入时算的 hash」与「校验时重算的 hash」永远差一点，
  -- 表现为**每一条都被判成篡改**（一个恒假的校验）。
  -- 截断一次，两边就对齐了。
  v_now  timestamptz := date_trunc('milliseconds', now());
  v_hash text;
BEGIN
  -- 取链尾。与 INSERT 同事务，FOR UPDATE 之外的并发由插入顺序决定，
  -- 后写者读到先写者的 hash —— 串行化由 `pg_advisory_xact_lock` 保证。
  PERFORM pg_advisory_xact_lock(hashtext('kvvi_audit_chain'));
  SELECT entry_hash INTO v_prev FROM audit_entries ORDER BY seq DESC LIMIT 1;
  v_prev := coalesce(v_prev, repeat('0', 64));

  v_hash := audit_entry_hash(v_prev, p_company_id, v_now, p_actor_kind,
    p_actor_id, p_gateway, p_session_id, p_action, p_resource_kind,
    p_resource_id, p_outcome, p_reason, p_params_digest, p_result_digest);

  INSERT INTO audit_entries (company_id, occurred_at, actor_kind, actor_id,
    gateway, session_id, action, resource_kind, resource_id, outcome, reason,
    params_digest, result_digest, prev_hash, entry_hash)
  VALUES (p_company_id, v_now, p_actor_kind, p_actor_id, p_gateway,
    p_session_id, p_action, p_resource_kind, p_resource_id, p_outcome,
    p_reason, p_params_digest, p_result_digest, v_prev, v_hash);

  RETURN v_hash;
END $$;

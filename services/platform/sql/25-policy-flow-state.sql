-- 25-policy-flow-state.sql —— 流程权限的**状态维度**。
--
-- ── 为什么要有这一列 ────────────────────────────────────────────────────
--
-- 契约的 FLOW 策略本来就带 `subresource: {type: STATE, code}`，也就是
-- 「**在哪个状态下**这个动作才允许」。而运行时的判据一直是
-- `canAct('FLOW', 流程, 动作)` —— 只有「哪张流程 + 哪个动作」，没有状态。
--
-- 编译层因此把它如实记进了「声明了但执行不了」：
--
--     KVVI_FLOW_STATE_NOT_ENFORCED
--     运行时按「流程 + 动作」判权限，没有状态这一层；
--     这条规则被编译成流程级的动作授权，即同一动作在其它状态下也可用。
--
-- 那句话是**如实**的，但它描述的是一处功能缺口，不是一条可以一直挂着的注记：
-- 「跟进中才能成交」「终态不可再操作」这类规则，搭建者写得出、而运行时看不见。
--
-- ── 语义 ────────────────────────────────────────────────────────────────
--
--   state_code IS NULL  → **不限状态**（这条策略在任何状态下都成立）
--   state_code = 'xxx'  → 只在 `xxx` 这个状态下成立
--
-- 「不限状态」必须是可表达的：搭建者写一条不带状态的 FLOW 策略是合法的，
-- 而它和「写了一条状态为 xxx 的」在判据上不同。用一个专门的 NULL 表示它，
-- 不引入第二个布尔列。
--
-- ── 唯一约束必须跟着改 ──────────────────────────────────────────────────
--
-- 原来的 UNIQUE 是 `(company_id, role_id, dimension, resource_code)`。
-- 加了状态之后，同一个角色在**同一张流程的不同状态**上各有一条策略是正常的
-- （「跟进中可成交」「已流失可复活」）—— 沿用旧约束会让第二条插不进去。
--
-- ⚠️ 新约束必须写 `NULLS NOT DISTINCT`：Postgres 默认认为两个 NULL **互不相等**，
--    于是 (role, FLOW, customer, NULL) 可以插任意多行 —— 而 NULL 那一档正是
--    「不限状态」，重复写意味着**同一件事被说两遍**，那正是唯一约束要拦的。
--    本部署固定 PostgreSQL 17（`NULLS NOT DISTINCT` 需要 15+）。

ALTER TABLE policies ADD COLUMN IF NOT EXISTS state_code text;

-- 状态码是业务码，不设枚举 —— 它由搭建者的流程契约定义，平台不预先规定
-- 「状态该叫什么」。长度上限与其它 code 列一致即可。
ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_company_id_role_id_dimension_resource_code_key;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policies_scope_unique') THEN
    ALTER TABLE policies
      ADD CONSTRAINT policies_scope_unique
      UNIQUE NULLS NOT DISTINCT (company_id, role_id, dimension, resource_code, state_code);
  END IF;
END $$;

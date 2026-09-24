-- KVVI 平台库（PRD §4.6.1「平台数据库」）
--
-- 归属：身份与授权判定所需的全部**结构**数据 —— 公司、组织、账号、角色、
-- 策略、会话与令牌状态。**不含业务数据**（业务数据在 kvvi_business），
-- **不含审计**（审计在 kvvi_audit，必须是独立数据库）。
--
-- 为什么三库分离：§4.6.1 明确「审计库独立于平台库，也独立于业务系统库」。
-- 共享一套 schema 会让「审计读权限独立于搭建权限」（§9.11.2）无处落地 ——
-- 同一个连接既能改业务数据又能删审计，那条要求就只是一句话。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 公司（租户）──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  company_id  uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 组织：部门树 / 店铺 ─────────────────────────────────────────────
--
-- ⚠️ PRD §2.5.1 明确：**店铺与部门的包含关系未规定，二者可能交叉**。
-- 所以本表只表达「部门树的父子关系」，**不表达店铺与部门的层级**；
-- 数据范围的判定必须按**实际可访问集合**，不得按档位编号比较。
CREATE TABLE IF NOT EXISTS departments (
  dept_id        uuid PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES companies(company_id),
  parent_dept_id uuid REFERENCES departments(dept_id),
  name           text NOT NULL,
  UNIQUE (company_id, dept_id)
);

CREATE TABLE IF NOT EXISTS shops (
  shop_id    uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(company_id),
  name       text NOT NULL,
  UNIQUE (company_id, shop_id)
);

-- ── 账号 ─────────────────────────────────────────────────────────────
--
-- `authz_version` 是 §9.4.2 要求的**授权版本**：角色或策略一变就 +1，
-- 已签发的委派令牌随之全部失效。它把「权限回收」从「记得去清缓存」
-- 变成「令牌自己就作废了」。
CREATE TABLE IF NOT EXISTS users (
  user_id       uuid PRIMARY KEY,
  login         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  status        text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  authz_version integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 成员关系：一个账号可以在多家公司 ────────────────────────────────
--
-- 会话创建时必须选定一家（§9.9.3）；**不存在「切换公司」这个操作**。
CREATE TABLE IF NOT EXISTS memberships (
  company_id uuid NOT NULL REFERENCES companies(company_id),
  user_id    uuid NOT NULL REFERENCES users(user_id),
  dept_id    uuid REFERENCES departments(dept_id),
  shop_id    uuid REFERENCES shops(shop_id),
  PRIMARY KEY (company_id, user_id),
  -- 所属部门/店铺必须属于同一家公司：跨公司的组织归属是无效数据，
  -- 而不是「需要额外检查的情况」。
  FOREIGN KEY (company_id, dept_id) REFERENCES departments(company_id, dept_id),
  FOREIGN KEY (company_id, shop_id) REFERENCES shops(company_id, shop_id)
);

-- ── 角色与策略 ──────────────────────────────────────────────────────
--
-- 一次策略覆盖四个维度（0B-4 表单 / 0B-5 字段 / 0B-6 数据范围 / 0B-7 流程）。
-- 把它们放在一张表里，是因为它们是**同一次授权动作的四个面**，
-- 拆成四张表会让「同一角色在不同维度上不一致」变得可能。
CREATE TABLE IF NOT EXISTS roles (
  role_id    uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(company_id),
  role_code  text NOT NULL,
  name       text NOT NULL,
  UNIQUE (company_id, role_code)
);

CREATE TABLE IF NOT EXISTS role_members (
  company_id uuid NOT NULL REFERENCES companies(company_id),
  role_id    uuid NOT NULL REFERENCES roles(role_id),
  user_id    uuid NOT NULL REFERENCES users(user_id),
  PRIMARY KEY (role_id, user_id),
  FOREIGN KEY (company_id, user_id) REFERENCES memberships(company_id, user_id)
);

CREATE TABLE IF NOT EXISTS policies (
  policy_id        uuid PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(company_id),
  role_id          uuid NOT NULL REFERENCES roles(role_id),
  dimension        text NOT NULL CHECK (dimension IN ('FORM', 'FIELD', 'FLOW', 'DATA')),
  resource_code    text NOT NULL,          -- 表单 / 字段 / 流程 / 读视图的 code；'*' 表示该维度全部
  actions          text[] NOT NULL DEFAULT '{}',
  -- 五档（§2.5.1）。**是数组**：档位取并集，不比较编号。
  data_scopes      text[] NOT NULL DEFAULT '{}'
                   CHECK (data_scopes <@ ARRAY['SELF','STORE','DEPARTMENT',
                                                'DEPARTMENT_AND_CHILDREN','COMPANY']::text[]),
  -- 字段维度专用：可见 / 脱敏 / 隐藏 / 只读
  field_visibility text CHECK (field_visibility IN
                               ('VISIBLE', 'MASKED', 'HIDDEN', 'READONLY')),
  UNIQUE (company_id, role_id, dimension, resource_code)
);

CREATE INDEX IF NOT EXISTS policies_by_role ON policies (company_id, role_id, dimension);

-- ── 会话（§9.9.3 会话内绑定公司；§4.6.5 五类生命周期事件）───────────
--
-- ⚠️「活动租户上下文」按**会话**隔离，不是账号级（§9.9.5）。
-- 同一账号可同时开多个会话、分别处于不同公司。
CREATE TABLE IF NOT EXISTS sessions (
  session_id     uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(user_id),
  -- 会话创建时选定并绑定；**会话内不可更改**。要换公司就新建会话。
  company_id     uuid NOT NULL REFERENCES companies(company_id),
  gateway        text NOT NULL CHECK (gateway IN ('USER', 'BUILDER')),
  state          text NOT NULL CHECK (state IN ('ACTIVE', 'ENDED')),
  -- 五类生命周期事件的终态：ENDED_BY 记录是哪一类把它结束了。
  ended_by       text CHECK (ended_by IN ('LOGOUT', 'TIMEOUT', 'ACCOUNT_SUSPENDED',
                                          'ADMIN_REVOKED')),
  authz_version  integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  FOREIGN KEY (company_id, user_id) REFERENCES memberships(company_id, user_id)
);

CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions (user_id, state);
CREATE INDEX IF NOT EXISTS sessions_by_company ON sessions (company_id, state);

-- ── 会话生命周期事件（§4.6.5 五类，入口一律在平台服务进程）──────────
CREATE TABLE IF NOT EXISTS session_events (
  event_id   bigserial PRIMARY KEY,
  session_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  company_id uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('LOGIN', 'LOGOUT', 'TIMEOUT',
                                           'ACCOUNT_SUSPENDED', 'ADMIN_REVOKED')),
  at         timestamptz NOT NULL DEFAULT now(),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS session_events_by_session ON session_events (session_id, at);

-- ── 委派令牌（§9.4）────────────────────────────────────────────────
--
-- 令牌**绑定会话所属公司**（§9.9.4）。因为会话内的公司不可变更，
-- 不再需要独立的「切换时废止」机制 —— 公司绑定与令牌绑定是同一件事的两面。
--
-- ⚠️ 存的是**摘要**，不是令牌本身：令牌一旦签发，服务端只应能验证它，
-- 不应能重建它。重建能力会让「前端泄漏 = 服务端泄漏」。
CREATE TABLE IF NOT EXISTS delegation_tokens (
  token_id      uuid PRIMARY KEY,
  token_digest  text NOT NULL UNIQUE,
  session_id    uuid NOT NULL REFERENCES sessions(session_id),
  user_id       uuid NOT NULL REFERENCES users(user_id),
  company_id    uuid NOT NULL REFERENCES companies(company_id),
  authz_version integer NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);

CREATE INDEX IF NOT EXISTS tokens_by_session ON delegation_tokens (session_id);

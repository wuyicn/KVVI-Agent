-- 实例级首次初始化状态（阶段十一 · 应用 C：macOS 试点发行版）
--
-- ── 为什么它是一张迁移表，而不是「第一次用到时现建」 ────────────────────
--
-- 第一版把建表写进了 bootstrap 的请求路径里（`CREATE TABLE IF NOT EXISTS`
-- 在事务内执行）。两个并发调用会同时建这张表，PostgreSQL 在并发 DDL 上
-- 会报唯一冲突或死锁 —— 结果是**两个调用都失败**，而「一次性初始化」
-- 恰恰是最可能被并发调用的端点（安装脚本重试、浏览器双击）。
--
-- 现查的结果是「谁能先建出表谁赢」，那不是我们要的判据。
-- **模式属于迁移，不属于请求路径。** 表在这里建一次，请求路径里只剩一条 INSERT。
--
-- ── 为什么只有一行 ──────────────────────────────────────────────────────
--
-- `marker` 是主键且固定为 `bootstrap.completed`。一个实例只初始化一次，
-- 而「只一次」这件事的判据就是这一行的唯一约束 ——
-- **不是**「代码里先查了一下」。
CREATE TABLE IF NOT EXISTS instance_bootstrap (
  marker       text PRIMARY KEY,
  company_id   uuid REFERENCES companies(company_id),
  user_id      uuid REFERENCES users(user_id),
  completed_at timestamptz NOT NULL DEFAULT now()
);

-- 只有平台服务进程需要它（安装期状态），业务与审计进程都不该看到。
-- 授权沿用 `10-platform.sql` 的 `GRANT ... TO kvvi_platform` 覆盖面，
-- 这里不额外放权。

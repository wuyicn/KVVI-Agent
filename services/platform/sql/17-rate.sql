-- 速率限制记账（N16 残，PRD §9.11.3）
--
-- ⚠️ 计数放**平台库**，不放进程内存：内存计数在多进程与重启后失效，
-- 而失效的方向是**放行** —— 限流失效就是没有限流。
--
-- 用 (company_id, dimension, key, at) 的窄表 + 时间窗查询，
-- 不引入额外的中间件：少一个组件就少一处「忘了同步」的地方。
CREATE TABLE IF NOT EXISTS rate_events (
  event_id   bigserial PRIMARY KEY,
  company_id uuid NOT NULL,
  dimension  text NOT NULL CHECK (dimension IN ('ACCOUNT', 'TOOL', 'SESSION')),
  key        text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_events_window
  ON rate_events (company_id, dimension, key, at DESC);

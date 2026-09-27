-- 幂等键：让「同一个动作重发一次」不产生第二次效果。
--
-- ── 它补的是什么 ────────────────────────────────────────────────────────
--
-- 会话连续性验收的第 ⑤ 条量出过一个事实：**写操作没有幂等键**。
-- 同一条建记录的请求打三次，建出三条不同的记录。「重连不重放」当时靠的是
-- **客户端不自动重试**，而不是服务端认得出重复。
--
-- 这两件事不是一回事：
--
--   · 客户端不重试 —— 是一个**约定**，任何一个新调用方都可能不遵守；
--   · 服务端认得出重复 —— 是一个**判据**，调用方守不守规矩都成立。
--
-- 而重连恰恰是最容易重复发一次的时刻：请求发出去了、响应没回来、
-- 连接断了、客户端重连后**不知道那一次到底成没成**。
-- 此时唯一安全的重试方式，是带一个服务端认得的键。
--
-- ── 为什么不用「请求体摘要」当键 ────────────────────────────────────────
--
-- 摘要在**合法的重复**上会误判：同一个销售录入两条同名客户是常态
-- （撞单，见契约里那条「先不做查重」）。摘要相同不等于同一次动作。
-- 所以键必须由**调用方**给，因为只有调用方知道「这是不是同一次」。
--
-- ── 保留窗口 ────────────────────────────────────────────────────────────
--
-- 键与响应一起存，窗口内重发直接回**当初那个响应**（含 201 与 recordId）——
-- 不是「拒绝重复」，因为拒绝会让重连的客户端以为失败，
-- 而它其实成功了，只是没收到。

CREATE TABLE IF NOT EXISTS idempotency_keys (
  company_id  uuid NOT NULL REFERENCES companies(company_id),
  user_id     uuid NOT NULL REFERENCES users(user_id),
  -- 调用方给的键。**按 (公司, 账号, 端点) 隔离**：换了账号或换了端点，
  -- 同一个字符串是另一件事，不能互相顶掉。
  idem_key    text NOT NULL,
  endpoint    text NOT NULL,
  -- 当初那个响应，原样存回来。重发时直接回它，不再执行一遍。
  response    jsonb NOT NULL,
  status_code integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, endpoint, idem_key)
);

-- 清扫用。窗口由代码给（`KVVI_IDEMPOTENCY_WINDOW_MS`），这里只建索引。
CREATE INDEX IF NOT EXISTS idempotency_keys_by_age ON idempotency_keys (created_at);

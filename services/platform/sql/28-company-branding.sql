-- 28-company-branding.sql —— 公司自己的牌子：对外显示名、LOGO、标语。
--
-- ── 为什么另立三列，而不是复用 `companies.name` ──────────────────────────
--
-- `companies.name` 是**入账名**：运维脚本、账单、日志里说的那家「A 公司」。
-- 而员工界面上显示的那块牌子是**对外身份**：它可能写全称（「杭州某某科技
-- 有限公司」），也可能写商号（「某某门店」），还会随品牌更换而改。
--
-- 挤进同一列，两件事会互相打架：
--   · 改一次牌子名，运维与账单读到的那家公司的名字也跟着变了；
--   · 想保留入账名，对外名就没有地方放。
-- 所以是**两列**，不是同一列的两个用法。
--
-- ── 为什么三列都可空，且「未设置」必须是 NULL，不能是空串 ────────────────
--
-- 读的一侧（运行在员工机器上的客户端）要判的是一件具体的事：
-- **所有者配过没有**。配过就用它，没配过就回落到产品自带的默认牌子。
--
-- 用空串表示「没配」的话，客户端只能猜 `''` 到底是「没配」还是
-- 「配过、后来清空了」—— 而这两个答案是**不同的行为**：前者回落到产品名，
-- 后者应该是「主标题就是空的」。猜错的方向很糟：把我们的产品名当成
-- 客户公司的名字显示出来。
-- 所以写入侧统一归一化（空串 → NULL），见 `branding-api.mjs`。
--
-- ── 长度上限为什么不写在这张迁移里 ──────────────────────────────────────
--
-- 上限（60 / 80 / 2048）是**产品决定**，不是数据完整性约束：
-- 它要回答的是「一行标题放得下多少字」，改动时不该需要一次数据库迁移。
-- 所以执行点在运行时（`branding-api.mjs` 的 `BRANDING_LIMITS`），
-- 这里只用 COMMENT 记下当初定的数 —— 改的时候要同时改两处，
-- 而库里查得到「当初定的是多少」才不会让那两处悄悄分叉。

ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_name text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_logo_url text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_tagline text;

COMMENT ON COLUMN companies.brand_name IS
  '公司对外显示名（员工界面上的牌子）；未设置 = NULL，运行时上限 60 字符';

COMMENT ON COLUMN companies.brand_logo_url IS
  '公司 LOGO 的 URL，只接受 http/https；未设置 = NULL，运行时上限 2048 字符';

COMMENT ON COLUMN companies.brand_tagline IS
  '一句话标语，显示在新会话页居中标题处；未设置 = NULL，运行时上限 80 字符';

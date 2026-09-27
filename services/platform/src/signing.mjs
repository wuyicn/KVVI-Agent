/**
 * 签名层：非对称签名令牌与密钥轮换（PRD §9.4.1、§9.4.2、§9.4.3）。
 *
 * ── 为什么必须非对称 ────────────────────────────────────────────────────
 *
 * §9.4.1 明确：**不得使用共享密钥** —— 共享密钥会在**每个业务系统侧**扩大泄漏面。
 * 非对称之后，业务系统只持有公钥：**它能验，但不能签**。
 * 这不是性能取舍，而是把「谁能签发」这件事从「拿到配置的人」缩小到「签名进程」。
 *
 * ── 私钥只存在于本进程 ──────────────────────────────────────────────────
 *
 * §4.6.5 把签名模块放在**不加载插件**的平台服务进程里（阶段一已取证）。
 * 本模块**不导出私钥**、不写日志、不返回给调用方 —— 唯一的出口是 `signToken()`。
 * 镜像里也不含私钥（`KVVI_SIGNING_KEY_PATH` 由运行期挂载）。
 *
 * ── 令牌声明是**接口契约**的一部分（§9.4.1）────────────────────────────
 *
 * 声明字段集固定。**调用方无权提供任何声明** —— 全部由服务端从会话状态导出。
 * §9.4.1 的负向测试里有一条正是「签名请求含主体指定字段时被拒并告警」。
 *
 * ── 三处必须相等的那个值 ────────────────────────────────────────────────
 *
 * §9.4.2 短时令牌有效期、§9.4.4 残留窗口、§3.5.1 访客链接缓存 TTL
 * **是同一个全局配置项**，不是三个各自设置的数字。
 * 本模块把它命名为 `TOKEN_TTL_MS` 并从这里导出，其它两处引用它。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * **同一个全局配置项**：令牌有效期、离线残留窗口、访客链接缓存 TTL。
 *
 * 产品级上限 5 分钟（§9.4.2、§9.4.4）。三处引用这**一个**值；
 * 任一处单独改动都会让「最大残留窗口」的说明失真。
 */
export const TOKEN_TTL_MS = Number(process.env.KVVI_TOKEN_TTL_MS ?? 5 * 60 * 1000)
if (TOKEN_TTL_MS > 5 * 60 * 1000) {
  throw new Error('KVVI_TOKEN_TTL_TOO_LONG：§9.4.2 规定令牌有效期上限 5 分钟')
}

/**
 * **浏览器会话凭据**的有效期。
 *
 * ── 为什么它和 `TOKEN_TTL_MS` 是两个值 ─────────────────────────────────────
 *
 * §9.4.2 那条 5 分钟上限管的是**业务令牌**：交给业务系统、`/sign/delegation`
 * 签出去、能被第三方**离线验签**的那一种。它的短是有目的的 —— 残留窗口有界。
 *
 * 而浏览器手里的那张 Cookie 根本不是业务令牌：它换不出任何业务能力
 * （`typ` 对不上，`/sign/*` 一律拒），它只回答一个问题——
 * 「这个浏览器背后是哪一次**会话**」。会话的有效期由 `sessions` 行、账号状态
 * 与授权版本决定，本来就与令牌寿命是两件事。
 *
 * 第一版把两者**合成了一个值**：Cookie 里放的就是 5 分钟的业务令牌。
 * 于是每一次登录都在 5 分钟后失效，而浏览器一点都不知道 ——
 * 界面显示「重新连接中」、面板显示原始错误码 `KVVI_INVALID_TOKEN`、
 * 目录选择器收到登录页 HTML 报 `Unexpected token '<'`。
 *
 * @see BROWSER_CREDENTIAL_GRACE_MS 会话仍有效时，过期的会话凭据还能换一张新的。
 */
export const BROWSER_TTL_MS = Number(process.env.KVVI_BROWSER_TTL_MS ?? 30 * 60 * 1000)

/**
 * 会话凭据过期后**还能拿来续发**的宽限期。
 *
 * ⚠️ 判据不是「凭据没过期」，而是「**会话还有效**」：睡了两个小时回来，
 * 凭据早过期了，但会话仍在那 8 小时的空闲窗口里 —— 换一张新的、无感恢复。
 * 管理员撤权、账号停用、授权版本变了，会话就是 `ENDED`／版本对不上，
 * 续发当场被拒。**「续发」不是「延期」，它是重新问一遍会话还在不在。**
 *
 * 这条放宽**只对 `typ === 'browser'` 且只在续发端点上生效**；
 * 其它任何路径拿到过期凭据一律拒。
 */
export const BROWSER_CREDENTIAL_GRACE_MS = Number(
  process.env.KVVI_BROWSER_GRACE_MS ?? 8 * 60 * 60 * 1000)

/**
 * 凭据种类。**两种凭据互换使用必须失败**，这是「分离」这件事的可检判据。
 *
 * | 值 | 谁持有 | 能不能换出业务能力 |
 * |---|---|---|
 * | `delegated` | 业务系统、脚本（`Authorization: Bearer`） | 能 |
 * | `browser` | 浏览器（HttpOnly Cookie） | **不能** |
 */
export const TOKEN_TYPES = Object.freeze({ DELEGATED: 'delegated', BROWSER: 'browser' })

/** 签发者标识。业务系统据此拒绝「其他身份层签发的令牌」（§9.4.1 负向测试）。 */
export const ISSUER = 'kvvi-platform'

export const TOKEN_ALG = 'EdDSA'

/** 令牌声明字段集。**固定**，不是「可以随手加字段」。 */
export const CLAIM_FIELDS = Object.freeze(
  ['iss', 'kid', 'sub', 'sid', 'ten', 'gw', 'av', 'cv', 'typ', 'iat', 'exp', 'jti'])

/**
 * 调用方**不得**提供的字段。出现在签名请求体里即拒绝并告警（§9.4.1）。
 * 与 §9.3.1「租户标识不出现在模型参数中」同源。
 */
export const FORBIDDEN_REQUEST_FIELDS = Object.freeze(
  ['sub', 'sub', 'sid', 'ten', 'tenant', 'tenantId', 'companyId', 'company_id',
   'actor', 'actorId', 'role', 'roles', 'av', 'authzVersion', 'iss', 'jti', 'exp'])

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const unb64url = (s) => Buffer.from(s, 'base64url')

/**
 * 载入签名密钥。
 *
 * ⚠️ 私钥**不进镜像、不进仓库、不进日志**（§9.4.1）。
 * 开发环境允许在**显式**声明 `KVVI_DEV_KEYS=1` 时落盘生成一把开发密钥；
 * 生产环境缺私钥时**必须起不来**，而不是「悄悄用一把新的」——
 * 后者会让所有已签发令牌失效，且不留痕迹。
 * @returns {{kid: string, privateKey: object, publicKey: object, previous: Array}}
 */
export function loadKeys() {
  const path = process.env.KVVI_SIGNING_KEY_PATH ?? '/run/kvvi-secrets/signing.key'
  if (existsSync(path)) return readKeyFile(path)
  if (process.env.KVVI_DEV_KEYS !== '1') {
    throw new Error('KVVI_SIGNING_KEY_MISSING：生产环境必须提供签名私钥（不得现场生成）')
  }
  const keys = makeKey()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 })
  return keys
}

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    kid: randomUUID(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    previous: [],
  }
}

function readKeyFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw.kid || !raw.privateKey || !raw.publicKey) {
    throw new Error('KVVI_SIGNING_KEY_MALFORMED：签名密钥文件缺字段')
  }
  return raw
}

/**
 * 轮换：新密钥成为当前，旧密钥进入 `previous`（**双密钥并行期**，§9.4.1）。
 *
 * 并行期的意义：轮换不能导致全体令牌立刻失效。
 * 旧密钥在确认无在途令牌之后才可吊销 —— 那一步是运维动作，不在本函数里。
 * @param {object} keys 当前密钥
 * @returns {object} 新密钥集
 */
export function rotate(keys) {
  const fresh = makeKey()
  fresh.previous = [
    { kid: keys.kid, publicKey: keys.publicKey },
    ...(keys.previous ?? []),
  ].slice(0, 2) // 并行期最多保留两把旧公钥，避免公钥集合无限增长
  return fresh
}

/**
 * 签发令牌。**声明全部来自入参，不接受调用方提供的声明**。
 *
 * 调用方只能给「这次签名请求对应的会话」——`sub`/`ten`/`av` 等由服务端
 * 从会话状态导出后再传进来。本函数不读请求体。
 * @param {object} claims 服务端导出的声明（不含 iss/kid/typ/iat/exp/jti）
 * @param {object} keys 密钥集
 * @param {{typ?: string, ttlMs?: number}} [options] 凭据种类与有效期
 * @returns {string} 令牌
 */
export function signToken(claims, keys, options = {}) {
  const extra = Object.keys(claims).filter((k) => !CLAIM_FIELDS.includes(k))
  if (extra.length > 0) {
    throw new Error(`KVVI_UNKNOWN_CLAIM：${extra.join(',')}`)
  }
  const typ = options.typ ?? TOKEN_TYPES.DELEGATED
  if (typ !== TOKEN_TYPES.DELEGATED && typ !== TOKEN_TYPES.BROWSER) {
    throw new Error(`KVVI_UNKNOWN_TOKEN_TYPE：${typ}`)
  }
  const ttlMs = options.ttlMs ?? (typ === TOKEN_TYPES.BROWSER ? BROWSER_TTL_MS : TOKEN_TTL_MS)
  // ⚠️ **§9.4.2 的 5 分钟上限只钉业务令牌。** 会话凭据走另一条线，
  //    但两条线各自都要有上限 —— 一个「谁都能签任意长」的签发器等于没有上限。
  const ceiling = typ === TOKEN_TYPES.BROWSER ? BROWSER_TTL_MS : TOKEN_TTL_MS
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > ceiling) {
    throw new Error(`KVVI_TOKEN_TTL_INVALID：${typ} 的有效期必须落在 (0, ${ceiling}] 毫秒内`)
  }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: ISSUER, kid: keys.kid,
    sub: claims.sub, sid: claims.sid, ten: claims.ten, gw: claims.gw,
    av: claims.av, cv: claims.cv, typ,
    iat: now, exp: now + Math.floor(ttlMs / 1000),
    jti: randomUUID(),
  }
  const header = b64url(JSON.stringify({ alg: TOKEN_ALG, kid: keys.kid }))
  const body = b64url(JSON.stringify(payload))
  const signature = sign(null, Buffer.from(`${header}.${body}`), createPrivateKey(keys.privateKey))
  return `${header}.${body}.${b64url(signature)}`
}

/**
 * 这个声明属于哪一种凭据。
 *
 * ⚠️ **没有 `typ` 的一律当 `delegated`**：改造之前签出去的令牌没有这个字段，
 * 而它们是业务令牌。反过来**不成立** —— 一个 `typ: 'browser'` 的凭据
 * 永远不会被当成业务令牌（`verifyToken` 显式拒它），这正是「分离」的那条判据。
 * @param {object} claims 声明
 * @returns {'delegated'|'browser'|'unknown'}
 */
export function tokenTypeOf(claims) {
  if (claims?.typ === undefined) return TOKEN_TYPES.DELEGATED
  return claims.typ
}

/**
 * 到期检查。本地完成，**不依赖平台**（§9.4.4）。
 *
 * `graceMs` 只给**续发**用：它把「过期」放宽成「过期但还在宽限期内」，
 * 调用方必须自己去问会话还在不在 —— 本地这一层只回答时间问题。
 * @param {object} claims 声明
 * @param {number} nowMs 当前时间
 * @param {number} [graceMs] 宽限期；缺省 0，即严格按 `exp` 判
 * @returns {{ok: boolean, error?: string, expired?: boolean}}
 */
export function verifyExpiry(claims, nowMs = Date.now(), graceMs = 0) {
  const now = Math.floor(nowMs / 1000)
  if (typeof claims.exp !== 'number') return { ok: false, error: 'KVVI_TOKEN_MALFORMED' }
  if (claims.exp > now) return { ok: true, expired: false }
  if (graceMs > 0 && now - claims.exp <= Math.floor(graceMs / 1000)) {
    return { ok: true, expired: true }
  }
  return { ok: false, error: 'KVVI_TOKEN_EXPIRED', expired: true }
}

/**
 * 验签。**只做签名与格式校验**，不查撤销状态、不比版本 ——
 * 那两件事需要平台在线（§9.4.4），而验签在本地就能完成。
 *
 * 这是 §4.6.2 规则 3「平台不可用不应使业务系统停摆」在代码里的落点：
 * 验签与到期检查**不依赖平台**，所以它们绝不能和查询混在一起。
 * @param {string} token 令牌
 * @param {object[]} publicKeys 公钥集合（当前 + 并行期的旧公钥）
 * @returns {{ok: boolean, claims?: object, error?: string}}
 */
export function verifySignature(token, publicKeys) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) return { ok: false, error: 'KVVI_TOKEN_MALFORMED' }
  const [header, body, sig] = parts
  let head
  let claims
  try {
    head = JSON.parse(unb64url(header).toString('utf8'))
    claims = JSON.parse(unb64url(body).toString('utf8'))
  } catch {
    return { ok: false, error: 'KVVI_TOKEN_MALFORMED' }
  }
  if (head.alg !== TOKEN_ALG) return { ok: false, error: 'KVVI_TOKEN_ALG_UNSUPPORTED' }
  const key = publicKeys.find((k) => k.kid === head.kid)
  // 用**已吊销的密钥**签的令牌：公钥不在集合里 → 与「伪造」同一路径被拒。
  if (!key) return { ok: false, error: 'KVVI_TOKEN_UNKNOWN_KEY' }
  const good = verify(null, Buffer.from(`${header}.${body}`),
    createPublicKey(key.publicKey), unb64url(sig))
  if (!good) return { ok: false, error: 'KVVI_TOKEN_BAD_SIGNATURE' }
  if (claims.iss !== ISSUER) return { ok: false, error: 'KVVI_TOKEN_WRONG_ISSUER' }
  return { ok: true, claims }
}

/** 业务系统侧持有的公钥集合（当前 + 并行期旧公钥）。 */
export function publicKeysOf(keys) {
  return [{ kid: keys.kid, publicKey: keys.publicKey }, ...(keys.previous ?? [])]
}

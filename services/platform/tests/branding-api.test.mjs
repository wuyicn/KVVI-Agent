/**
 * 公司品牌（`/api/v1/company/branding`）的判据与**每一处的反向验证**。
 *
 * ── 这一组测的是「谁读得到、谁写得进、写完留下什么」，不是界面 ──────────────
 *
 * | # | 判据 | 不成立会怎样 | 反向验证在哪 |
 * |---|---|---|---|
 * | 1 | owner 能写能读 | 牌子根本配不了 | 「owner 写完读到的是刚写的值」 |
 * | 2 | **成员能读** | 员工机器上拿不到牌子 → 静默回落到产品名 | ★ 对照组：同一个员工在 `/admin` 是 403 |
 * | 3 | 成员不能写 403 | 任何员工都能改公司对外的身份 | ★ 反证：`admin` 也不行 |
 * | 4 | 空串清空 / 未给不动 | 清不掉标语，或改一个字段抹掉另外两个 | ★ 反证：朴素合并写法清不掉 |
 * | 5 | `javascript:` / `data:` / 超长 → 400 | 注入点，或被长度上限之外的东西绕过 | ★ 反证：长度闸门管不住它们 |
 * | 6 | 跨公司隔离 | 传一个别家的 companyId 就改了别家的牌子 | ★ 反证：companyId 在体内也不生效 |
 *
 * ⚠️ 这组用例**刻意不调 `grantBaseline`**。品牌读写不经过业务策略层
 * （FORM / FIELD / DATA 三个维度都不涉及），所以那条基线授权在这里没用；
 * 而一旦给了它，「403 是因为没授权」就成了一个说得通的解释，
 * 可这里要证的恰恰是「拒的原因只可能是角色」。
 *
 * ⚠️ 与 `admin-api.test.mjs` 同一约定：直接调**路由器**（不经 HTTP 服务器），
 * 因为本组测的是判定与落库，不是传输；`loadSession` 复用认证模块自己的
 * 会话端点，与 `server.mjs` 的接线一致 —— 自己写桩的话，测到的是桩的行为。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, resetDatabase, grantPlatformRole, makeSession } from './harness.mjs'
import { handleApi } from '../src/api-router.mjs'
import { handleAuth } from '../src/auth.mjs'
import { digestOf } from '../src/audit.mjs'
import { BRANDING_LIMITS, checkBrandingPatch } from '../src/branding-api.mjs'

let owner = null       // A 公司的所有者
let employee = null    // A 公司的普通成员
let delegate = null    // A 公司的 admin（被委托者）
let bOwner = null      // B 公司的所有者（另一个租户）

const PATH = '/api/v1/company/branding'

async function api(method, path, session, body) {
  return await handleApi({
    method, path, query: '', body: body === undefined ? null : JSON.stringify(body),
    headers: session === null ? {} : { authorization: 'Bearer ' + session.raw },
    loadSession: (token) => handleAuth({
      method: 'GET', path: '/auth/session', body: null,
      headers: { authorization: 'Bearer ' + token },
      omitOtherGateway: true,
    }),
  })
}

/** 以会话去读本公司品牌。 */
async function read(session) {
  return await api('GET', PATH, session)
}

/** 直接把某一家的品牌置成已知状态 —— 用例之间要能互相看见对方的痕迹。 */
async function seedBranding(companyId, name, logoUrl, tagline) {
  await pool('platform').query(
    `UPDATE companies SET brand_name = $2, brand_logo_url = $3, brand_tagline = $4
      WHERE company_id = $1`, [companyId, name, logoUrl, tagline])
}

/** 库里那一行到底是什么（不经接口，用于证「写进去的东西本身是对的」）。 */
async function rowOf(companyId) {
  const { rows } = await pool('platform').query(
    `SELECT brand_name, brand_logo_url, brand_tagline FROM companies WHERE company_id = $1`,
    [companyId])
  return rows[0]
}

/** 审计里当前最大的序号 —— 读「这次写留了几条痕」时用它切一刀。 */
async function auditHead() {
  const { rows } = await pool('auditRead').query(
    'SELECT COALESCE(max(seq), 0)::int AS head FROM audit_entries')
  return rows[0].head
}

/** 序号之后的审计记录，按时间顺序。 */
async function auditSince(seq, action = 'company.updateBranding') {
  const { rows } = await pool('auditRead').query(
    `SELECT seq, outcome, reason, params_digest, resource_id
       FROM audit_entries WHERE seq > $1 AND action = $2 ORDER BY seq`, [seq, action])
  return rows
}

before(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
  await grantPlatformRole(A.carol, 'admin')
  await grantPlatformRole(B.dave, 'owner', B.company)
  owner = await makeSession(A.alice, A.company)
  employee = await makeSession(A.bob, A.company)
  delegate = await makeSession(A.carol, A.company)
  bOwner = await makeSession(B.dave, B.company)
})

after(closeAll)

// ── 纯函数：校验与归一化 ─────────────────────────────────────────────────

describe('品牌的校验与归一化（纯函数）', () => {
  test('没给的字段不进 patch —— 也就是「不动」', () => {
    const { patch, problems } = checkBrandingPatch({ name: 'ACME' })
    assert.deepEqual(problems, [])
    assert.deepEqual(patch, { name: 'ACME' })
    // 没有 logoUrl 这个键，而不是 `logoUrl: undefined`：
    // 写入点靠 `hasOwnProperty` 判「这次要不要写这一列」。
    assert.equal(Object.hasOwn(patch, 'logoUrl'), false)
    assert.equal(Object.hasOwn(patch, 'tagline'), false)
  })

  test('空串与空白串都归一化成 null（清空），不是空串', () => {
    for (const blank of ['', '   ', '\t\n', null, undefined]) {
      const { patch, problems } = checkBrandingPatch({ tagline: blank })
      assert.deepEqual(problems, [])
      assert.equal(patch.tagline, null, `${JSON.stringify(blank)} 没有归一化成 null`)
    }
  })

  test('去首尾空白，不乱改中间', () => {
    const { patch } = checkBrandingPatch({ name: '  某某 科技  ' })
    assert.equal(patch.name, '某某 科技')
  })

  test('三个字段各自的上限：刚好等于上限放行，多一个字符拒绝', () => {
    const cases = [
      ['name', BRANDING_LIMITS.name, 'KVVI_BRANDING_NAME_TOO_LONG'],
      ['tagline', BRANDING_LIMITS.tagline, 'KVVI_BRANDING_TAGLINE_TOO_LONG'],
      ['logoUrl', BRANDING_LIMITS.logoUrl, 'KVVI_BRANDING_LOGO_URL_TOO_LONG'],
    ]
    for (const [field, limit, reason] of cases) {
      // logoUrl 要被 scheme 规则放行，所以给它一个真 URL 的头部再补长。
      const atLimit = field === 'logoUrl'
        ? 'https://x/' + 'a'.repeat(limit - 'https://x/'.length)
        : 'a'.repeat(limit)
      assert.equal([...atLimit].length, limit)
      assert.deepEqual(checkBrandingPatch({ [field]: atLimit }).problems, [],
        `${field} 在刚好等于上限时被拒了`)

      const over = field === 'logoUrl'
        ? 'https://x/' + 'a'.repeat(limit - 'https://x/'.length + 1)
        : 'a'.repeat(limit + 1)
      assert.deepEqual(checkBrandingPatch({ [field]: over }).problems,
        [{ field, reason }], `${field} 超长没有被拒`)
    }
  })

  test('★ 中文按码点计数：60 个汉字不算超长', () => {
    // 用 `String.length` 计数的话，汉字也是 1，这条看不出来 ——
    // 所以这条路走的是 emoji（UTF-16 里占两个单元）。
    const name = '👍'.repeat(60)
    assert.equal(name.length, 120, '前提变了：emoji 在 UTF-16 里应当占两个单元')
    assert.deepEqual(checkBrandingPatch({ name }).problems, [],
      '按 UTF-16 单元计数会把 60 个 emoji 判成 120 字符')
    assert.equal(checkBrandingPatch({ name: '👍'.repeat(61) }).problems[0].reason,
      'KVVI_BRANDING_NAME_TOO_LONG')
  })

  test('★ logoUrl 只收 http/https —— `javascript:` 与 `data:` 都拒', () => {
    for (const bad of [
      'javascript:alert(document.cookie)',
      'JAVASCRIPT:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'DATA:text/html,<script>alert(1)</script>',
      '//evil.example.com/logo.png',
      'ftp://example.com/logo.png',
      'https:/example.com/logo.png',
    ]) {
      assert.deepEqual(checkBrandingPatch({ logoUrl: bad }).problems,
        [{ field: 'logoUrl', reason: 'KVVI_BRANDING_LOGO_URL_NOT_HTTP' }],
        `${bad} 没有被拒`)
    }
    for (const good of ['http://example.com/logo.png', 'https://cdn.example.com/a.png?x=1']) {
      assert.deepEqual(checkBrandingPatch({ logoUrl: good }).problems, [], `${good} 被误拒`)
    }
  })

  test('★ 反证：长度闸门**管不住** javascript: 与 data:', () => {
    // 这条不是重复上面那一条：它证明的是「长度检查开着也不够」——
    // 两个 scheme 都远短于上限，所以只查长度的话它们会一路写进库里。
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      assert.ok([...bad].length <= BRANDING_LIMITS.logoUrl,
        '前提变了：这个串已经超过长度上限，那还有第二条理由拒它')
    }
    // 去掉 scheme 这条规则（只留长度与空值），上面两个串就是「合法」的：
    const lengthOnly = (v) => [...v.trim()].length <= BRANDING_LIMITS.logoUrl
    assert.equal(lengthOnly('javascript:alert(1)'), true)
    assert.equal(lengthOnly('data:text/html,<script>alert(1)</script>'), true)
  })

  test('非字符串不静默强转，报 KVVI_BRANDING_NOT_A_STRING', () => {
    for (const bad of [123, true, {}, ['a']]) {
      assert.deepEqual(checkBrandingPatch({ name: bad }).problems,
        [{ field: 'name', reason: 'KVVI_BRANDING_NOT_A_STRING' }])
    }
  })

  test('请求体不是对象 → 整条拒，而不是当成「一个字段都没给」', () => {
    for (const bad of [[], 'ACME', 42, true]) {
      assert.deepEqual(checkBrandingPatch(bad).problems,
        [{ field: null, reason: 'KVVI_BRANDING_BODY_NOT_OBJECT' }])
    }
  })

  test('★ 反证：把「空串」当成「没改」的写法，就清不掉标语', () => {
    // 这是很多地方真的会写的合并逻辑：空值一律回落到旧值。
    const naiveMerge = (given, old) =>
      (given === undefined || given === null || given === '' ? old : given)
    assert.equal(naiveMerge('', '更好用的每一天'), '更好用的每一天',
      '朴素合并下「清空标语」这个动作表达了 —— 而它本来应当表达不了')

    // 本实现：空串 → null（列写成 NULL），调用方要的清空是真的清空。
    assert.equal(checkBrandingPatch({ tagline: '' }).patch.tagline, null)
    // 而「没给」与「给了空」在 patch 里是两种形状：键在不在。
    assert.equal(Object.hasOwn(checkBrandingPatch({}).patch, 'tagline'), false)
  })
})

// ── 读：任何有效会话 ─────────────────────────────────────────────────────

describe('读品牌：任何有效会话都能读', () => {
  test('★ 所有者写入后，**普通成员**读得到同一个牌子', async () => {
    const before1 = await auditHead()
    const written = await api('PUT', PATH, owner, {
      name: '某某科技有限公司', logoUrl: 'https://cdn.example.com/logo.png',
      tagline: '让每一天的流程都更短一点',
    })
    assert.equal(written.status, 200)
    assert.deepEqual(written.body, {
      name: '某某科技有限公司', logoUrl: 'https://cdn.example.com/logo.png',
      tagline: '让每一天的流程都更短一点',
    })

    // ★ 这一条是整组里最要紧的：牌子显示在**员工**的界面上，
    //   而员工没有任何平台角色。它要是读不到，界面就静默回落到产品名。
    const staff = await read(employee)
    assert.equal(staff.status, 200, '成员读不到牌子')
    assert.equal(staff.body.name, '某某科技有限公司')
    assert.equal(staff.body.logoUrl, 'https://cdn.example.com/logo.png')
    assert.equal(staff.body.tagline, '让每一天的流程都更短一点')

    // 写成功也留痕。
    const entries = await auditSince(before1)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].outcome, 'ALLOW')
  })

  test('★ 同一个成员在管理面是 403 —— 品牌这一读不是因为「谁都有权限」', async () => {
    // 对照：证明「成员能读品牌」不是因为这道接口没有闸，而是这道闸**故意**
    // 只对写生效。管理面同一时刻对同一个人是拒绝的。
    const managing = await api('GET', '/api/v1/admin/members', employee)
    assert.equal(managing.status, 403)
    assert.equal(managing.body.error, 'KVVI_NOT_A_PLATFORM_ADMIN')

    const branding = await read(employee)
    assert.equal(branding.status, 200)
  })

  test('未登录 → 401，且一个字段都不返回', async () => {
    const r = await read(null)
    assert.equal(r.status, 401)
    assert.equal(r.body.error, 'KVVI_TOKEN_REQUIRED')
    assert.equal(r.body.name, undefined, '未鉴权却返回了品牌名')
  })

  test('所有者配过之后清空：空串写进去的是 NULL，读出来是 null', async () => {
    await api('PUT', PATH, owner, { name: '临时名字', tagline: '临时标语' })
    await api('PUT', PATH, owner, { name: '', tagline: '   ' })
    const r = await read(employee)
    assert.equal(r.status, 200)
    assert.equal(r.body.name, null)
    assert.equal(r.body.tagline, null)
    // ★ 反证在下面那一条：写成空串的实现读出来会是 `''`，客户端就分不出
    //   「没配」与「配了个空的」。
    const row = await rowOf(A.company)
    assert.equal(row.brand_name, null)
    assert.equal(row.brand_tagline, null)
  })

  test('★ 反证：库里直接写空串的话，`IS NULL` 判不出来', async () => {
    // 模拟「不做归一化」的实现：把空串原样写进列。
    await seedBranding(A.company, '', null, null)
    const naive = await pool('platform').query(
      `SELECT brand_name IS NULL AS is_null, brand_name = '' AS is_empty
         FROM companies WHERE company_id = $1`, [A.company])
    assert.equal(naive.rows[0].is_null, false,
      '前提变了：正常情况下空串与 NULL 在库里必须区分得开')
    assert.equal(naive.rows[0].is_empty, true,
      '空串被记成了「设过但为空」—— 客户端只能猜它是不是「没配」')

    // 同一个输入走接口，落的是 NULL。
    await api('PUT', PATH, owner, { name: '' })
    const viaApi = await rowOf(A.company)
    assert.equal(viaApi.brand_name, null)
  })

  test('三件一起返回写完之后的**完整值**', async () => {
    await seedBranding(A.company, null, null, null)
    const after = await api('PUT', PATH, owner, { name: '甲', tagline: '乙' })
    assert.equal(after.status, 200)
    assert.deepEqual(after.body, { name: '甲', logoUrl: null, tagline: '乙' })
  })
})

// ── 写：仅所有者 ─────────────────────────────────────────────────────────

describe('写品牌：仅所有者', () => {
  before(async () => {
    await seedBranding(A.company, '原始牌子', null, null)
  })

  test('★ 成员写 → 403，且**没有改动**（403 不能是「说拒了其实写了」）', async () => {
    const head = await auditHead()
    const r = await api('PUT', PATH, employee, { name: '成员改的牌子' })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_OWNER_REQUIRED')
    assert.equal((await rowOf(A.company)).brand_name, '原始牌子', '被拒的写居然改了值')

    const denials = await auditSince(head)
    assert.equal(denials.length, 1)
    assert.equal(denials[0].outcome, 'DENY')
    assert.equal(denials[0].reason, 'KVVI_OWNER_REQUIRED')
  })

  test('★ 反证：`admin`（被委托者）也写不了 —— 品牌不是「谁能管理」', async () => {
    // 先证明这个 admin 不是「没权限的人」：管理面的能力表说他能管成员与角色。
    const caps = await api('GET', '/api/v1/admin/capabilities', delegate)
    assert.equal(caps.status, 200)
    assert.equal(caps.body.role, 'admin')
    assert.equal(caps.body.canManageMembers, true,
      '前提变了：这个账号本来就该有管理权，否则这条用例证的是「他是个无关的人」')
    assert.equal(caps.body.canManageRoles, true)

    // 牌子这一处仍然拒：对外身份与「谁能管理」不是一件事。
    const head = await auditHead()
    const r = await api('PUT', PATH, delegate, { name: '被委托者改的牌子' })
    assert.equal(r.status, 403)
    assert.equal(r.body.error, 'KVVI_OWNER_REQUIRED')
    assert.equal((await rowOf(A.company)).brand_name, '原始牌子')

    // 而他**读**得到 —— 读那一侧本来就不限角色。
    assert.equal((await read(delegate)).status, 200)
    assert.equal((await auditSince(head))[0].outcome, 'DENY')
  })

  test('未登录写 → 401，且不落任何值', async () => {
    const r = await api('PUT', PATH, null, { name: '匿名' })
    assert.equal(r.status, 401)
    assert.equal((await rowOf(A.company)).brand_name, '原始牌子')
  })

  test('所有者写 → 200；同一件事再写一次不报错（幂等的样子）', async () => {
    const first = await api('PUT', PATH, owner, { name: '某某科技' })
    assert.equal(first.status, 200)
    const second = await api('PUT', PATH, owner, { name: '某某科技' })
    assert.equal(second.status, 200)
    assert.equal(second.body.name, '某某科技')
  })

  test('★ 未给的字段不动：只写 tagline 时，name 与 logoUrl 原样留着', async () => {
    await seedBranding(A.company, '不该被抹掉的名字', 'https://cdn.example.com/a.png', '旧标语')
    const r = await api('PUT', PATH, owner, { tagline: '新标语' })
    assert.equal(r.status, 200)
    const row = await rowOf(A.company)
    assert.equal(row.brand_name, '不该被抹掉的名字', '没给的字段被写空了')
    assert.equal(row.brand_logo_url, 'https://cdn.example.com/a.png')
    assert.equal(row.brand_tagline, '新标语')
  })

  test('★ 只清一个字段：name 清空而 logoUrl 留下', async () => {
    await seedBranding(A.company, '要清掉的名字', 'https://cdn.example.com/b.png', null)
    const r = await api('PUT', PATH, owner, { name: null })
    assert.equal(r.status, 200)
    const row = await rowOf(A.company)
    assert.equal(row.brand_name, null)
    assert.equal(row.brand_logo_url, 'https://cdn.example.com/b.png', '清一个字段把另一个也清了')
  })

  test('★ 空改（一个字段都没给）：值不变，且**不留痕**', async () => {
    await seedBranding(A.company, '空改前的名字', null, null)
    const head = await auditHead()
    const r = await api('PUT', PATH, owner, {})
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { name: '空改前的名字', logoUrl: null, tagline: null })
    assert.equal((await rowOf(A.company)).brand_name, '空改前的名字')
    // 一条「改了什么也没改」的审计会让「谁改过牌子」这个问题变模糊。
    assert.deepEqual(await auditSince(head), [], '空改留下了一条审计')
  })

  test('未知路径 → 404（`/company` 下只认 branding）', async () => {
    const r = await api('GET', '/api/v1/company/other', owner)
    assert.equal(r.status, 404)
    assert.equal(r.body.error, 'KVVI_UNKNOWN_ROUTE')
  })
})

// ── 校验失败：400，且一个字段都不写 ──────────────────────────────────────

describe('校验失败：400 KVVI_BRANDING_INVALID', () => {
  before(async () => {
    await seedBranding(A.company, '校验前的名字', null, null)
  })

  test('★ `javascript:` 与 `data:` 的 LOGO → 400，带上逐字段的 problems', async () => {
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=']) {
      const r = await api('PUT', PATH, owner, { logoUrl: bad })
      assert.equal(r.status, 400, `${bad} 没有被拒`)
      assert.equal(r.body.error, 'KVVI_BRANDING_INVALID')
      assert.deepEqual(r.body.problems, [{ field: 'logoUrl', reason: 'KVVI_BRANDING_LOGO_URL_NOT_HTTP' }])
      assert.equal((await rowOf(A.company)).brand_logo_url, null, '被拒的值写进库了')
    }
  })

  test('★ 超长 name（61）→ 400；刚好 60 放行', async () => {
    const over = await api('PUT', PATH, owner, { name: 'n'.repeat(61) })
    assert.equal(over.status, 400)
    assert.equal(over.body.error, 'KVVI_BRANDING_INVALID')
    assert.deepEqual(over.body.problems, [{ field: 'name', reason: 'KVVI_BRANDING_NAME_TOO_LONG' }])
    assert.equal((await rowOf(A.company)).brand_name, '校验前的名字', '被拒的值写进库了')

    const ok = await api('PUT', PATH, owner, { name: 'n'.repeat(60) })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.name.length, 60)
  })

  test('★ 一处不合规 → **整条请求一个字段都不写**', async () => {
    await seedBranding(A.company, '校验前的名字', null, null)
    const r = await api('PUT', PATH, owner,
      { name: '合法的名字', logoUrl: 'javascript:alert(1)', tagline: '合法的标语' })
    assert.equal(r.status, 400)
    assert.equal(r.body.problems.length, 1)
    const row = await rowOf(A.company)
    // 半写会留下「品牌设了一半」，而调用方拿到 400 会以为什么都没发生。
    assert.equal(row.brand_name, '校验前的名字', '半个请求被写进去了')
    assert.equal(row.brand_tagline, null)
  })

  test('多个字段同时不合规 → problems 逐条列出，顺序稳定', async () => {
    const r = await api('PUT', PATH, owner,
      { name: 'n'.repeat(61), logoUrl: 'data:text/html,x', tagline: 't'.repeat(81) })
    assert.equal(r.status, 400)
    assert.deepEqual(r.body.problems, [
      { field: 'name', reason: 'KVVI_BRANDING_NAME_TOO_LONG' },
      { field: 'logoUrl', reason: 'KVVI_BRANDING_LOGO_URL_NOT_HTTP' },
      { field: 'tagline', reason: 'KVVI_BRANDING_TAGLINE_TOO_LONG' },
    ])
  })

  test('★ 反证：库本身**不限制**长度 —— 上限只在接口这一层', async () => {
    // 绕开接口直接写一个远超上限的牌子名：数据库照收。
    const huge = 'x'.repeat(5000)
    await seedBranding(A.company, huge, null, null)
    const row = await rowOf(A.company)
    assert.equal(row.brand_name.length, 5000,
      '前提变了：如果列上有约束，这条反证就不再说明「上限只在接口层」')

    // 于是「61 个字符被拒」这件事，只可能来自接口里的那条检查。
    const r = await api('PUT', PATH, owner, { name: 'y'.repeat(61) })
    assert.equal(r.status, 400)
    assert.equal((await rowOf(A.company)).brand_name.length, 5000, '被拒的写改动了值')
    await seedBranding(A.company, '校验前的名字', null, null)
  })

  test('校验失败也留拒绝痕（不留明文）', async () => {
    const head = await auditHead()
    await api('PUT', PATH, owner, { logoUrl: 'javascript:alert(1)' })
    const denials = await auditSince(head)
    assert.equal(denials.length, 1)
    assert.equal(denials[0].outcome, 'DENY')
    assert.equal(denials[0].reason, 'KVVI_BRANDING_INVALID')
    // 摘要里放的是违规清单，不是提交的值。
    assert.equal(denials[0].params_digest,
      digestOf([{ field: 'logoUrl', reason: 'KVVI_BRANDING_LOGO_URL_NOT_HTTP' }]))
  })

  test('公司只从会话来：体内带 companyId 也不认（已剥掉），且不返回它', async () => {
    const r = await api('PUT', PATH, owner,
      { name: '只该改自己家', companyId: B.company })
    assert.equal(r.status, 200)
    assert.equal((await rowOf(A.company)).brand_name, '只该改自己家')
    assert.equal((await rowOf(B.company)).brand_name, null)
  })
})

// ── 审计：旧值留得下痕 ───────────────────────────────────────────────────

describe('审计：写之前的旧值留有可核对的痕', () => {
  test('★ 摘要覆盖**旧值**：同样的新值、从不同的旧值改过去，摘要不同', async () => {
    const head = await auditHead()

    const b1 = { name: '起点甲', logoUrl: null, tagline: null }
    await seedBranding(A.company, b1.name, null, null)
    const a1 = (await api('PUT', PATH, owner, { name: '终值' })).body

    const b2 = { name: '起点乙', logoUrl: null, tagline: null }
    await seedBranding(A.company, b2.name, null, null)
    const a2 = (await api('PUT', PATH, owner, { name: '终值' })).body

    // 前提：两次的**新值**一模一样，只有旧值不同。
    assert.deepEqual(a1, a2)

    const entries = await auditSince(head)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].params_digest, digestOf({ before: b1, after: a1 }),
      '第 1 条的摘要对不上「旧值 + 新值」—— 旧值没有进摘要')
    assert.equal(entries[1].params_digest, digestOf({ before: b2, after: a2 }))

    // ★ 反证：只摘要新值的实现，这两条会算出**同一个**摘要。
    assert.equal(digestOf({ after: a1 }), digestOf({ after: a2 }))
    assert.notEqual(entries[0].params_digest, entries[1].params_digest,
      '两次不同的历史算出同一个摘要 —— 旧值在审计里查不到')
  })

  test('审计条目指向本公司，且动作名稳定', async () => {
    const head = await auditHead()
    await api('PUT', PATH, owner, { tagline: '留痕用' })
    const [entry] = await auditSince(head)
    assert.equal(entry.resource_id, A.company)
  })
})

// ── 跨公司隔离 ───────────────────────────────────────────────────────────

describe('跨公司隔离', () => {
  test('★ A 公司的会话读不到 B 公司的牌子', async () => {
    await seedBranding(B.company, 'B 家的牌子', 'https://b.example.com/logo.png', 'B 的标语')
    await seedBranding(A.company, 'A 家的牌子', null, null)

    const asB = await read(bOwner)
    assert.equal(asB.status, 200)
    assert.equal(asB.body.name, 'B 家的牌子', 'B 的会话读到了别人家的牌子')
    assert.equal(asB.body.logoUrl, 'https://b.example.com/logo.png')

    const asA = await read(owner)
    assert.equal(asA.body.name, 'A 家的牌子')
    assert.equal(asA.body.logoUrl, null, 'A 的会话拿到了 B 的 LOGO')
  })

  test('★ B 公司的会话写着 B，A 的牌子一个字都没动', async () => {
    await seedBranding(A.company, 'A 家的牌子', null, null)
    await seedBranding(B.company, 'B 家的牌子', null, null)

    const r = await api('PUT', PATH, bOwner, { name: 'B 改过的牌子' })
    assert.equal(r.status, 200)
    assert.equal(r.body.name, 'B 改过的牌子')
    assert.deepEqual(await rowOf(A.company), {
      brand_name: 'A 家的牌子', brand_logo_url: null, brand_tagline: null,
    }, 'B 的写改到了 A 家')
  })

  test('★ 反证：体内带别人的 companyId，改的仍然是自己的', async () => {
    await seedBranding(A.company, 'A 家的牌子', null, null)
    await seedBranding(B.company, 'B 家的牌子', null, null)

    // 这是「调用方声明租户」的那条老路：如果路由读了体内的 companyId，
    // 下面这一次会改掉 A 家。
    const r = await api('PUT', PATH, bOwner,
      { name: 'B 想写成 A 的名字', companyId: A.company })
    assert.equal(r.status, 200)
    assert.equal((await rowOf(A.company)).brand_name, 'A 家的牌子',
      'A 家的牌子被 B 的会话改动了 —— 公司没有只从会话来')
    assert.equal((await rowOf(B.company)).brand_name, 'B 想写成 A 的名字')

    // B 也读不到 A 家的牌子（读那一侧同样只认会话）。
    await seedBranding(A.company, 'A 家的牌子', null, null)
    const asB = await read(bOwner)
    assert.equal(asB.body.name, 'B 想写成 A 的名字')
  })

  test('B 的普通会话（非 owner）读得到自己家的牌子', async () => {
    await seedBranding(B.company, 'B 家的牌子', null, null)
    const r = await read(bOwner)
    assert.equal(r.status, 200)
    assert.equal(r.body.name, 'B 家的牌子')
  })
})

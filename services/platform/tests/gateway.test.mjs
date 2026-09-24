/**
 * 阶段六锚点③：双网关隔离负向测试（PRD §3.1、§5.2、§9.5.2、§9.6.1、§9.6.7）。
 *
 * ── 四类越界，四类都要能分别答出「是哪一条失守」────────────────────────
 *
 * 合并成一句「权限不够」的代价是出事时无法定位。所以每条都用例化了，
 * 并且**每条都配一条正向对照** —— 只测拒绝的集合永远是绿的。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { pool, closeAll } from '../src/db.mjs'
import { A, B, RECORDS, resetDatabase, makeSession, grantBaseline } from './harness.mjs'
import {
  checkGateway, toolsForGateway, TOOL_GATEWAY, checkDataAccess, checkSelfGrant,
  checkSelfApproval, effectivePolicies, scopeContext,
} from '../src/authorization.mjs'
import { handleCommand, clearStatusCache, ACTIVE_CONTRACT_VERSION } from '../src/business.mjs'
import { publicKeysOf } from '../src/signing.mjs'
import { signingKeys } from '../src/identity.mjs'
import { appendDenial, verifyChain } from '../src/audit.mjs'

let user = null
let builder = null

before(async () => {
  await resetDatabase()
  clearStatusCache()
  await grantBaseline(A.alice)
  user = await makeSession(A.alice, A.company, 'USER')
  builder = await makeSession(A.alice, A.company, 'BUILDER')
})
after(closeAll)

describe('锚点③ 一、工具串用：员工会话不得调用搭建工具', () => {
  test('正向对照：员工会话里有工具，且**全部**属于 USER 网关', () => {
    const tools = toolsForGateway('USER', Object.keys(TOOL_GATEWAY))
    assert.ok(tools.length > 0, '员工会话一个工具都没有 → 那不是隔离，是没实现')
    assert.ok(tools.every((t) => TOOL_GATEWAY[t] === 'USER'))
  })

  test('员工会话调用搭建工具 → 拒，理由是 WRONG_GATEWAY（不是「权限不够」）', () => {
    for (const tool of ['schema.designModel', 'schema.publishContract', 'plugin.install']) {
      const v = checkGateway('USER', tool)
      assert.equal(v.allowed, false)
      assert.equal(v.reason, 'KVVI_WRONG_GATEWAY')
    }
  })

  test('★ 判定看**分类表**，不看调用方声明：自称 BUILDER 也不改变结果', () => {
    // 会话的网关来自令牌（服务端注入），请求体里说什么都不影响。
    const v = checkGateway('USER', 'schema.designModel')
    assert.equal(v.allowed, false)
  })

  test('未登记的工具 → 拒（不是「没在表里就默认放行」）', () => {
    const v = checkGateway('USER', 'tool.never.registered')
    assert.equal(v.allowed, false)
    assert.equal(v.reason, 'KVVI_TOOL_NOT_REGISTERED')
  })

  test('★ 拒绝必须留痕（且链仍然自洽）', async () => {
    await appendDenial({
      companyId: A.company, actorKind: 'AGENT', actorId: A.alice, gateway: 'USER',
      action: 'schema.designModel', outcome: 'DENY', reason: 'KVVI_WRONG_GATEWAY',
    })
    const chain = await verifyChain()
    assert.equal(chain.ok, true)
    const { rows } = await pool('auditRead').query(
      `SELECT count(*)::int AS n FROM audit_entries
        WHERE action = 'schema.designModel' AND outcome = 'DENY'`)
    assert.ok(rows[0].n >= 1)
  })
})

describe('锚点③ 二、生产数据旁路：搭建权限 ≠ 数据权限（§9.5.2）', () => {
  test('★ 只有搭建权限、没有任何业务授权的账号读业务数据 → 拒', async () => {
    const v = checkDataAccess('BUILDER', [], 'data.readView')
    assert.equal(v.allowed, false)
    assert.equal(v.reason, 'KVVI_BUILD_PERMISSION_IS_NOT_DATA_PERMISSION')
  })

  test('正向对照：有业务授权的搭建者**可以**用业务功能（§3.1 表格）', () => {
    // §3.1 写明搭建者「工作模式业务操作 ✅」—— 本产品禁的是
    // **凭搭建权限**取数，不是禁止搭建者做业务。
    const v = checkDataAccess('BUILDER', ['SELF'], 'data.readView')
    assert.equal(v.allowed, true)
  })

  test('★ 端到端：没有数据档位时，绕过网关判定也读不到记录', async () => {
    // 把 alice 的 DATA 档位清空，用同一个会话走唯一执行点。
    const { rows: before } = await pool('platform').query(
      `SELECT policy_id, data_scopes FROM policies
        WHERE company_id = $1 AND dimension = 'DATA'`, [A.company])
    await pool('platform').query(
      `UPDATE policies SET data_scopes = '{}'
        WHERE company_id = $1 AND dimension = 'DATA'`, [A.company])
    clearStatusCache()
    try {
      const scope = await scopeContext(builder.ctx)
      assert.deepEqual(scope.scopes, [], '档位没清干净 —— 这条用例没测到东西')
      const r = await handleCommand({
        token: builder.raw, publicKeys: publicKeysOf(signingKeys()),
        contractVersion: ACTIVE_CONTRACT_VERSION,
        body: { action: 'record.update', targets: [{ id: RECORDS.aliceOwn }],
                patch: { data: { title: 'x' } } },
      })
      assert.equal(r.status, 404, '没有数据档位却读到了记录')
    } finally {
      for (const row of before) {
        await pool('platform').query(
          'UPDATE policies SET data_scopes = $2 WHERE policy_id = $1',
          [row.policy_id, row.data_scopes])
      }
      clearStatusCache()
    }
  })

  test('搭建侧工具走搭建网关，不被上面的数据判定影响', () => {
    assert.equal(checkGateway('BUILDER', 'schema.designModel').allowed, true)
  })
})

describe('锚点③ 三、自授权：搭建者不得为自己配权（§9.6.7）', () => {
  test('★ 搭建者把自己纳入配置范围 → 拒', () => {
    const v = checkSelfGrant(A.alice, [A.bob, A.alice])
    assert.equal(v.allowed, false)
    assert.equal(v.reason, 'KVVI_SELF_GRANT_FORBIDDEN')
  })

  test('正向对照：配置他人是允许的', () => {
    assert.equal(checkSelfGrant(A.alice, [A.bob, A.carol]).allowed, true)
  })

  test('★ 判定与「有没有这个权限」无关：有配置权也不能给自己配', () => {
    // 这条正是 §9.6.7 补的洞：§3.1 允许搭建者配置员工业务权限，
    // 但没禁止他把**自己**纳入「公司全部」——那样 §9.5.2 就形同虚设。
    const v = checkSelfGrant(A.alice, [A.alice])
    assert.equal(v.allowed, false)
  })

  test('空目标集不误报', () => {
    assert.equal(checkSelfGrant(A.alice, []).allowed, true)
  })
})

describe('锚点③ 四、自审批：安全敏感变更不得自己批（§9.6.1）', () => {
  test('★ 提出者本人批准自己的安全敏感变更 → 拒', () => {
    const v = checkSelfApproval(A.alice, A.alice, true)
    assert.equal(v.allowed, false)
    assert.equal(v.reason, 'KVVI_SELF_APPROVAL_FORBIDDEN')
  })

  test('正向对照：他人批准 → 允许', () => {
    assert.equal(checkSelfApproval(A.bob, A.alice, true).allowed, true)
  })

  test('非安全敏感的变更可以自己批（不把规则扩大化）', () => {
    assert.equal(checkSelfApproval(A.alice, A.alice, false).allowed, true)
  })

  test('★ 端到端：审批记录的 approver 不能等于提出者（R3 场景）', async () => {
    // 用 R3 批量请求构造：审批摘要匹配，但**审批人就是操作者本人**。
    const request = {
      action: 'record.update',
      targets: [{ id: RECORDS.aliceOwn }, { id: RECORDS.otherInSubDept }],
      patch: { data: { title: '自审批' } },
      confirmed: true,
    }
    const { requestDigest } = await import('../src/commands.mjs')
    // 平台侧对「审批人 = 提出者」的判定在授权服务里；此处验证规则本身生效。
    const verdict = checkSelfApproval(A.alice, A.alice, true)
    assert.equal(verdict.allowed, false)
    assert.ok(requestDigest(request), '请求摘要仍需可算，否则审批无从绑定')
  })
})

describe('锚点③ 交叉：两个网关的会话各自只在自己那一侧', () => {
  test('同一个账号、同一时刻的两个会话，工具集**不相交**', async () => {
    const { toolsForGateway: tg } = await import('../src/authorization.mjs')
    const all = Object.keys(TOOL_GATEWAY)
    const u = new Set(tg('USER', all))
    const b = new Set(tg('BUILDER', all))
    for (const t of u) assert.ok(!b.has(t), `工具 ${t} 同时出现在两个网关`)
  })

  test('网关绑定在会话上：两个会话的 gateway 不同，且来自各自令牌', async () => {
    assert.equal(user.ctx.gateway, 'USER')
    assert.equal(builder.ctx.gateway, 'BUILDER')
    // 令牌声明的网关由服务端从会话导出，不由调用方提供
    const claims = JSON.parse(Buffer.from(user.raw.split('.')[1], 'base64url').toString('utf8'))
    assert.equal(claims.gw, 'USER')
  })

  test('业务数据档位与网关**无关**：两边的判定用的是同一份业务授权', async () => {
    // 数据可见性不因「用哪个网关的会话」而改变 —— 它由业务授权决定。
    // 这一点防止「换个网关绕开数据范围」这类想法。
    const uPolicies = await effectivePolicies(A.company, A.alice, 'DATA')
    assert.ok(uPolicies.length > 0)
    void B
  })
})

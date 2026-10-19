/**
 * The Worker's business tools.
 *
 * ── What these tests must prove ─────────────────────────────────────────────
 *
 * | # | Property | What breaks without it |
 * |---|---|---|
 * | 1 | Identity comes from the mode context, never from arguments | A prompt-injected model reads another company |
 * | 2 | A nested identity field is rejected **before** the request | A top-level-only check passes exactly the request that matters |
 * | 3 | The platform's refusal reaches the model unchanged | The Agent and the UI report different codes for the same denial |
 * | 4 | A claimed success is one the platform confirmed | The model tells the user an action happened when it did not |
 * | 5 | The signed header format matches the platform's verifier | The tool authenticates to nothing, and the failure looks like a 401 |
 * | 6 | A wrong field code comes back with the platform's declared-field list |
 *       The model cannot correct itself on the next call — it guesses until it gives up |
 *
 * ⚠️ 5 — that the signed header format matches the platform's verifier — is
 * **not** checked here. This package ships standalone inside the fork; a test
 * importing the platform's sources would only pass in the KVVI-Agent working
 * tree and would break the delivered fork. The cross-implementation check is a
 * command-level step in `工具/check_stage10.py`, which runs both processes and
 * compares the bytes — the same shape the stage-8 checker uses for the mode
 * headers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { KvviModeRouter, ModeContext } from '@deepseek-ai/dsh-host-kvvi-mode-router'
import { contextHeaders, request, refusalMessage } from '../src/client.ts'
import type { CallContext } from '../src/client.ts'
import { apply, assertNoIdentityFields } from '../src/index.ts'

const MODE = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  companyId: '33333333-3333-4333-8333-333333333333',
  gateway: 'USER' as const,
}
const SECRET = 'stage10-runtime-context-secret'

/** Build a `CallContext` whose transport is the given fake. */
function context(fetchImpl: typeof fetch): CallContext {
  return { mode: MODE, baseUrl: 'http://platform.test', secret: SECRET, fetchImpl }
}

/** A fetch double recording its calls. */
function recorder(status: number, body: unknown): {
  readonly fetchImpl: typeof fetch
  readonly calls: readonly { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve({ ok: status < 400, status, json: async () => body })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('签名上下文', () => {
  it('五个头齐全，且名字与平台约定一致', () => {
    const headers = contextHeaders(MODE, SECRET, 1_700_000_000_000)
    expect(Object.keys(headers).sort()).toEqual([
      'x-kvvi-company', 'x-kvvi-gateway', 'x-kvvi-issued-at',
      'x-kvvi-session', 'x-kvvi-signature', 'x-kvvi-user',
    ])
    expect(headers['x-kvvi-issued-at']).toBe('1700000000000')
  })

  it('空密钥直接拒绝 —— 不签一个谁都能造的上下文', () => {
    expect(() => contextHeaders(MODE, '')).toThrow(/KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED/u)
  })

  it('签名覆盖公司、用户与网关 —— 改一个字段签名就变', () => {
    const base = contextHeaders(MODE, SECRET, 1)
    const other = contextHeaders({ ...MODE, companyId: 'other' }, SECRET, 1)
    expect(other['x-kvvi-signature']).not.toBe(base['x-kvvi-signature'])
    // 手算一遍，确认它签的确实是那五个字段而不只是「有点变化」。
    const expected = createHmac('sha256', SECRET)
      .update(['v1', MODE.sessionId, MODE.userId, MODE.companyId, MODE.gateway, '1'].join('\n'))
      .digest('hex')
    expect(base['x-kvvi-signature']).toBe(expected)
  })
})

describe('身份字段拦截', () => {
  it('★ 嵌套的身份字段也被拦下 —— 那正是真实的载荷形状', () => {
    // 记录载荷天然是嵌套的：只在顶层查的实现会放过这一条。
    expect(() => assertNoIdentityFields({ title: 'x', nested: { tenant: 'other' } }))
      .toThrow(/KVVI_IDENTITY_FIELD_FORBIDDEN: nested\.tenant/u)
  })

  it('数组元素里的身份字段同样拦下', () => {
    expect(() => assertNoIdentityFields({ rows: [{ ok: 1 }, { gateway: 'BUILDER' }] }))
      .toThrow(/KVVI_IDENTITY_FIELD_FORBIDDEN: rows\[1\]\.gateway/u)
  })

  it('大小写不敏感：`CompanyId` 一样是身份字段', () => {
    expect(() => assertNoIdentityFields({ data: { CompanyId: 'x' } }))
      .toThrow(/KVVI_IDENTITY_FIELD_FORBIDDEN/u)
  })

  it('普通业务字段照常通过', () => {
    expect(() => assertNoIdentityFields({
      title: '报销', amount: '500', rows: [{ reason: 'ok' }],
    })).not.toThrow()
  })
})

describe('契约客户端', () => {
  it('请求落在 /api/v1 下，并带上签名的五个头', async () => {
    const fake = recorder(200, { items: [] })
    await request(context(fake.fetchImpl), 'GET', '/systems/leave/records')
    const call = fake.calls[0]
    expect(call?.url).toBe('http://platform.test/api/v1/systems/leave/records')
    const headers = call?.init.headers as Record<string, string>
    expect(headers['x-kvvi-session']).toBe(MODE.sessionId)
    expect(headers['x-kvvi-company']).toBe(MODE.companyId)
    expect(headers['x-kvvi-signature']).toBeTypeOf('string')
  })

  it('★ 平台的错误码原样带出，不塌成一个布尔', async () => {
    const fake = recorder(409, { error: 'KVVI_ROW_VERSION_CONFLICT', currentRowVersion: 9 })
    const result = await request(context(fake.fetchImpl), 'PATCH', '/systems/leave/records/r1', {})
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ code: 'KVVI_ROW_VERSION_CONFLICT', status: 409 })
  })

  it('★ 200 但不是 JSON 时不算成功', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: async () => { throw new Error('not json') },
    })) as unknown as typeof fetch
    const result = await request(context(fetchImpl), 'GET', '/systems')
    expect(result).toMatchObject({ ok: false, code: 'KVVI_BAD_RESPONSE' })
  })

  it('连不上平台与平台拒绝是不同的码', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    const result = await request(context(fetchImpl), 'GET', '/systems')
    expect(result).toMatchObject({ ok: false, code: 'KVVI_PLATFORM_UNREACHABLE' })
  })

  it('缺契约的那几份出现在 detail 里，而不是消失', async () => {
    const fake = recorder(404, { error: 'KVVI_RUNTIME_CONTRACT_INCOMPLETE',
      missing: ['workflow-spec', 'tool-spec'] })
    const result = await request(context(fake.fetchImpl), 'GET', '/systems/x/runtime')
    expect(refusalMessage(result as never)).toContain('workflow-spec')
  })

  it('★ 逐字段的拒绝项带出来：猜错一个编码，下一轮才改得对', async () => {
    // 平台在 `problems[].detail.declaredFields` 里给了**答案**。
    // 丢掉它，模型看到的就是一句「这个字段没声明」——
    // 现场就是这样：猜了三轮，最后放弃这次写入。
    const fake = recorder(400, {
      error: 'KVVI_FIELD_NOT_DECLARED',
      problems: [
        { field: 'phone', reason: 'KVVI_FIELD_NOT_DECLARED',
          detail: { declaredFields: ['customer_name', 'contact_name', 'contact_phone', 'follow_status'] } },
        { field: 'contact_name', reason: 'KVVI_FIELD_REQUIRED', detail: { by: 'model' } },
      ],
    })
    const result = await request(context(fake.fetchImpl), 'POST', '/systems/customer/records',
      { data: { phone: '138' } })
    const message = refusalMessage(result as never)
    expect(message).toContain('KVVI_FIELD_NOT_DECLARED')
    expect(message).toContain('phone')
    expect(message).toContain('contact_phone')
    // 漏掉的必填字段名一样要出现 —— 现场连 `contact_name` 没填都没意识到。
    expect(message).toContain('contact_name')
  })

  it('形状不对的拒绝项不会把错误处理本身炸掉', async () => {
    const fake = recorder(400, {
      error: 'KVVI_FIELD_NOT_DECLARED',
      problems: [{ field: 'phone' }, 'not a problem', null],
    })
    const result = await request(context(fake.fetchImpl), 'POST', '/systems/customer/records', {})
    expect(refusalMessage(result as never)).toBe('KVVI_FIELD_NOT_DECLARED')
  })

  it('不是 JSON 的失败响应也能得到一个人看得懂的码', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: false, status: 502, json: async () => { throw new Error('html') },
    })) as unknown as typeof fetch
    const result = await request(context(fetchImpl), 'GET', '/systems')
    expect(result).toMatchObject({ ok: false, code: 'KVVI_HTTP_502' })
  })
})

describe('工具集', () => {
  it('注册的是八个业务工具，且**不含**搭建类工具', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../src/index.ts', import.meta.url), 'utf8'))
    // 逐个点名：漏掉一个就是「模型以为能做而做不到」，多一个就是能力边界变了。
    for (const tool of ['system_list', 'record_schema', 'record_list', 'record_get', 'record_create',
      'record_update', 'workflow_available_actions', 'workflow_act']) {
      expect(source).toContain(`name: '${tool}'`)
    }
    expect(source).not.toMatch(/name: '(?:bash|shell|write|edit|read_file|skill|workflow)'/u)
    // 聚合读数**刻意不注册**：平台没有端点，注册一个永远失败的工具有害无益。
    expect(source).not.toContain("name: 'aggregate_read'")
  })

  it('★ 字段清单走的是读端点，且身份仍然只从模式路由来', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../src/index.ts', import.meta.url), 'utf8'))
    // 端点写死在这一处：换了名字而没换过来，agent 会拿到一个 404，
    // 而 404 看起来像「这个系统没有字段」。
    expect(source).toContain('/systems/${encodeURIComponent(args.system)}/fields')
    // 这条路径**没有**第二个参数 —— 身份一个都不能由模型指定。
    expect(source).not.toMatch(/fields\?[^`]*company/u)
  })

  it('★ 身份从模式路由来，不从参数来', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../src/index.ts', import.meta.url), 'utf8'))
    // 唯一的身份来源是 `ctx.kvviModeRouter.requireMode()`。
    expect(source).toContain('ctx.kvviModeRouter.requireMode()')
    // 任何一个工具的参数表里都不该出现身份字段。
    const parameters = source.slice(source.indexOf('parameters: {'), source.length)
    for (const field of ['tenant', 'companyId', 'actor', 'gateway']) {
      expect(parameters).not.toContain(`${field}: {`)
    }
  })

  it('★ 每个记录工具的 `id` 都说明「记录号也能给」', async () => {
    // 建单返回的是**记录号**，而按 id 的端点要 uuid。模型手上只有记录号，
    // 说明里不提这件事，它就只能拿记录号去试 —— 现场就是这样撞上 500 的。
    //
    // ⚠️ 平台那边**确实**会把记录号解析成 id（`services/platform/src/request-refs.mjs`）；
    //    这里测的是「模型知道不知道」，两件事缺一不可：只有解析没有说明，
    //    模型仍然不知道自己可以给；只有说明没有解析，它给了一次就被拒。
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../src/index.ts', import.meta.url), 'utf8'))
    const ref = source.match(/const RECORD_REF = ([\s\S]*?)\n\n/u)?.[1] ?? ''
    expect(ref).toContain('recordNo')
    // 四个工具共用一个常量：各自写一份就会有一份漏掉这句。
    const uses = source.match(/description: RECORD_REF/gu)?.length ?? 0
    expect(uses).toBe(4)
    expect(source).not.toMatch(/description: 'The record id\.'/u)
  })
})

describe('流程操作的一次性确认', () => {
  const contexts: Context[] = []
  const input = () => ({ system: 'leave', id: 'record-1', action: 'approve', rowVersion: 7 })

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  })

  async function setup(withApproval = true) {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    if (withApproval) await ctx.plugin(ApprovalService, { policy: 'ask' })
    let mode: ModeContext = { ...MODE, preset: 'kvvi-worker', issuedAt: Date.now() }
    ctx.provide('kvviModeRouter', { requireMode: () => mode } as unknown as KvviModeRouter)
    await ctx.plugin({ name: 'kvvi-business', inject: ['tools', 'kvviModeRouter'], apply }, {
      platformUrl: 'http://platform.test', contextSecret: SECRET,
    })
    const session = Session.create(SessionId('worker-confirmation-test'))
    session.append('turn/start', { turn: 1 })
    const agent = { session } as unknown as Agent
    const fake = recorder(200, { recordId: 'record-1', from: 'pending', state: 'approved', rowVersion: 8 })
    vi.stubGlobal('fetch', fake.fetchImpl)
    const run = (args = input(), callId = 'confirm-1') => ctx.tools.execute({
      name: 'workflow_act', arguments: args, agent,
      callId: ToolCallId(callId), signal: new AbortController().signal,
    })
    return { ctx, fake, run, agent, changeIdentity: () => {
      mode = { ...mode, sessionId: '44444444-4444-4444-8444-444444444444' }
    } }
  }

  it('没有确认服务时拒绝，不能向平台发出状态迁移', async () => {
    const { run, fake } = await setup(false)
    expect(await run()).toMatchObject({ isError: true })
    expect(fake.calls).toHaveLength(0)
  })

  it('没有应答者时拒绝，不能把无人确认当作批准', async () => {
    const { run, fake } = await setup()
    expect(await run()).toMatchObject({ isError: true })
    expect(fake.calls).toHaveLength(0)
  })

  it('允许调用的策略 hook 不能绕过执行器内的确认', async () => {
    const { ctx, run, fake } = await setup()
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    expect(await run()).toMatchObject({ isError: true })
    expect(fake.calls).toHaveLength(0)
  })

  it('等待用户确认期间中止调用，不接受迟到的批准', async () => {
    const { ctx, agent, fake } = await setup()
    const controller = new AbortController()
    ctx.on('approval/request', () => {
      controller.abort()
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    expect(await ctx.tools.execute({
      name: 'workflow_act', arguments: input(), agent,
      callId: ToolCallId('cancel-confirmation'), signal: controller.signal,
    })).toMatchObject({ isError: true })
    expect(fake.calls).toHaveLength(0)
  })

  it.each<ApprovalOutcome>(['rejected', 'cancelled'])('%s 不触发业务请求', async outcome => {
    const { ctx, run, fake } = await setup()
    ctx.on('approval/request', () => Promise.resolve(outcome))
    expect(await run()).toMatchObject({ isError: true })
    expect(fake.calls).toHaveLength(0)
  })

  it('批准仅针对一次调用，并展示准确参数和身份', async () => {
    const { ctx, run, fake, agent } = await setup()
    const seen: ApprovalRequest[] = []
    ctx.on('approval/request', req => {
      seen.push(req)
      return Promise.resolve<ApprovalOutcome>(seen.length === 1 ? 'allowed-once' : 'rejected')
    })
    expect(await run()).toMatchObject({ isError: false })
    expect(await run(input(), 'confirm-2')).toMatchObject({ isError: true })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ agent, toolName: 'workflow_act', callId: 'confirm-1' })
    for (const value of ['leave', 'record-1', 'approve', '7', MODE.companyId, MODE.userId]) {
      expect(seen[0]?.reason).toContain(value)
    }
    expect(fake.calls).toHaveLength(1)
    expect(JSON.parse(fake.calls[0]?.init.body as string)).toEqual({ action: 'approve', rowVersion: 7 })
  })

  it('批准过程中改变调用者参数，不得改变被执行的记录和版本', async () => {
    const { ctx, run, fake } = await setup()
    const args = input()
    ctx.on('approval/request', req => {
      expect(req.reason).toContain('record-1')
      args.id = 'record-2'
      args.action = 'reject'
      args.rowVersion = 99
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    expect(await run(args)).toMatchObject({ isError: false })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.url).toBe('http://platform.test/api/v1/systems/leave/records/record-1/transitions')
    expect(JSON.parse(fake.calls[0]?.init.body as string)).toEqual({ action: 'approve', rowVersion: 7 })
  })

  it('批准不能让另一份身份执行请求', async () => {
    const { ctx, run, fake, changeIdentity } = await setup()
    ctx.on('approval/request', () => {
      changeIdentity()
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    expect(await run()).toMatchObject({ isError: true })
    expect(fake.calls).toHaveLength(0)
  })

  it('平台拒绝版本冲突后返回错误，不自动再次写入', async () => {
    const { ctx, run } = await setup()
    let asks = 0
    ctx.on('approval/request', () => {
      asks++
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    const stale = recorder(409, { error: 'KVVI_ROW_VERSION_CONFLICT' })
    vi.stubGlobal('fetch', stale.fetchImpl)
    const result = await run()
    expect(asks).toBe(1)
    expect(result).toMatchObject({ isError: true })
    expect(JSON.stringify(result)).toContain('KVVI_ROW_VERSION_CONFLICT')
    expect(stale.calls).toHaveLength(1)
  })

  it('查询可执行动作不要求确认', async () => {
    const { ctx, agent } = await setup()
    const answerer = vi.fn(() => Promise.resolve<ApprovalOutcome>('rejected'))
    ctx.on('approval/request', answerer)
    const read = recorder(200, { recordId: 'record-1', state: 'pending', actions: [] })
    vi.stubGlobal('fetch', read.fetchImpl)
    expect(await ctx.tools.execute({
      name: 'workflow_available_actions', arguments: { system: 'leave', id: 'record-1' }, agent,
      callId: ToolCallId('read-actions'), signal: new AbortController().signal,
    })).toMatchObject({ isError: false })
    expect(answerer).not.toHaveBeenCalled()
    expect(read.calls).toHaveLength(1)
  })

  it('工具插件卸载后，不再保留业务工具注册', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('workflow_act')).toBeDefined()
    const runtime = ctx.registry.get(apply)
    expect(runtime).toBeDefined()
    for (const fiber of [...(runtime?.fibers ?? [])]) await fiber.dispose()
    expect(ctx.tools.get('workflow_act')).toBeUndefined()
  })
})

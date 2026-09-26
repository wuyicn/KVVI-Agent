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
 *
 * ⚠️ 5 — that the signed header format matches the platform's verifier — is
 * **not** checked here. This package ships standalone inside the fork; a test
 * importing the platform's sources would only pass in the KVVI-Agent working
 * tree and would break the delivered fork. The cross-implementation check is a
 * command-level step in `工具/check_stage10.py`, which runs both processes and
 * compares the bytes — the same shape the stage-8 checker uses for the mode
 * headers.
 */
import { describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { contextHeaders, request, refusalMessage } from '../src/client.ts'
import type { CallContext } from '../src/client.ts'
import { assertNoIdentityFields } from '../src/index.ts'

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

  it('不是 JSON 的失败响应也能得到一个人看得懂的码', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({
      ok: false, status: 502, json: async () => { throw new Error('html') },
    })) as unknown as typeof fetch
    const result = await request(context(fetchImpl), 'GET', '/systems')
    expect(result).toMatchObject({ ok: false, code: 'KVVI_HTTP_502' })
  })
})

describe('工具集', () => {
  it('注册的是六个业务工具，且**不含**搭建类工具', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../src/index.ts', import.meta.url), 'utf8'))
    // 逐个点名：漏掉一个就是「模型以为能做而做不到」，多一个就是能力边界变了。
    for (const tool of ['record_list', 'record_get', 'record_create', 'record_update',
      'workflow_available_actions', 'workflow_act']) {
      expect(source).toContain(`name: '${tool}'`)
    }
    expect(source).not.toMatch(/name: '(?:bash|shell|write|edit|read_file|skill|workflow)'/u)
    // 聚合读数**刻意不注册**：平台没有端点，注册一个永远失败的工具有害无益。
    expect(source).not.toContain("name: 'aggregate_read'")
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
})

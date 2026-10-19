/**
 * 搭建者的**提交发布**工具。
 *
 * ── 这一组要证什么 ──────────────────────────────────────────────────────
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 签名头的格式与平台验证器一致 | 工具对谁都认证不上，而失败长得像 401 |
 * | 2 | 读出的六份契约**与 CLI 脚手架同一套装订** | 同一份构建经 Agent 发与经 CLI 发，上去的是两份不同的东西 |
 * | 3 | 装订丢下的东西**逐条报出来** | 「少了一张视图」在发布成功里看不出来，在员工那儿也看不出来 |
 * | 4 | 契约目录**只能在工作区内** | 模型给一个 `/etc` 进来，这个有读文件权限的工具就会去读系统目录 |
 * | 5 | 缺一份就**不发** | 发上去一个不构成可运行系统的版本，员工打开是空的 |
 *
 * ⚠️ 第 1 条**不在本文件里做跨实现比对**：本包装在 fork 里独立发布，测试去 import
 * 平台的源码只会在 KVVI-Agent 工作树里通过、在交付出去的 fork 里断。
 * 跨实现的比对是 `工具/check_stage10.py` 那种命令级步骤（跑起两个进程比字节）。
 * 这里做的是**同一组向量**：与 `kvvi-business/tests/tools.spec.ts` 的
 * `contextHeaders` 用例用同一份期望值，漂移会在两边同时红。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModeContext } from '@deepseek-ai/dsh-host-kvvi-mode-router'
import { contextHeaders, refusalMessage, request } from '../src/client.ts'
import { apply, contractFiles, readContracts, resolveContractsDir, CONTRACT_TYPES } from '../src/index.ts'

// ⚠️ 显式标类型：`gateway` 让对象字面量推断成 `string`，而签名函数要的是那个
//    窄联合（`'BUILDER' | 'USER'`）—— 不标的话这一行会变成一个类型错误，
//    而它看起来像「函数签名不对」。
const MODE: Pick<ModeContext, 'sessionId' | 'userId' | 'companyId' | 'gateway'> = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  companyId: '33333333-3333-4333-8333-333333333333',
  gateway: 'BUILDER',
}
const SECRET = 'shared-runtime-secret'
const NOW = 1_790_000_000_000

it('passes a server build intent through the actual publish tool without approving the draft', async () => {
  const root = tree(Object.fromEntries(['business-schema', 'view-schema', 'workflow-spec',
    'permission-spec', '工具', '搭建命令'].map(t => [`契约/${t}.json`, '{}'])))
  let tool: ToolDefinition | undefined
  const calls: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return Response.json({ draftId: 'draft-from-platform', status: 'AWAITING_APPROVAL' })
  }))
  try {
    apply({ tools: { register: (value: ToolDefinition) => { tool = value } },
      kvviModeRouter: { requireMode: () => MODE }, on: () => {},
    } as unknown as Context, { platformUrl: 'http://platform.invalid', contextSecret: SECRET })
    const result = await tool!.execute({ system: 'new_form', buildIntentId: '11111111-1111-4111-8111-111111111111' },
      { agent: agentWithCwd(root) } as ToolRunContext)
    expect(result).toMatchObject({ draftId: 'draft-from-platform', status: 'AWAITING_APPROVAL' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://platform.invalid/api/v1/publish/drafts')
    expect(calls[0]?.body).toMatchObject({ assetId: 'new_form', buildIntentId: '11111111-1111-4111-8111-111111111111' })
  } finally { vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }) }
})

/** 一个只带 cwd 的会话桩 —— 工具只从它取工作区。 */
function agentWithCwd(cwd: string | undefined): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

/** 建一棵契约目录，返回它的根。 */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kvvi-publish-'))
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
  return root
}

describe('签名头：与另一侧同一组向量', () => {
  it('签的是 v1\\n会话\\n用户\\n公司\\n网关\\n时刻', () => {
    const headers = contextHeaders(MODE, SECRET, NOW)
    const body = ['v1', MODE.sessionId, MODE.userId, MODE.companyId, MODE.gateway,
      String(NOW)].join('\n')
    expect(headers['x-kvvi-signature'])
      .toBe(createHmac('sha256', SECRET).update(body).digest('hex'))
    expect(headers['x-kvvi-gateway']).toBe('BUILDER')
    expect(headers['x-kvvi-company']).toBe(MODE.companyId)
  })

  it('没有共享口令 → 拒，不签一个空密钥的 HMAC', () => {
    expect(() => contextHeaders(MODE, '')).toThrow('KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED')
  })
})

describe('契约装订：与 CLI 脚手架同一套', () => {
  it('★ 按文件名认种类，而不是按目录顺序猜', () => {
    const root = tree({
      '契约/01-客户-business-schema.json': '{}',
      '契约/02-客户登记表单-view-schema.json': '{}',
      '契约/04-跟进流程-workflow-spec.json': '{}',
      '契约/05-权限-permission-spec.json': '{}',
      '契约/06-工具/a.json': '{}',
      '契约/07-搭建命令-app-model-command.json': '{}',
    })
    try {
      const found = contractFiles(root)
      for (const type of CONTRACT_TYPES) {
        expect(found[type] ?? [], `${type} 没有认出来`).toHaveLength(1)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★ `_校验` 与 `_校验环境` 不是交付物，不混进契约里', () => {
    const root = tree({
      '契约/01-客户-business-schema.json': '{}',
      '契约/_校验/结果/view-schema-副本.json': '{}',
      '契约/_校验环境/business-schema.json': '{}',
    })
    try {
      const found = contractFiles(root)
      expect(found['business-schema']).toHaveLength(1)
      expect(found['view-schema']).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★ 多份 `工具/*.json` 按 {tools: [...]} 装订，并说出来', () => {
    const root = tree({
      '契约/01-x-business-schema.json': '{"a":1}',
      '契约/02-x-view-schema.json': '{"b":2}',
      '契约/03-x-workflow-spec.json': '{"c":3}',
      '契约/04-x-permission-spec.json': '{"d":4}',
      '契约/05-工具/t1.json': '{"tool":"1"}',
      '契约/05-工具/t2.json': '{"tool":"2"}',
      '契约/06-x-搭建命令.json': '{"e":5}',
    })
    try {
      const { contracts, notes } = readContracts(root)
      expect(contracts['tool-spec']).toEqual({ tools: [{ tool: '1' }, { tool: '2' }] })
      expect(notes.some(n => n.includes('tool-spec'))).toBe(true)
      expect(contracts['business-schema']).toEqual({ a: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('multiple views are rejected before silently losing a view', () => {
    const root = tree({
      '契约/01-x-business-schema.json': '{}',
      '契约/02-表单-view-schema.json': '{"which":"form"}',
      '契约/03-列表-view-schema.json': '{"which":"list"}',
      '契约/04-x-workflow-spec.json': '{}',
      '契约/05-x-permission-spec.json': '{}',
      '契约/06-x-工具.json': '{}',
      '契约/07-x-搭建命令.json': '{}',
    })
    try {
      expect(() => readContracts(root)).toThrow('KVVI_CONTRACT_MULTIPLE_UNSUPPORTED: view-schema')
      expect(() => readContracts(root)).toThrow('02-表单-view-schema.json')
      expect(() => readContracts(root)).toThrow('03-列表-view-schema.json')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects symbolic links before reading external contract files', () => {
    const root = tree({ 'outside.json': '{"secret":"do-not-read"}' })
    try {
      mkdirSync(join(root, '契约'))
      symlinkSync(join(root, 'outside.json'), join(root, '契约/view-schema.json'))
      expect(() => readContracts(join(root, '契约'))).toThrow('KVVI_CONTRACT_SYMLINK_UNSUPPORTED')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects symbolic links even in excluded subtrees', () => {
    const root = tree({ '契约/_校验/nested/placeholder.json': '{}' })
    try {
      symlinkSync(join(root, '契约'), join(root, '契约/_校验/nested/loop'))
      expect(() => readContracts(join(root, '契约'))).toThrow('KVVI_CONTRACT_SYMLINK_UNSUPPORTED')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('orders all tool paths globally like the CLI', () => {
    const root = tree({
      '契约/工具/a/child.json': '{"tool":"child"}',
      '契约/工具/a.json': '{"tool":"first"}',
    })
    try {
      expect(readContracts(join(root, '契约')).contracts['tool-spec'])
        .toEqual({ tools: [{ tool: 'first' }, { tool: 'child' }] })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('★ 整目录跳过的也要报出来：跳了哪个目录、里面几份', () => {
    // 从前这里是直接 `continue`：`06-工具/schemas/` 被整块丢掉，
    // 注记里一个字都没有 —— 而同一批里被丢下的那一张视图是逐条点了名的。
    // 同一类事情两种处理，搭建者就分不清「这个目录不重要」和「这个目录被吃了」。
    const root = tree({
      '契约/01-x-business-schema.json': '{}',
      '契约/06-工具/t1.json': '{"tool":"1"}',
      '契约/06-工具/schemas/request.json': '{}',
      '契约/06-工具/schemas/deep/response.json': '{}',
      '契约/_校验/结果/view-schema-副本.json': '{}',
    })
    try {
      const { notes } = readContracts(root)
      const schemas = notes.find(n => n.includes('整目录跳过') && n.includes('schemas'))
      expect(schemas).toBeDefined()
      expect(schemas).toContain('06-工具/schemas')
      // 只报「跳过了」不够 —— 搭建者要凭份数判断该不该在意，
      // 而这一条注记的全部用处就是这个判断。深层目录也要数进去。
      expect(schemas).toContain('2 个 .json')
      expect(notes.some(n => n.includes('整目录跳过') && n.includes('_校验'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺的那几份在 notes 里点名（调用方据此拒发）', () => {
    const root = tree({ '契约/01-x-business-schema.json': '{}' })
    try {
      const { contracts, notes } = readContracts(root)
      expect(Object.keys(contracts)).toEqual(['business-schema'])
      expect(notes.filter(n => n.startsWith('✗'))).toHaveLength(5)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('契约目录的边界', () => {
  it('rejects an existing symlink ancestor inside the workspace', () => {
    const root = tree({ 'outside/sub/view-schema.json': '{}' })
    try {
      mkdirSync(join(root, 'workspace'))
      symlinkSync(join(root, 'outside'), join(root, 'workspace/bridge'))
      expect(() => resolveContractsDir(agentWithCwd(join(root, 'workspace')), 'bridge/sub'))
        .toThrow('KVVI_CONTRACT_SYMLINK_UNSUPPORTED')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('缺省是 <工作区>/契约', () => {
    expect(resolveContractsDir(agentWithCwd('/tmp/ws'))).toBe('/tmp/ws/契约')
  })

  it('显式相对路径按工作区解析', () => {
    expect(resolveContractsDir(agentWithCwd('/tmp/ws'), '子目录/契约'))
      .toBe('/tmp/ws/子目录/契约')
  })

  it('★ 越出工作区 → 拒（这个工具有读文件的权限）', () => {
    expect(() => resolveContractsDir(agentWithCwd('/tmp/ws'), '../../etc'))
      .toThrow('KVVI_WORKSPACE_ESCAPE')
    expect(() => resolveContractsDir(agentWithCwd('/tmp/ws'), '/etc'))
      .toThrow('KVVI_WORKSPACE_ESCAPE')
  })

  it('会话没有工作区 → 拒，不回落到进程的 cwd', () => {
    expect(() => resolveContractsDir(agentWithCwd(undefined))).toThrow('KVVI_WORKSPACE_REQUIRED')
    expect(() => resolveContractsDir(agentWithCwd(''))).toThrow('KVVI_WORKSPACE_REQUIRED')
  })
})

describe('平台的拒绝原样带回', () => {
  const call = {
    mode: MODE, baseUrl: 'http://127.0.0.1:1', secret: SECRET,
  }

  it('平台自己的码优先，不编一个', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ error: 'KVVI_PUBLISH_CONTRACTS_INCOMPLETE', missing: ['view-schema'] }),
      { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

    const result = await request({ ...call, fetchImpl }, 'POST', '/publish/drafts', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('KVVI_PUBLISH_CONTRACTS_INCOMPLETE')
    expect(refusalMessage(result)).toContain('view-schema')
  })

  it('连不上平台 → 一个可搜索的传输码，不是抛异常', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const result = await request({ ...call, fetchImpl }, 'POST', '/publish/drafts', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('KVVI_PLATFORM_UNREACHABLE')
  })

  it('网关回的 HTML 502 不会被读成一次格式良好的拒绝', async () => {
    const fetchImpl = (async () => new Response('<html>502</html>',
      { status: 502 })) as unknown as typeof fetch
    const result = await request({ ...call, fetchImpl }, 'POST', '/publish/drafts', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('KVVI_HTTP_502')
  })
})

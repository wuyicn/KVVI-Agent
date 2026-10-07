import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Business from '../src/index.ts'
import { contextHeaders } from '../src/client.ts'

const MODE = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  companyId: '33333333-3333-4333-8333-333333333333', gateway: 'USER' as const,
}
const SECRET = 'isolated-test-context-secret'
const RECORD = {
  recordId: 'record-one', recordNo: 'R-20261006-000001', state: 'not_followed', rowVersion: 7,
  data: { customer_name: '测试客户', contact_name: '测试联系人', follow_status: 'not_followed' },
  fieldVisibility: { customer_name: 'VISIBLE', contact_name: 'READONLY', follow_status: 'VISIBLE' },
}
const { fieldVisibility, ...ROW } = RECORD
const FIELDS = {
  assetId: 'customer', hiddenFieldCount: 1,
  fields: [{ field_code: 'follow_status', label: '跟进状态', type: 'enum', required: true,
    nullable: false, write_policy: 'editable',
    options: [{ code: 'not_followed', label: '未跟进' }] }],
}

// The signed session is an external input. The real Loader, tool registry,
// HTTP client, schema validation and rendered result remain in the path.
class TestMode extends Service {
  constructor(ctx: Context) { super(ctx, 'kvviModeRouter') }
  requireMode() { return MODE }
}

let ctx: Context | undefined
let root: string | undefined
let server: ReturnType<typeof createServer> | undefined
let routeResponse: ((path: string) => unknown) | undefined
let holdResponse = false
let response: unknown
let status = 200
const requests: { method: string | undefined; url: string | undefined; body: string; signed: boolean }[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()))
  }
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  requests.length = 0
  status = 200
  routeResponse = undefined
  holdResponse = false
})

async function boot() {
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const expected = contextHeaders(MODE, SECRET, Number(req.headers['x-kvvi-issued-at']))
    const signed = Object.entries(expected).every(([key, value]) => req.headers[key] === value)
    requests.push({ method: req.method, url: req.url, body, signed })
    if (holdResponse) return
    res.writeHead(signed ? status : 401, { 'content-type': 'application/json' })
    res.end(JSON.stringify(signed ? (routeResponse?.(req.url ?? '') ?? response) : { error: 'KVVI_TEST_BAD_SIGNATURE' }))
  })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing test server port')
  root = await mkdtemp(join(tmpdir(), 'kvvi-business-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: 'test-signed-mode'",
    "- name: '@deepseek-ai/dsh-tool-kvvi-business'",
    '  config:', `    platformUrl: http://127.0.0.1:${String(address.port)}`,
    `    contextSecret: ${SECRET}`, '',
  ].join('\n'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['test-signed-mode', TestMode], ['@deepseek-ai/dsh-tool-kvvi-business', Business],
  ])
  ctx.loader.internal = {
    version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

async function execute(name: string, args: Record<string, unknown>) {
  if (ctx === undefined) throw new Error('test context not booted')
  return ctx.tools.execute({ name, arguments: args, callId: ToolCallId(name), signal: new AbortController().signal })
}

describe('employee tools through real Loader and signed platform transport', () => {
  it.each([
    ['record_schema', { system: 'customer' }, FIELDS, '/systems/customer/fields', 'GET'],
    ['record_list', { system: 'customer' }, { items: [ROW], fieldVisibility }, '/systems/customer/records', 'GET'],
    ['record_get', { system: 'customer', id: RECORD.recordNo }, RECORD, `/systems/customer/records/${RECORD.recordNo}`, 'GET'],
    ['record_create', { system: 'customer', data: { customer_name: '测试客户' } }, { recordId: RECORD.recordId, recordNo: RECORD.recordNo, rowVersion: 1 }, '/systems/customer/records', 'POST'],
    ['record_update', { system: 'customer', id: RECORD.recordNo, data: { contact_name: '新联系人' }, rowVersion: 7 }, { recordId: RECORD.recordId, rowVersion: 8 }, `/systems/customer/records/${RECORD.recordNo}`, 'PATCH'],
    ['workflow_available_actions', { system: 'customer', id: RECORD.recordNo }, { recordId: RECORD.recordId, state: 'not_followed', actions: [{ action: 'follow', to: 'followed' }] }, `/systems/customer/records/${RECORD.recordNo}/actions`, 'GET'],
    ['workflow_act', { system: 'customer', id: RECORD.recordNo, action: 'follow', rowVersion: 7 }, { recordId: RECORD.recordId, from: 'not_followed', state: 'followed', rowVersion: 8 }, `/systems/customer/records/${RECORD.recordNo}/transitions`, 'POST'],
  ] as const)('%s sends complete authorized values to the model, in one request', async (name, args, value, path, method) => {
    response = value
    await boot()
    const result = await execute(name, args)
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    expect(requests).toMatchObject([{ url: `/api/v1${path}`, method, signed: true }])
    expect(requests).toHaveLength(1)
    if ('rowVersion' in args) expect(JSON.parse(requests[0]?.body ?? '{}').rowVersion).toBe(7)
  })

  it.each(['record_get', 'record_list'])('%s excludes hidden field names from canonical and model-visible results', async (name) => {
    const visibility = { ...fieldVisibility, phone: 'MASKED' }
    const row = { ...ROW, data: { ...ROW.data, phone: '***' } }
    const expected = name === 'record_get'
      ? { ...row, fieldVisibility: visibility }
      : { items: [row], fieldVisibility: visibility }
    response = { ...expected, fieldVisibility: { ...visibility, secret_salary: 'HIDDEN' } }
    await boot()
    const result = await execute(name, { system: 'customer', ...(name === 'record_get' ? { id: RECORD.recordNo } : {}) })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value).toEqual(expected)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(expected) }])
    expect(JSON.stringify(result)).not.toContain('secret_salary')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.signed).toBe(true)
  })

  it('preloads the exact published workspace system and visible rules before the model request', async () => {
    routeResponse = path => path.endsWith('/systems')
      ? { items: [{ assetId: 'customer', name: '客户登记系统', internalSecret: 'not-for-model' }] } : FIELDS
    const loaded = await boot()
    const input = { agent: { session: { header: { cwd: '/employee/客户登记系统' } } } } as unknown as Parameters<typeof loaded.systemPrompt.assemble>[0]
    const assembly = await loaded.systemPrompt.assemble(input)
    const text = JSON.stringify(assembly.contexts)
    expect(text).toContain('客户登记系统')
    expect(text).toContain('customer')
    expect(text).toContain('跟进状态')
    expect(text).toContain('not_followed')
    expect(text).not.toContain('not-for-model')
    expect(requests.map(req => req.url)).toEqual(['/api/v1/systems', '/api/v1/systems/customer/fields'])
    expect(requests.every(req => req.signed)).toBe(true)
    expect(text).not.toContain('record-one')
    requests.length = 0
    const entry = [...loaded.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-tool-kvvi-business')
    await entry?.fiber?.dispose()
    expect(JSON.stringify((await loaded.systemPrompt.assemble(input)).contexts)).not.toContain('客户登记系统')
    expect(requests).toEqual([])
  })

  it('refreshes published rules and reports a later refusal without reusing stale rules', async () => {
    routeResponse = path => path.endsWith('/systems') ? { items: [{ assetId: 'customer', name: '客户登记系统' }] } : response
    response = FIELDS
    const loaded = await boot()
    const input = { agent: { session: { header: { cwd: '/employee/客户登记系统' } } } } as unknown as Parameters<typeof loaded.systemPrompt.assemble>[0]
    expect(JSON.stringify((await loaded.systemPrompt.assemble(input)).contexts)).toContain('跟进状态')
    response = { ...FIELDS, fields: [{ field_code: 'nickname', label: '客户简称', required: false, nullable: true }] }
    const updated = JSON.stringify((await loaded.systemPrompt.assemble(input)).contexts)
    expect(updated).toContain('客户简称')
    expect(updated).not.toContain('跟进状态')
    status = 403; response = { error: 'KVVI_NOT_ALLOWED' }; routeResponse = undefined
    const denied = JSON.stringify((await loaded.systemPrompt.assemble(input)).contexts)
    expect(denied).toContain('KVVI_NOT_ALLOWED')
    expect(denied).not.toContain('客户简称')
  })

  it('does not present malformed fields as current business rules', async () => {
    routeResponse = path => path.endsWith('/systems')
      ? { items: [{ assetId: 'customer', name: '客户登记系统' }] }
      : { ...FIELDS, fields: [{ field_code: 'bad', label: '错误规则', required: 'yes', nullable: false }] }
    const loaded = await boot()
    const input = { agent: { session: { header: { cwd: '/employee/客户登记系统' } } } } as unknown as Parameters<typeof loaded.systemPrompt.assemble>[0]
    const text = JSON.stringify((await loaded.systemPrompt.assemble(input)).contexts)
    expect(text).toContain('暂时不可用')
    expect(text).not.toContain('错误规则')
  })

  it('bounds unavailable background preparation without blocking the model indefinitely', async () => {
    holdResponse = true
    const loaded = await boot()
    const input = { agent: { session: { header: { cwd: '/employee/客户登记系统' } } } } as unknown as Parameters<typeof loaded.systemPrompt.assemble>[0]
    const start = performance.now()
    expect(JSON.stringify((await loaded.systemPrompt.assemble(input)).contexts)).toContain('暂时不可用')
    expect(performance.now() - start).toBeLessThan(3500)
    expect(requests).toHaveLength(1)
  })

  it('cancels background preparation with its owning turn', async () => {
    holdResponse = true
    const loaded = await boot()
    const controller = new AbortController()
    const input = { signal: controller.signal, agent: { session: { header: { cwd: '/employee/客户登记系统' } } } } as unknown as Parameters<typeof loaded.systemPrompt.assemble>[0]
    const pending = loaded.systemPrompt.assemble(input)
    const timer = setTimeout(() => { controller.abort(new Error('turn cancelled')) }, 50)
    try { await expect(pending).rejects.toThrow('turn cancelled') } finally { clearTimeout(timer) }
  })

  it('resolves an explicit workspace hint against the signed published catalogue', async () => {
    response = { items: [{ assetId: 'customer', name: 'customer' }] }
    routeResponse = path => path.endsWith('/systems') ? response : FIELDS
    const loaded = await boot()
    const cwd = join(root!, '客户登记系统')
    await mkdir(cwd)
    await writeFile(join(cwd, '.kvvi-system.json'), JSON.stringify({ assetId: 'customer' }))
    const input = { agent: { session: { header: { cwd } } } } as unknown as Parameters<typeof loaded.systemPrompt.assemble>[0]
    expect(JSON.stringify((await loaded.systemPrompt.assemble(input)).contexts)).toContain('跟进状态')
    response = { items: [{ assetId: 'other', name: 'other' }] }
    expect(JSON.stringify((await loaded.systemPrompt.assemble(input)).contexts)).not.toContain('跟进状态')
  })

  it('does not guess an unknown or ambiguous workspace system', async () => {
    response = { items: [{ assetId: 'one', name: '客户登记系统' }, { assetId: 'two', name: '客户登记系统' }] }
    const loaded = await boot()
    const assemble = (cwd: string) => loaded.systemPrompt.assemble(
      { agent: { session: { header: { cwd } } } } as unknown as Parameters<typeof loaded.systemPrompt.assemble>[0],
    )
    expect(JSON.stringify((await assemble('/employee/客户登记系统')).contexts)).not.toContain('field_code')
    response = { items: [{ assetId: 'one', name: '另外的系统' }] }
    expect(JSON.stringify((await assemble('/employee/unknown')).contexts)).not.toContain('field_code')
    expect(requests.map(req => req.url)).toEqual(['/api/v1/systems', '/api/v1/systems'])
    requests.length = 0
    await loaded.systemPrompt.assemble()
    expect(requests).toEqual([])
  })

  it('resolves company system names without exposing publication metadata or claiming read access', async () => {
    response = { companyId: MODE.companyId, items: [
      { assetId: 'customer', name: '客户登记系统', systemId: 'internal-id', schemaCode: 'schema-x', publishedAt: 'today' },
    ] }
    await boot()
    const result = await execute('system_list', {})
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ items: [{ assetId: 'customer', name: '客户登记系统' }] }) }])
    expect(requests).toMatchObject([{ method: 'GET', url: '/api/v1/systems', signed: true }])
    expect(requests).toHaveLength(1)
    status = 403
    response = { error: 'KVVI_NOT_ALLOWED' }
    const denied = await execute('record_get', { system: 'customer', id: RECORD.recordNo })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('KVVI_NOT_ALLOWED')
    expect(JSON.stringify(denied.content)).not.toContain('测试客户')
  })

  it.each(['KVVI_NOT_ALLOWED', 'KVVI_ROW_VERSION_CONFLICT', 'KVVI_RECORD_NOT_FOUND'])('preserves %s without retrying or reporting success', async (error) => {
    response = { error }; status = 403
    await boot()
    const result = await execute('record_get', { system: 'customer', id: RECORD.recordNo })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(error)
    expect(requests).toHaveLength(1)
  })

  it('rejects nested identity injection before it reaches the platform', async () => {
    response = {}
    await boot()
    const result = await execute('record_update', { system: 'customer', id: RECORD.recordNo, rowVersion: 7, data: { nested: { tenant: 'other-company' } } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('KVVI_IDENTITY_FIELD_FORBIDDEN')
    expect(requests).toEqual([])
  })

  it('unregisters the closed business tool set when the Loader plugin is disposed', async () => {
    response = {}
    const loaded = await boot()
    expect(loaded.tools.schemas().map(tool => tool.name).sort()).toEqual([
      'record_create', 'record_get', 'record_list', 'record_schema', 'record_update',
      'system_list', 'workflow_act', 'workflow_available_actions',
    ])
    const entry = [...loaded.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-tool-kvvi-business')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    expect(loaded.tools.schemas()).toEqual([])
  })
})

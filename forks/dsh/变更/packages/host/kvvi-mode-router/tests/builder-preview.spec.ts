import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { KvviModeRouter, signModeHeaders } from '../src/index.ts'
import { managedBusinessDirectory } from '../src/business-directory.ts'
import { readManagedDraft } from '../src/builder-preview.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const mode = { companyId: 'a0000000-0000-4000-8000-000000000001', userId: 'a0000000-0000-4000-8000-000000000002', gateway: 'BUILDER' as const }
const intent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const paths = ['契约/01-业务模型/business-schema.json', '契约/02-登记表单/view-schema.json',
  '契约/03-经营状态/workflow-spec.json', '契约/04-使用权限/permission-spec.json',
  '契约/05-工具/tool-spec.json', '契约/06-搭建命令/app-model-command.json']
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'kvvi-preview-test-')); roots.push(home)
  const dir = managedBusinessDirectory(home, mode, intent)
  const model = { schema_code: 'shop', name: '店铺', fields: [
    { field_code: 'account', label: '店铺账号', type: 'short_text', required: true, constraints: { trim: true, min_length: 3, max_length: 60 } },
    { field_code: 'platform', label: '平台', type: 'single_select', required: true, type_config: { options: [{ code: 'taobao', label: '淘宝', enabled: true }] } },
  ], indexes: [{ index_code: 'unique_account', kind: 'UNIQUE', fields: ['account'] }] }
  const view = { view_code: 'shop_form', name: '店铺登记', view_type: 'FORM', businessSchemaRef: { asset_id: 'shop', scope_id: mode.companyId, scope_type: 'TENANT' }, componentsTree: [{ id: 'page', componentName: 'FormPage', children: [
    { id: 'account', componentName: 'ShortTextField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'account' } } },
    { id: 'platform', componentName: 'SingleSelectField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'platform' } } },
  ] }] }
  const contents = [model, view, { states: [] }, { roles: [], policies: [] }, {}, {}]
  await writeFile(join(dir, '.kvvi-system.json'), JSON.stringify({ assetId: 'shop' }))
  for (const [i, path] of paths.entries()) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), JSON.stringify(contents[i]))
  }
  return { home, dir, model, view }
}
it('reads a real owned draft without publishing, allocating directories or granting record access', async () => {
  const { home, dir } = await fixture()
  const before = await readdir(dir)
  const result = readManagedDraft(home, mode, intent)
  expect(result.model.fields).toHaveLength(2)
  expect(result.view.name).toBe('店铺登记')
  expect(result.uniqueRules).toEqual([['account']])
  expect(result.canSubmit).toBe(false)
  expect(result.validation).toBe('not_checked')
  expect(result).not.toHaveProperty('permissions')
  expect(await readdir(dir)).toEqual(before)
  expect(readManagedDraft(home, mode, intent).digest).toBe(result.digest)
  await writeFile(join(dir, paths[5]!), '{"changed":true}')
  expect(readManagedDraft(home, mode, intent).digest).not.toBe(result.digest)
})
it('refuses workers, other owners, traversal and missing drafts without creating storage', async () => {
  const { home } = await fixture()
  expect(() => readManagedDraft(home, { ...mode, gateway: 'USER' }, intent)).toThrow('KVVI_BUILDER_REQUIRED')
  expect(() => readManagedDraft(home, { ...mode, companyId: 'other' }, intent)).toThrow('KVVI_PREVIEW_UNAVAILABLE')
  expect(() => readManagedDraft(home, { ...mode, userId: 'other' }, intent)).toThrow('KVVI_PREVIEW_UNAVAILABLE')
  expect(() => readManagedDraft(home, mode, '../outside')).toThrow('KVVI_BUILD_INVALID')
  expect(await readdir(join(home, 'business-workspaces'))).toHaveLength(1)
})
it('refuses missing files, symlink files and directory escapes', async () => {
  const { home, dir } = await fixture()
  const path = join(dir, paths[0]!)
  await rm(path)
  expect(() => readManagedDraft(home, mode, intent)).toThrow('KVVI_PREVIEW_UNAVAILABLE')
  await symlink(join(dir, paths[1]!), path)
  expect(() => readManagedDraft(home, mode, intent)).toThrow('KVVI_PREVIEW_UNAVAILABLE')
  await rm(join(dir, '契约'), { recursive: true })
  await symlink(home, join(dir, '契约'))
  expect(() => readManagedDraft(home, mode, intent)).toThrow('KVVI_PREVIEW_UNAVAILABLE')
})
it('refuses a mismatched asset, foreign company, unsupported component or unbound field', async () => {
  const { home, dir, view } = await fixture()
  for (const changed of [
    { ...view, businessSchemaRef: { ...view.businessSchemaRef, asset_id: 'other' } },
    { ...view, businessSchemaRef: { ...view.businessSchemaRef, scope_id: 'other' } },
    { ...view, componentsTree: [{ id: 'x', componentName: 'ExecuteScript' }] },
    { ...view, componentsTree: [{ id: 'x', componentName: 'ShortTextField', props: { fieldBinding: { type: 'FieldRef', fieldRef: 'missing' } } }] },
  ]) {
    await writeFile(join(dir, paths[1]!), JSON.stringify(changed))
    expect(() => readManagedDraft(home, mode, intent)).toThrow('KVVI_PREVIEW_UNSUPPORTED')
  }
})
it('refuses unsupported system-managed fields rather than offering an editable preview', async () => {
  const { home, dir, model } = await fixture()
  await writeFile(join(dir, paths[0]!), JSON.stringify({ ...model, fields: model.fields.map(f => ({ ...f, write_policy: 'SYSTEM' })) }))
  expect(() => readManagedDraft(home, mode, intent)).toThrow('KVVI_PREVIEW_UNSUPPORTED')
})
it('refuses oversized content and preserves exact business text', async () => {
  const { home, dir, model } = await fixture()
  model.name = 'API 客户登记'
  await writeFile(join(dir, paths[0]!), JSON.stringify(model))
  expect(readManagedDraft(home, mode, intent).model.name).toBe('API 客户登记')
  await writeFile(join(dir, paths[0]!), ' '.repeat(262145))
  expect(() => readManagedDraft(home, mode, intent)).toThrow('KVVI_PREVIEW_UNAVAILABLE')
})
it('rejects a FIFO contract without blocking the runtime', async () => {
  const { home, dir } = await fixture()
  const path = join(dir, paths[0]!)
  await rm(path)
  expect(spawnSync('mkfifo', [path]).status).toBe(0)
  const moduleUrl = new URL('../src/builder-preview.ts', import.meta.url).href
  const source = `import { readManagedDraft } from ${JSON.stringify(moduleUrl)}; try { readManagedDraft(${JSON.stringify(home)}, ${JSON.stringify(mode)}, ${JSON.stringify(intent)}); process.exit(2) } catch (error) { if(error.message !== 'KVVI_PREVIEW_UNAVAILABLE') process.exit(3) }`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { timeout: 1500, encoding: 'utf8' })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
})
it('serves only authenticated builder GET requests through the registered runtime route', async () => {
  const { home } = await fixture()
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context(), secret = 'preview-route-test'
  ctx.provide('connection' as never, {} as never)
  ctx.provide('sessionController', {
    create: async (request: unknown) => request, list: async () => ({ items: [] }), search: async () => ({ items: [], hasMore: false }),
    control: async function* () { yield { type: 'baseline', value: { jobs: {}, projections: {} } } },
  } as never)
  ctx.provide('agentPresets', { select: async (_agent: unknown, requested: unknown) => requested,
    remoteExportList: async () => ({ presets: [], authorable: false, modeSelectionEnabled: false }) } as never)
  await ctx.plugin(KvviModeRouter, { secret })
  const identity = { ...mode, sessionId: 'a0000000-0000-4000-8000-000000000003' }
  const builder = signModeHeaders(identity, secret)
  async function request(headers: Record<string, string>, method = 'GET', id = intent) {
    let status = 0, body = '', responseHeaders: unknown
    const response = {
      writeHead: (s: number, h: unknown) => { status = s; responseHeaders = h; return response },
      end: (b: string) => { body = b; return response },
    }
    const next = vi.fn()
    await ctx.waterfall('connection/request', { headers, method, url: '/api/kvvi-builder-preview/' + id } as never, response as never, next)
    expect(next).not.toHaveBeenCalled()
    return { status, body: JSON.parse(body) as unknown, headers: responseHeaders }
  }
  try {
    expect(await request(builder)).toMatchObject({ status: 200, body: { intentId: intent, canSubmit: false }, headers: { 'cache-control': 'no-store' } })
    expect(await request({})).toMatchObject({ status: 401 })
    expect(await request({ ...builder, 'x-kvvi-user': 'tampered' })).toMatchObject({ status: 401 })
    expect(await request(signModeHeaders({ ...identity, gateway: 'USER' }, secret))).toMatchObject({ status: 403 })
    expect(await request(builder, 'POST')).toMatchObject({ status: 405 })
    expect(await request(builder, 'GET', '..%2Foutside')).toMatchObject({ status: 400 })
    expect(await request(signModeHeaders({ ...identity, userId: 'a0000000-0000-4000-8000-000000000004' }, secret))).toMatchObject({ status: 422 })
  } finally { await ctx.fiber.dispose() }
})

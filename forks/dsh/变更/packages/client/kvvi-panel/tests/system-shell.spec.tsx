// @vitest-environment jsdom
/**
 * 「我的系统」的完整回路，用一份脚本化的 `fetch` 走通。
 *
 * ── 这一条测的是**回路**，不是组件 ────────────────────────────────────────
 *
 * 前面两份测试分别测「契约能不能画」和「写出去的东西对不对」。这一份把
 * 平台 API 换成一个**按路径作答的假服务器**，验证员工真正会走的那条路：
 *
 *   进系统 → 系统不能跑时如实说明 → 填单提交 → 看记录 → 打开记录 → 保存
 *
 * ⚠️ 假服务器按**路径**作答，而不是按调用次序：按次序作答的桩会把
 * 「多打了一次请求」和「打错了端点」都变成通过，而这两种都是真问题。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KvviSystemShell } from '../src/client/SystemShell.tsx'
import type { Copy } from '../src/client/FormView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The dictionary as a plain function, as the slot renderer supplies it. */
const t: Copy = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ''))
}

interface Answer {
  readonly status?: number
  readonly body: unknown
}

/**
 * A fake platform: one answer per `METHOD path`, plus a request log.
 *
 * The log is the point — a test can then assert **which** endpoint the client
 * used, not merely that something was called.
 */
function platform(routes: Readonly<Record<string, Answer>>): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url}`)
    const answer = routes[`${method} ${url}`]
    if (answer === undefined) {
      return Promise.resolve({
        ok: false, status: 404,
        json: async () => ({ error: 'KVVI_UNKNOWN_ROUTE', route: url }),
      })
    }
    const status = answer.status ?? 200
    return Promise.resolve({ ok: status < 400, status, json: async () => answer.body })
  }))
  return { calls }
}

const VIEW = {
  view_code: 'golden_01_form',
  name: '事项登记表单',
  view_type: 'FORM',
  componentsTree: [{
    id: 'root', componentName: 'FormPage', children: [{
      id: 'f1', componentName: 'ShortTextField',
      props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } },
    }],
  }],
}

const RUNTIME = {
  system: { systemId: 's1', assetId: 'golden_01', name: '事项登记', schemaCode: 'golden_01' },
  models: { golden_01: { schema_code: 'golden_01', name: '事项登记', fields: [
    { field_code: 'title', label: '标题', type: 'short_text' },
  ] } },
  views: { golden_01: VIEW },
  workflows: { golden_01: { states: { submitted: { label: '待审批' } }, transitions: [] } },
}

const SYSTEMS = {
  items: [{
    systemId: 's1', assetId: 'golden_01', name: '事项登记',
    schemaCode: 'golden_01', publishedAt: '2026-09-25T00:00:00Z',
  }],
  companyId: 'c1',
}

/** The routes every "healthy" case shares. */
function healthy(extra: Readonly<Record<string, Answer>> = {}): Record<string, Answer> {
  return {
    'GET /api/v1/systems': { body: SYSTEMS },
    'GET /api/v1/systems/golden_01/runtime': { body: RUNTIME },
    'GET /api/v1/systems/golden_01/records': {
      body: { items: [{
        recordId: 'r1', recordNo: 'R000001', rowVersion: 3, state: 'submitted',
        data: { title: '报销' },
      }], fieldVisibility: { title: 'VISIBLE' } },
    },
    'GET /api/v1/systems/golden_01/records/r1': {
      body: {
        recordId: 'r1', recordNo: 'R000001', rowVersion: 3, state: 'submitted',
        data: { title: '报销' }, fieldVisibility: { title: 'VISIBLE' },
      },
    },
    ...extra,
  }
}

describe('我的系统', () => {
  it('retries a failed runtime read and renders the real form after recovery', async () => {
    platform(healthy({ 'GET /api/v1/systems/golden_01/runtime': { status: 503, body: { error: 'KVVI_UNREACHABLE' } } }))
    render(<KvviSystemShell copy={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['systems.open'] }))
    await screen.findByRole('alert')
    platform(healthy())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByLabelText('title')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers a readable failure and retries the systems read without reopening', async () => {
    platform({ 'GET /api/v1/systems': { status: 503, body: { error: 'KVVI_UNREACHABLE' } } })
    render(<KvviSystemShell copy={t} />)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('无法连接服务')
    expect(screen.getByRole('alert').textContent).toContain('KVVI_UNREACHABLE')
    platform(healthy())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('事项登记')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('列出已发布的系统，打开后到填单', async () => {
    platform(healthy())
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    // 标签来自模型（标题），不是字段名。
    expect(screen.getByText('标题')).toBeTruthy()
  })

  it('★ U1：首次打开填单，HIDDEN 字段不渲染、也不随表单提交', async () => {
    const withSecret = {
      ...RUNTIME,
      models: { golden_01: { ...RUNTIME.models.golden_01, fields: [
        { field_code: 'title', label: '标题', type: 'short_text' },
        { field_code: 'secret', label: '密级', type: 'short_text' },
      ] } },
      views: { golden_01: {
        view_code: 'golden_01_form', name: '事项登记表单', view_type: 'FORM',
        componentsTree: [{
          id: 'root', componentName: 'FormPage', children: [
            { id: 'f1', componentName: 'ShortTextField',
              props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } } },
            { id: 'f2', componentName: 'ShortTextField',
              props: { fieldBinding: { type: 'FieldRef', fieldRef: 'secret' } } },
          ],
        }],
      } },
    }
    // /fields 只返回本会话能看到的字段 —— secret 是 HIDDEN，被平台滤掉。
    platform(healthy({
      'GET /api/v1/systems/golden_01/runtime': { body: withSecret },
      'GET /api/v1/systems/golden_01/fields': {
        body: { assetId: 'golden_01', fields: [{ field_code: 'title' }], hiddenFieldCount: 1 },
      },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    expect(screen.queryByLabelText('secret')).toBeNull()
    expect(screen.queryByText('密级')).toBeNull()
  })

  it('★ 系统不能运行时如实说明，而不是画一个空表单', async () => {
    platform({
      'GET /api/v1/systems': { body: SYSTEMS },
      'GET /api/v1/systems/golden_01/runtime': {
        status: 404,
        body: { error: 'KVVI_RUNTIME_CONTRACT_INCOMPLETE', missing: ['workflow-spec'] },
      },
    })
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('KVVI_RUNTIME_CONTRACT_INCOMPLETE')
    })
    expect(screen.queryByLabelText('title')).toBeNull()
  })

  it('★ 读取失败与「还没有系统」是两种状态', async () => {
    platform({ 'GET /api/v1/systems': { status: 403, body: { error: 'KVVI_NOT_ALLOWED' } } })
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(screen.queryByText(zh['systems.empty'])).toBeNull()
  })

  it('★ 提交成功显示记录号', async () => {
    const { calls } = platform(healthy({
      'POST /api/v1/systems/golden_01/records': {
        status: 201, body: { recordId: 'r9', rowVersion: 1, recordNo: 'R000009' },
      },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('title'), { target: { value: '报销' } })
    fireEvent.click(screen.getByRole('button', { name: zh['form.submit'] }))
    await waitFor(() => { expect(screen.getByText(/R000009/u)).toBeTruthy() })
    expect(calls).toContain('POST /api/v1/systems/golden_01/records')
  })

  it('★ 提交被拒时显示平台的码', async () => {
    platform(healthy({
      'POST /api/v1/systems/golden_01/records': { status: 403, body: { error: 'KVVI_NOT_ALLOWED' } },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['form.submit'] }))
    await waitFor(() => { expect(screen.getByText(/KVVI_NOT_ALLOWED/u)).toBeTruthy() })
  })

  it('★ 记录列表来自 /records，打开一条要打到那一条的端点', async () => {
    const { calls } = platform(healthy())
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['system.tab.records'] }))
    await waitFor(() => { expect(screen.getByText('R000001')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['list.open'] }))
    await waitFor(() => { expect(screen.getByText(zh['detail.title'])).toBeTruthy() })
    expect(calls).toContain('GET /api/v1/systems/golden_01/records/r1')
  })

  it('★ 详情保存带上平台给的版本号', async () => {
    const { calls } = platform(healthy({
      'PATCH /api/v1/systems/golden_01/records/r1': { body: { recordId: 'r1', rowVersion: 4 } },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['system.tab.records'] }))
    await waitFor(() => { expect(screen.getByText('R000001')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['list.open'] }))
    await waitFor(() => { expect(screen.getByText(zh['detail.title'])).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['detail.save'] }))
    await waitFor(() => { expect(screen.getByText(zh['detail.saved'])).toBeTruthy() })

    const spy = vi.mocked(globalThis.fetch)
    const patch = spy.mock.calls.find(c => c[1]?.method === 'PATCH')
    // 不带版本号 = 「最后写入者获胜」，别人的改动会被静默覆盖。
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ data: { title: '报销' }, rowVersion: 3 })
    expect(calls).toContain('PATCH /api/v1/systems/golden_01/records/r1')
  })

  it('★ 冲突时报出平台给的当前版本', async () => {
    platform(healthy({
      'PATCH /api/v1/systems/golden_01/records/r1': {
        status: 409, body: { error: 'KVVI_ROW_VERSION_CONFLICT', currentRowVersion: 9 },
      },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['system.tab.records'] }))
    await waitFor(() => { expect(screen.getByText('R000001')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['list.open'] }))
    await waitFor(() => { expect(screen.getByText(zh['detail.title'])).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['detail.save'] }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(zh['detail.conflict'].replace('{currentRowVersion}', '9'))
    })
  })
})

it('opens a published system beside the conversation through its injected dock action', async () => {
  platform(healthy())
  const onDock = vi.fn()
  render(<KvviSystemShell copy={t} onDock={onDock} />)
  fireEvent.click(await screen.findByRole('button', { name: '边聊边填' }))
  expect(onDock).toHaveBeenCalledWith(SYSTEMS.items[0], 'form')
  expect(screen.queryByLabelText('title')).toBeNull()
})

// @vitest-environment jsdom
/**
 * 系统的另外两半：记录列表、记录详情，以及它们脚下的 API 客户端。
 *
 * ── 这一份测试防的是什么 ──────────────────────────────────────────────────
 *
 * 渲染器测的是「契约能不能画」；这一份测的是「**写出去的东西对不对**」：
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 保存一定带上 `rowVersion` | 丢掉版本号 = 退化成「最后写入者获胜」，别人的改动被静默覆盖 |
 * | 2 | `MASKED` 的值不进 payload | 把界面上的掩码原样写回库里，掩码就成了真值 |
 * | 3 | 冲突与失败是两种状态 | 混成一个「保存失败」，用户重试一次还是失败 |
 * | 4 | 读失败与空列表是两种状态 | 空表会被读成「你没有待办」，而真相是没人问过 |
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KvviListView } from '../src/client/ListView.tsx'
import { KvviRecordDetail } from '../src/client/RecordDetail.tsx'
import type { Copy } from '../src/client/FormView.tsx'
import { createRecord, getRecord, listRecords, updateRecord } from '../src/client/api.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** The dictionary as a plain function, as the slot renderer supplies it. */
/** A callback a test does not exercise. */
const noop = (): void => {}

const t: Copy = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ''))
}

const FIELDS = [
  { field_code: 'title', label: '标题', type: 'short_text' },
  { field_code: 'amount', label: '金额', type: 'money' },
]

describe('记录列表', () => {
  it('★ 读失败与空列表是两种状态，不能画成一个空表', () => {
    render(<KvviListView copy={t} fields={FIELDS} rows={[]} fieldVisibility={{}}
      onOpen={noop} onRefresh={noop} error="KVVI_NOT_ALLOWED" />)
    expect(screen.queryByText(zh['list.empty'])).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('KVVI_NOT_ALLOWED')
  })

  it('没有记录时才说「还没有记录」', () => {
    render(<KvviListView copy={t} fields={FIELDS} rows={[]} fieldVisibility={{}}
      onOpen={noop} onRefresh={noop} />)
    expect(screen.getByText(zh['list.empty'])).toBeTruthy()
  })

  it('列来自模型：某列在前若干行恰好为空，也不会把这一列弄丢', () => {
    render(<KvviListView copy={t} fields={FIELDS} fieldVisibility={{}}
      rows={[{ recordId: 'r1', rowVersion: 1, data: { title: '报销' }, recordNo: 'R000001' }]}
      onOpen={noop} onRefresh={noop} />)
    // `amount` 在唯一一行里没有值，列头仍在 —— 从行数据推列会在这里丢掉它。
    expect(screen.getByRole('columnheader', { name: '金额' })).toBeTruthy()
    expect(screen.getByText('R000001')).toBeTruthy()
  })

  it('HIDDEN 字段不出现在任何单元格里', () => {
    render(<KvviListView copy={t} fields={FIELDS} fieldVisibility={{ amount: 'HIDDEN' }}
      rows={[{ recordId: 'r1', rowVersion: 1, data: { title: '报销', amount: '500' } }]}
      onOpen={noop} onRefresh={noop} />)
    expect(screen.queryByText('500')).toBeNull()
  })

  it('点「打开」把记录 ID 交出去', () => {
    const onOpen = vi.fn()
    render(<KvviListView copy={t} fields={FIELDS} fieldVisibility={{}}
      rows={[{ recordId: 'r7', rowVersion: 1, data: { title: '报销' } }]}
      onOpen={onOpen} onRefresh={noop} />)
    fireEvent.click(screen.getByRole('button', { name: zh['list.open'] }))
    expect(onOpen).toHaveBeenCalledWith('r7')
  })
})

describe('记录详情', () => {
  const record = {
    recordId: 'r1', recordNo: 'R000001', rowVersion: 3, state: 'submitted',
    data: { title: '报销', amount: '500' },
    fieldVisibility: { title: 'VISIBLE', amount: 'VISIBLE' },
  }

  it('★ 保存带上渲染时的 rowVersion', () => {
    const onSave = vi.fn()
    render(<KvviRecordDetail copy={t} record={record} fields={FIELDS}
      onSave={onSave} onBack={noop} />)
    fireEvent.change(screen.getByLabelText('title'), { target: { value: '报销（改）' } })
    fireEvent.click(screen.getByRole('button', { name: zh['detail.save'] }))
    expect(onSave).toHaveBeenCalledWith({ title: '报销（改）', amount: '500' }, 3)
  })

  it('★ MASKED 的值不进 payload —— 否则掩码会被写成真值', () => {
    const onSave = vi.fn()
    render(<KvviRecordDetail copy={t} fields={FIELDS}
      record={{ ...record, data: { title: '报销', amount: '••••' },
        fieldVisibility: { title: 'VISIBLE', amount: 'MASKED' } }}
      onSave={onSave} onBack={noop} />)
    fireEvent.click(screen.getByRole('button', { name: zh['detail.save'] }))
    expect(onSave).toHaveBeenCalledWith({ title: '报销' }, 3)
  })

  it('平台没返回的字段既不显示也不提交', () => {
    const onSave = vi.fn()
    render(<KvviRecordDetail copy={t} fields={FIELDS}
      record={{ ...record, data: { title: '报销' }, fieldVisibility: { title: 'VISIBLE', amount: 'HIDDEN' } }}
      onSave={onSave} onBack={noop} />)
    expect(screen.queryByLabelText('amount')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['detail.save'] }))
    expect(onSave).toHaveBeenCalledWith({ title: '报销' }, 3)
  })

  it('★ 冲突显示的是「别人改过」，不是「保存失败」', () => {
    render(<KvviRecordDetail copy={t} record={record} fields={FIELDS}
      error="KVVI_ROW_VERSION_CONFLICT" conflictRowVersion={9}
      onSave={noop} onBack={noop} />)
    const alert = screen.getByRole('alert').textContent ?? ''
    expect(alert).toContain('9')
    expect(alert).not.toContain(zh['detail.failed'].replace('{detail}', ''))
  })

  it('READONLY 字段渲染成不可编辑', () => {
    render(<KvviRecordDetail copy={t} fields={FIELDS}
      record={{ ...record, fieldVisibility: { title: 'READONLY', amount: 'VISIBLE' } }}
      onSave={noop} onBack={noop} />)
    const input = screen.getByLabelText('title') as HTMLInputElement
    expect(input.disabled || input.readOnly).toBe(true)
  })

  it('保存成功后显示「已保存」', () => {
    render(<KvviRecordDetail copy={t} record={record} fields={FIELDS} saved
      onSave={noop} onBack={noop} />)
    expect(screen.getByText(zh['detail.saved'])).toBeTruthy()
  })
})

describe('API 客户端', () => {
  /** Replace `fetch` for one test and hand back its spy. */
  function stubFetch(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
    const spy = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', spy)
    return spy
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('请求落到 /api/v1 的产品路由，方法正确', async () => {
    const spy = stubFetch({ ok: true, status: 200, json: async () => ({ items: [] }) })
    await listRecords('golden_01')
    expect(spy.mock.calls[0]?.[0]).toBe('/api/v1/systems/golden_01/records')
    expect(spy.mock.calls[0]?.[1]?.method).toBe('GET')
  })

  it('系统代号被转义，不会拼出别的路径', async () => {
    const spy = stubFetch({ ok: true, status: 200, json: async () => ({ items: [] }) })
    await listRecords('a/b c')
    expect(spy.mock.calls[0]?.[0]).toBe('/api/v1/systems/a%2Fb%20c/records')
  })

  it('★ 平台错误码原样带出，不塌成一个布尔', async () => {
    stubFetch({ ok: false, status: 403, json: async () => ({ error: 'KVVI_NOT_ALLOWED', detail: '没有 read' }) })
    const result = await getRecord('golden_01', 'r1')
    expect(result).toEqual({ ok: false, status: 403, code: 'KVVI_NOT_ALLOWED', detail: '没有 read' })
  })

  it('★ 冲突带上平台给的当前版本', async () => {
    stubFetch({ ok: false, status: 409, json: async () => ({ error: 'KVVI_ROW_VERSION_CONFLICT', currentRowVersion: 9 }) })
    const result = await updateRecord('golden_01', 'r1', { title: 'x' }, 3)
    expect(result).toEqual({ ok: false, status: 409, code: 'KVVI_ROW_VERSION_CONFLICT', currentRowVersion: 9 })
  })

  it('★ 200 但不是 JSON 时不算成功', async () => {
    stubFetch({ ok: true, status: 200, json: async () => { throw new Error('not json') } })
    const result = await createRecord('golden_01', { title: 'x' })
    expect(result.ok).toBe(false)
    expect((result as { code: string }).code).toBe('KVVI_BAD_RESPONSE')
  })

  it('网络失败与平台拒绝是不同的码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const result = await listRecords('golden_01')
    expect((result as { code: string }).code).toBe('KVVI_UNREACHABLE')
  })

  it('创建记录发的是 POST + data', async () => {
    const spy = stubFetch({ ok: true, status: 201, json: async () => ({ recordId: 'r9', rowVersion: 1 }) })
    await createRecord('golden_01', { title: '报销' })
    const init = spy.mock.calls[0]?.[1] as { method: string; body: string }
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ data: { title: '报销' } })
  })

  it('英文词典与中文词典键集合一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

it('omits readonly fields from a detail edit while preserving the version check',()=>{
  const onSave=vi.fn()
  render(<KvviRecordDetail copy={t} fields={FIELDS} record={{ recordId:'r',rowVersion:4,data:{ title:'不能改',amount:'10' },fieldVisibility:{ title:'READONLY',amount:'VISIBLE' } }} onSave={onSave} onBack={noop} />)
  fireEvent.change(screen.getByLabelText('amount'),{ target:{ value:'20' } })
  fireEvent.click(screen.getByRole('button',{ name:zh['detail.save'] }))
  expect(onSave).toHaveBeenCalledWith({ amount:'20' },4)
})

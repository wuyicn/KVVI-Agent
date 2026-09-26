// @vitest-environment jsdom
/**
 * KVVI 已发布系统的**闭合渲染器**。
 *
 * ── 「闭合」是这一层的全部要点 ────────────────────────────────────────────
 *
 * 契约是**数据**，不是代码。渲染器只认一份**显式导入**的组件表；
 * 表里没有的组件名一律渲染成阻断错误，**不执行任何来自契约的东西**。
 *
 * 计划的 Review Focus 正是这一条：
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 未注册组件 → 阻断错误，且**什么都不画** | 契约里写一个 `RemoteScript` 就能让客户端加载远端脚本 |
 * | 2 | HIDDEN 字段**不渲染、也不提交** | 界面藏了字段、请求里却带着它 —— 藏了等于没藏 |
 * | 3 | READONLY 字段渲染成只读 | 用户改了、提交被拒，白填一次 |
 * | 4 | 组件用错视图类型 → 阻断 | 契约把 `SubmitButton` 放进 `DETAIL`，界面按自己的心情决定 |
 *
 * ⚠️ 第 2 条要**同时**验「不渲染」与「不提交」：
 * 只验前者的话，一个「渲染时跳过、提交时全带」的实现会通过 ——
 * 而它恰好把隐藏字段泄露了出去。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KvviFormView, fieldContextOf, problemsOf, visibleFields } from '../src/client/FormView.tsx'
import type { Copy } from '../src/client/FormView.tsx'
import { COMPONENT_REGISTRY, NOT_REGISTERED, WRONG_VIEW_TYPE } from '../src/client/registry.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * The dictionary as a plain function.
 *
 * These components are props consumers, so a test hands them copy the same way
 * the slot renderer does — no framework hooks, no locale service.
 */
/** A callback a test does not exercise. */
const noop = (): void => {}

const t: Copy = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ''))
}

/** A minimal view tree: one field, bound to the given component name. */
function view(componentName: string, field: string) {
  return {
    view_code: 'v1',
    name: '测试视图',
    view_type: 'FORM',
    componentsTree: [{
      id: 'f0',
      componentName,
      props: { fieldBinding: { type: 'FieldRef' as const, fieldRef: field } },
    }],
  }
}

/**
 * Render one field with the visibility the platform decided.
 *
 * `fieldVisibility` is **not** part of the view contract: the platform computes
 * it from the session and sends it beside the records, so a test hands it in
 * through the same context the panel builds.
 */
function renderField(
  componentName: string,
  field: string,
  mode: string,
  options: {
    readonly label?: string
    readonly onSubmit?: (data: Record<string, string>) => void
    readonly type?: string
    readonly options?: readonly { code: string; label?: string }[]
  } = {},
): void {
  render(<KvviFormView
    spec={view(componentName, field)}
    copy={t}
    context={fieldContextOf([{
      field_code: field,
      label: options.label ?? field,
      ...(options.type === undefined ? {} : { type: options.type }),
      ...(options.options === undefined ? {} : { type_config: { options: options.options } }),
    }], { [field]: mode })}
    {...(options.onSubmit === undefined ? {} : { onSubmit: options.onSubmit })}
  />)
}

describe('KVVI 已发布系统渲染器', () => {
  it('★ 未注册组件 → 阻断错误，且不渲染任何东西', () => {
    renderField('RemoteScript', 'reason', 'VISIBLE', { onSubmit: noop })
    // 错误码在**自己的元素**上，所以断言写得出来，排错时也能直接搜到。
    expect(screen.getByText(NOT_REGISTERED)).toBeTruthy()
    // 阻断意味着**什么都不画** —— 画一半再报错会让人以为界面坏了。
    expect(screen.queryByLabelText('reason')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText(t('form.submit'))).toBeNull()
  })

  it('★ 组件用错视图类型 → 阻断（判据与平台注册表一致）', () => {
    // `FormPage` 在契约注册表里只属于 FORM，这里放进 DETAIL。
    const spec = {
      ...view('ShortTextField', 'reason'),
      view_type: 'DETAIL',
      componentsTree: [{ id: 'root', componentName: 'FormPage', children: [] }],
    }
    render(<KvviFormView spec={spec} copy={t} />)
    expect(screen.getByText(WRONG_VIEW_TYPE)).toBeTruthy()
  })

  it('★ 表里没有的组件名，注册表就是唯一的判据', () => {
    // 这一条防的是「注册表被悄悄放宽」：表里 23 个名字全部来自平台注册表，
    // 多一个都意味着契约能画出产品没批过的东西。
    expect(Object.keys(COMPONENT_REGISTRY)).toHaveLength(23)
    expect(COMPONENT_REGISTRY.RemoteScript).toBeUndefined()
  })

  it('★ HIDDEN 字段不渲染', () => {
    renderField('ShortTextField', 'reason', 'HIDDEN')
    expect(screen.queryByLabelText('reason')).toBeNull()
    expect(visibleFields(view('ShortTextField', 'reason').componentsTree, { reason: 'HIDDEN' }))
      .toEqual([])
  })

  it('★ HIDDEN 字段**也不提交** —— 藏了但带走等于没藏', () => {
    const onSubmit = vi.fn()
    renderField('ShortTextField', 'reason', 'HIDDEN', { onSubmit })
    fireEvent.click(screen.getByRole('button', { name: zh['form.submit'] }))
    expect(onSubmit).toHaveBeenCalled()
    const data = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.keys(data)).not.toContain('reason')
  })

  it('VISIBLE 字段渲染并可提交', () => {
    const onSubmit = vi.fn()
    renderField('ShortTextField', 'reason', 'VISIBLE', { label: '事由', onSubmit })
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: '请假' } })
    fireEvent.click(screen.getByRole('button', { name: zh['form.submit'] }))
    expect((onSubmit.mock.calls[0]?.[0] as Record<string, unknown>).reason).toBe('请假')
    // 标签来自模型，不来自视图：视图改标签就成了第二份产品词表。
    expect(screen.getByText('事由')).toBeTruthy()
  })

  it('READONLY 字段渲染成只读', () => {
    renderField('ShortTextField', 'reason', 'READONLY')
    const input = screen.getByLabelText('reason') as HTMLInputElement
    expect(input.readOnly || input.disabled).toBe(true)
  })

  it('MASKED 字段同样渲染成只读', () => {
    renderField('MoneyField', 'amount', 'MASKED')
    const input = screen.getByLabelText('amount') as HTMLInputElement
    expect(input.readOnly || input.disabled).toBe(true)
  })

  it('单选的选项来自模型声明，不来自视图', () => {
    renderField('SingleSelectField', 'category', 'VISIBLE', {
      label: '分类', type: 'single_select', options: [{ code: 'draft', label: '草稿' }],
    })
    expect(screen.getByRole('option', { name: '草稿' })).toBeTruthy()
  })

  it('★ 需要查询端点的 Table 阻断，并报出真实原因', () => {
    const spec = {
      view_code: 'v2',
      name: '看板',
      view_type: 'LIST',
      componentsTree: [{
        id: 't1',
        componentName: 'Table',
        props: { data: { type: 'DataBindingRef', queryCode: 'q_monthly_sales' } },
      }],
    }
    expect(problemsOf(spec.componentsTree, 'LIST')).toEqual([{
      code: 'KVVI_TABLE_QUERY_UNSUPPORTED', componentName: 'Table', viewType: 'LIST',
      queryCode: 'q_monthly_sales',
    }])
    render(<KvviFormView spec={spec} copy={t} />)
    // 画一张空表就是在用「没有数据」冒充「没有数据源」。
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('KVVI_TABLE_QUERY_UNSUPPORTED')).toBeTruthy()
  })

  it('容器组件画标题与子节点', () => {
    const spec = {
      view_code: 'v3',
      name: '表单',
      view_type: 'FORM',
      componentsTree: [{
        id: 'root',
        componentName: 'FormPage',
        children: [{
          id: 's1',
          componentName: 'Section',
          props: { title: '事项信息' },
          children: [{
            id: 'f1',
            componentName: 'ShortTextField',
            props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } },
          }],
        }],
      }],
    }
    render(<KvviFormView spec={spec} copy={t} context={fieldContextOf([{ field_code: 'title', label: '标题' }])} />)
    expect(screen.getByText('事项信息')).toBeTruthy()
    expect(screen.getByLabelText('title')).toBeTruthy()
  })

  it('英文词典与中文词典键集合一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

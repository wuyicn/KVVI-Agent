// @vitest-environment jsdom
/**
 * 所有者管理界面。
 *
 * ── 这一组测的是「界面不许替服务端说话」──────────────────────────────────
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 员工看不到管理入口，但**接口仍然各自判定** | 「界面隐藏了按钮」被当成权限 |
 * | 2 | 被拒时显示**服务端给的码**，不显示乐观成功 | 先显示成功再回滚，用户以为改动生效过 |
 * | 3 | **停用是两步**：点一次只是进入确认态 | 一行一个按钮的表里点错位置，当场有人被踢下线 |
 * | 4 | 数据范围是**多选**（并集），不是档位单选 | 勾了「部门」就看不见自己的单据 |
 * | 5 | 平台保留角色不可编辑业务策略 | 「给 owner 勾上 COMPANY 就能管公司」的误解 |
 * | 6 | 维度/可见性的选项来自服务端，不在这里写死 | 服务端加一档而界面没有，那一档永远配不出来 |
 * | 7 | 保存的是**整体替换**的完整列表 | 漏掉未改动的一行等于把它删掉 |
 *
 * ⚠️ 第 7 条尤其重要：界面把「未改动的行」一起发出去才是对的。
 * 只发改动过的行，配上服务端「整体替换」的语义，会把其余策略静默删掉 ——
 * 而那是权限变小，不会报错。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KvviAdminShell, messageOf } from '../src/client/AdminShell.tsx'
import { PolicyEditor } from '../src/client/PolicyEditor.tsx'
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

const CAPABILITIES = {
  role: 'owner',
  canManageMembers: true,
  canManageRoles: true,
  canManagePlatformRoles: true,
  canManageBuilder: true,
  dimensions: ['FORM', 'FIELD', 'FLOW', 'DATA'],
  dataScopes: ['SELF', 'STORE', 'DEPARTMENT', 'DEPARTMENT_AND_CHILDREN', 'COMPANY'],
  fieldVisibilities: ['VISIBLE', 'MASKED', 'HIDDEN', 'READONLY'],
}

const BOB = 'a0000000-0000-4000-8000-0000000000a2'

function member(overrides: Record<string, unknown> = {}) {
  return {
    userId: BOB, login: 'bob', status: 'ACTIVE', deptId: null, deptName: null,
    shopId: null, roleCodes: [], builder: false, platformRole: null, ...overrides,
  }
}

interface Answer { readonly status?: number; readonly body: unknown }

/** 一个按 `METHOD path` 作答的假平台，带请求日志。 */
function platform(routes: Readonly<Record<string, Answer>>): { calls: { method: string; path: string; body: unknown }[] } {
  const calls: { method: string; path: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, path: url, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const answer = routes[`${method} ${url}`]
    if (answer === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'KVVI_UNKNOWN_ROUTE' }) })
    }
    const status = answer.status ?? 200
    return Promise.resolve({ ok: status < 400, status, json: async () => answer.body })
  }))
  return { calls }
}

/** 一份健康的假平台：能力表 + 一个成员 + 一个业务角色。 */
function healthy(extra: Readonly<Record<string, Answer>> = {}): Record<string, Answer> {
  return {
    'GET /api/v1/admin/capabilities': { body: CAPABILITIES },
    'GET /api/v1/admin/members': { body: { items: [member(), member({ userId: 'u2', login: 'carol', roleCodes: ['staff'] })] } },
    'GET /api/v1/admin/roles': { body: { items: [
      { roleCode: 'staff', name: '员工', memberCount: 1, reserved: false, policies: [
        { dimension: 'DATA', resourceCode: '*', actions: [], dataScopes: ['SELF'], fieldVisibility: null },
      ] },
      { roleCode: 'owner', name: '所有者', memberCount: 1, reserved: true, policies: [] },
    ] } },
    'GET /api/v1/admin/departments': { body: { items: [{ deptId: 'd1', parentId: null, name: '技术部' }] } },
    ...extra,
  }
}

describe('企业管理界面', () => {
  it('★ 员工看不到管理内容 —— 但这是清晰度，不是权限', async () => {
    platform({
      'GET /api/v1/admin/capabilities': { body: { ...CAPABILITIES, role: null,
        canManageMembers: false, canManageRoles: false,
        canManagePlatformRoles: false, canManageBuilder: false } },
    })
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText(zh['admin.noPermission'])).toBeTruthy() })
    // 一句「你不是管理员」比三个 403 更有用，所以列表请求**根本不该发出**。
    expect(screen.queryByText('bob')).toBeNull()
  })

  it('能力表读不到时说明原因，不画空表', async () => {
    platform({ 'GET /api/v1/admin/capabilities': { status: 403, body: { error: 'KVVI_NOT_A_PLATFORM_ADMIN' } } })
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('KVVI_NOT_A_PLATFORM_ADMIN') })
  })

  it('成员列表渲染登录名、状态、部门与角色', async () => {
    platform(healthy({ 'GET /api/v1/admin/members': { body: { items: [
      member({ deptName: '技术部', roleCodes: ['staff'], builder: true }),
    ] } } }))
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    // 收窄到这一行：部门名同时出现在新建账号的部门下拉里，
    // 全局 `getByText` 会撞上两个 —— 那是测试写窄了，不是界面重复渲染。
    const row = screen.getByText('bob').closest('tr') as HTMLTableRowElement
    expect(within(row).getByText('技术部')).toBeTruthy()
    expect(within(row).getByText('staff')).toBeTruthy()
    expect(within(row).getByText(zh['member.active'])).toBeTruthy()
  })

  it('★ 停用是两步：点一次只进入确认态，不发请求', async () => {
    const { calls } = platform(healthy())
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })

    const row = screen.getByText('bob').closest('tr') as HTMLTableRowElement
    fireEvent.click(within(row).getByRole('button', { name: zh['member.suspend'] }))

    // 确认态：按钮换了文案，但没有任何写请求发出去。
    expect(within(row).getByRole('button', { name: zh['member.confirmSuspend'] })).toBeTruthy()
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)

    // 再点一次才真的停用。
    fireEvent.click(within(row).getByRole('button', { name: zh['member.confirmSuspend'] }))
    await waitFor(() => {
      expect(calls.some(c => c.path === `/api/v1/admin/members/${BOB}/suspend`)).toBe(true)
    })
  })

  it('★ 服务端拒绝时显示**服务端的码**，不显示成功', async () => {
    platform(healthy({
      [`POST /api/v1/admin/members/${BOB}/suspend`]: { status: 403, body: { error: 'KVVI_SELF_GRANT_FORBIDDEN' } },
    }))
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    const row = screen.getByText('bob').closest('tr') as HTMLTableRowElement
    fireEvent.click(within(row).getByRole('button', { name: zh['member.suspend'] }))
    fireEvent.click(within(row).getByRole('button', { name: zh['member.confirmSuspend'] }))

    // §9.6.7 的码翻译成人话；未登记的码原样显示（见下一条）。
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(zh['member.selfTarget']) })
  })

  it('★ 未登记的拒绝码原样显示 —— 编一句人话会抹掉唯一的诊断线索', async () => {
    platform(healthy({
      [`POST /api/v1/admin/members/${BOB}/builder`]: { status: 409, body: { error: 'KVVI_SOMETHING_NEW' } },
    }))
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    const row = screen.getByText('bob').closest('tr') as HTMLTableRowElement
    fireEvent.click(within(row).getByRole('button', { name: zh['member.grantBuilder'] }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('KVVI_SOMETHING_NEW') })
  })

  it('★ 非所有者：搭建与管理员按钮禁用，但列表可看', async () => {
    platform({
      ...healthy(),
      'GET /api/v1/admin/capabilities': { body: { ...CAPABILITIES, role: 'admin',
        canManagePlatformRoles: false, canManageBuilder: false } },
    })
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    const row = screen.getByText('bob').closest('tr') as HTMLTableRowElement
    expect((within(row).getByRole('button', { name: zh['member.grantBuilder'] }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(row).getByRole('button', { name: zh['member.grantAdmin'] }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(zh['admin.readonly'])).toBeTruthy()
  })

  it('授权后刷新列表 —— 不靠本地猜测', async () => {
    const { calls } = platform(healthy({
      [`POST /api/v1/admin/members/${BOB}/builder`]: { body: { userId: BOB, builder: true, changed: true } },
    }))
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    const row = screen.getByText('bob').closest('tr') as HTMLTableRowElement
    fireEvent.click(within(row).getByRole('button', { name: zh['member.grantBuilder'] }))
    await waitFor(() => {
      // 写完之后要**重新读**：显示的成功与列表里的状态必须来自服务端。
      expect(calls.filter(c => c.method === 'GET' && c.path === '/api/v1/admin/members').length)
        .toBeGreaterThan(1)
    })
  })

  it('★ 平台保留角色不提供业务策略编辑', async () => {
    platform(healthy())
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['admin.tab.roles'] }))
    await waitFor(() => { expect(screen.getByText('所有者')).toBeTruthy() })
    // 角色页签里「员工」既是角色名；页签文案改成「成员」后这里不再有歧义。

    const reserved = screen.getByText('所有者').closest('li') as HTMLLIElement
    expect(within(reserved).queryByRole('button', { name: zh['role.editPolicies'] })).toBeNull()
    expect(within(reserved).getByText(zh['role.reservedNotice'])).toBeTruthy()

    const business = screen.getByText('员工').closest('li') as HTMLLIElement
    expect(within(business).getByRole('button', { name: zh['role.editPolicies'] })).toBeTruthy()
  })

  it('★ 保存发的是**完整**策略列表，不是只有改动过的那一行', async () => {
    const { calls } = platform(healthy({
      'PUT /api/v1/admin/roles/staff/policies': { body: { roleCode: 'staff', count: 2 } },
    }))
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['admin.tab.roles'] }))
    await waitFor(() => { expect(screen.getByText('员工')).toBeTruthy() })
    const row = screen.getByText('员工').closest('li') as HTMLLIElement
    fireEvent.click(within(row).getByRole('button', { name: zh['role.editPolicies'] }))
    fireEvent.click(within(row).getByRole('button', { name: zh['policy.add'] }))
    fireEvent.click(within(row).getByRole('button', { name: zh['policy.save'] }))

    await waitFor(() => {
      const put = calls.find(c => c.method === 'PUT')
      expect(put).toBeDefined()
      // 服务端是整体替换：只发改动过的一行会把另一行静默删掉 —— 而那是权限变小。
      expect((put?.body as { policies: unknown[] }).policies).toHaveLength(2)
    })
  })

  it('新建账号发出登录名与口令', async () => {
    const { calls } = platform(healthy({
      'POST /api/v1/admin/members': { status: 201, body: { userId: 'u9', login: 'dave' } },
    }))
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText(zh['member.loginPlaceholder']), { target: { value: 'dave' } })
    fireEvent.change(screen.getByLabelText(zh['member.passwordPlaceholder']), { target: { value: 'kvvi-dave-pass' } })
    fireEvent.click(screen.getByRole('button', { name: zh['member.create'] }))
    await waitFor(() => {
      const post = calls.find(c => c.method === 'POST' && c.path === '/api/v1/admin/members')
      expect(post?.body).toEqual({ login: 'dave', password: 'kvvi-dave-pass' })
    })
  })

  it('新建账号被拒（重名）→ 显示服务的码', async () => {
    platform(healthy({
      'POST /api/v1/admin/members': { status: 409, body: { error: 'KVVI_LOGIN_EXISTS' } },
    }))
    render(<KvviAdminShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('bob')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText(zh['member.loginPlaceholder']), { target: { value: 'dave' } })
    fireEvent.change(screen.getByLabelText(zh['member.passwordPlaceholder']), { target: { value: 'kvvi-dave-pass' } })
    fireEvent.click(screen.getByRole('button', { name: zh['member.create'] }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('KVVI_LOGIN_EXISTS') })
  })
})

describe('策略编辑器', () => {
  /** 直接渲染编辑器：它是个纯 props 组件，不必穿过整个管理页。 */
  function renderEditor(onSave: (policies: readonly unknown[]) => void, policies: readonly unknown[] = []) {
    return render(<PolicyEditor copy={t} roleCode="staff"
      policies={policies as never} capabilities={CAPABILITIES} busy={false}
      onSave={onSave as never} />)
  }

  it('★ 数据范围是**多选**（并集），不是档位单选', () => {
    renderEditor(vi.fn(), [{ dimension: 'DATA', resourceCode: '*', actions: [],
      dataScopes: ['SELF'], fieldVisibility: null }])
    // 五个复选框，而不是一个下拉 —— 单选下拉在语义上就错了：
    // 勾了「部门」的人会看不见自己的单据。
    for (const scope of CAPABILITIES.dataScopes) {
      expect(screen.getByLabelText(scope)).toBeTruthy()
    }
    expect(screen.getByLabelText('SELF')).toHaveProperty('checked', true)
    expect(screen.getByLabelText('COMPANY')).toHaveProperty('checked', false)
  })

  it('保存多档时原样带上多值', () => {
    const onSave = vi.fn()
    renderEditor(onSave, [{ dimension: 'DATA', resourceCode: '*', actions: [],
      dataScopes: ['SELF'], fieldVisibility: null }])
    fireEvent.click(screen.getByLabelText('COMPANY'))
    fireEvent.click(screen.getByRole('button', { name: zh['policy.save'] }))
    expect(onSave).toHaveBeenCalledWith([{
      dimension: 'DATA', resourceCode: '*', actions: [], dataScopes: ['SELF', 'COMPANY'],
      fieldVisibility: null,
    }])
  })

  it('★ 维度与可见性的选项来自服务端的能力表', () => {
    renderEditor(vi.fn())
    const dimension = screen.queryByLabelText(zh['policy.dimension'])
    // 空策略时还没有行，先加一行。
    expect(dimension).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['policy.add'] }))
    const select = screen.getByLabelText(zh['policy.dimension']) as HTMLSelectElement
    expect(Array.from(select.options).map(o => o.value)).toEqual(CAPABILITIES.dimensions)
  })

  it('★ 界面不认识的维度显示原始 code，而不是空白', () => {
    renderEditor(vi.fn(), [{ dimension: 'BRAND_NEW', resourceCode: '*', actions: [],
      dataScopes: [], fieldVisibility: null }])
    expect(screen.getByRole('option', { name: 'BRAND_NEW' })).toBeTruthy()
  })

  it('动作是逗号分隔的文本，去掉空白与空项', () => {
    const onSave = vi.fn()
    renderEditor(onSave, [{ dimension: 'FORM', resourceCode: '*', actions: ['read'],
      dataScopes: [], fieldVisibility: null }])
    fireEvent.change(screen.getByLabelText(zh['policy.actions']), { target: { value: ' read , create ,, ' } })
    fireEvent.click(screen.getByRole('button', { name: zh['policy.save'] }))
    expect((onSave.mock.calls[0]?.[0] as { actions: string[] }[])[0]?.actions)
      .toEqual(['read', 'create'])
  })

  it('只有 FIELD 维度带字段可见性；切回别的维度时它被丢掉', () => {
    const onSave = vi.fn()
    renderEditor(onSave, [{ dimension: 'FIELD', resourceCode: 'salary', actions: [],
      dataScopes: [], fieldVisibility: 'MASKED' }])
    expect(screen.getByLabelText(zh['policy.fieldVisibility'])).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh['policy.dimension']), { target: { value: 'FORM' } })
    fireEvent.click(screen.getByRole('button', { name: zh['policy.save'] }))
    expect((onSave.mock.calls[0]?.[0] as { fieldVisibility: unknown }[])[0]?.fieldVisibility).toBeNull()
  })

  it('可以删掉一行，保存的是删完之后的列表', () => {
    const onSave = vi.fn()
    renderEditor(onSave, [
      { dimension: 'FORM', resourceCode: 'a', actions: ['read'], dataScopes: [], fieldVisibility: null },
      { dimension: 'DATA', resourceCode: '*', actions: [], dataScopes: ['SELF'], fieldVisibility: null },
    ])
    fireEvent.click(screen.getAllByRole('button', { name: zh['policy.remove'] })[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: zh['policy.save'] }))
    expect(onSave).toHaveBeenCalledWith([
      { dimension: 'DATA', resourceCode: '*', actions: [], dataScopes: ['SELF'], fieldVisibility: null },
    ])
  })

  it('没有策略时显示空态与「并集」的说明', () => {
    renderEditor(vi.fn())
    expect(screen.getByText(zh['policy.empty'])).toBeTruthy()
    expect(screen.getByText(zh['policy.supersetWarning'])).toBeTruthy()
  })
})

describe('拒绝码的翻译', () => {
  it('自授权与最后所有者翻译成人话，其余原样带 detail', () => {
    expect(messageOf('KVVI_SELF_GRANT_FORBIDDEN', undefined, t)).toBe(zh['member.selfTarget'])
    expect(messageOf('KVVI_LAST_OWNER', undefined, t)).toBe(zh['member.lastOwner'])
    expect(messageOf('KVVI_WEIRD', 'x', t)).toBe('KVVI_WEIRD：x')
    expect(messageOf('KVVI_WEIRD', undefined, t)).toBe('KVVI_WEIRD')
  })
})

/**
 * 「企业管理」：成员、角色、策略。
 *
 * ── 界面隐藏按钮不是权限 ────────────────────────────────────────────────
 *
 * 这一层按 `capabilities` 决定**显示什么**，但那只是清晰度：
 * 每个接口在服务端各自再判一次，判定用的是会话里的身份
 * （`admin-api.mjs` 的文件头写了为什么）。所以这里的任何一处 `disabled`
 * 都不能被读成「拦住了」—— 拦住在服务端。
 *
 * ── 服务端说了什么就显示什么 ────────────────────────────────────────────
 *
 * 所有写操作都不做「乐观成功」：点了之后等响应，成功才刷新列表、才报成功；
 * 失败就显示服务端给的码。一个先显示成功再回滚的界面，在失败时会让人
 * 以为改动生效过 —— 而权限这种事，误以为生效的代价是没人去复核。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { adminCapabilities, listDepartments, listMembers, listRoles } from './api.ts'
import type { AdminCapabilities, Department, Member, Role } from './api.ts'
import type { Copy } from './FormView.tsx'
import { KvviPublishAdmin } from './PublishAdmin.tsx'
import { KvviBrandAdmin } from './BrandAdmin.tsx'
import { MemberAdmin } from './MemberAdmin.tsx'
import { RoleAdmin } from './RoleAdmin.tsx'

/** Props the administration shell accepts. */
export interface KvviAdminShellProps {
  readonly copy: Copy
}

/** Which half of the administration page is shown. */
type Tab = 'members' | 'roles' | 'brand' | 'publish'

/**
 * 服务端的拒绝码 → 一句人话；未登记的码原样带 detail。
 *
 * ⚠️ 未登记的码**不翻译**。编一句「保存失败」会把它唯一的诊断价值抹掉 ——
 * 而那正是排错时要找的东西。
 * @param code - the platform's stable code.
 * @param detail - optional extra context the platform sent.
 * @param copy - the dictionary.
 * @returns the sentence to display.
 */
export function messageOf(code: string, detail: string | undefined, copy: Copy): string {
  switch (code) {
    case 'KVVI_SELF_GRANT_FORBIDDEN':
      return copy('member.selfTarget')
    case 'KVVI_LAST_OWNER':
      return copy('member.lastOwner')
    case 'KVVI_LOGIN_EXISTS':
    case 'KVVI_PASSWORD_TOO_SHORT':
    case 'KVVI_ROLE_EXISTS':
    case 'KVVI_PLATFORM_ROLE_RESERVED':
    case 'KVVI_BAD_DATA_SCOPE':
    case 'KVVI_BAD_DIMENSION':
      // 这些都是「输入不合规」，detail 或码本身已经说清楚是什么。
      return detail === undefined ? code : `${code}：${detail}`
    default:
      return detail === undefined ? code : `${code}：${detail}`
  }
}

/** Turn a failed call into the sentence it deserves. */
export function describeFailure(code: string, detail?: string): string {
  return detail === undefined ? code : `${code}：${detail}`
}

/** The administration state both halves share. */
export interface AdminState {
  readonly copy: Copy
  readonly capabilities: AdminCapabilities
  readonly members: readonly Member[]
  readonly roles: readonly Role[]
  readonly departments: readonly Department[]
  readonly busy: boolean
  readonly reload: () => void
  /** Run one mutation and report its own outcome; never optimistically. */
  readonly run: (call: () => Promise<AdminOutcome>, success: () => string) => void
}

/** The subset of an API result a mutation reports on. */
export interface AdminOutcome {
  readonly ok: boolean
  readonly code?: string
  readonly detail?: string
}

/** Render the administration page. */
export function KvviAdminShell({ copy }: KvviAdminShellProps): ReactNode {
  const [capabilities, setCapabilities] = useState<AdminCapabilities | null>(null)
  const [denied, setDenied] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('members')

  const [members, setMembers] = useState<readonly Member[]>([])
  const [roles, setRoles] = useState<readonly Role[]>([])
  const [departments, setDepartments] = useState<readonly Department[]>([])
  const [listError, setListError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void adminCapabilities(controller.signal).then((result) => {
      if (result.ok) setCapabilities(result.value)
      else if (result.code !== 'KVVI_ABORTED') setDenied(describeFailure(result.code, result.detail))
    })
    return () => { controller.abort() }
  }, [])

  const reload = useCallback((): void => {
    setBusy(true)
    void Promise.all([listMembers(), listRoles(), listDepartments()]).then(([m, r, d]) => {
      setBusy(false)
      if (m.ok) {
        setMembers(m.value.items)
        setListError(undefined)
      } else {
        setListError(describeFailure(m.code, m.detail))
      }
      if (r.ok) setRoles(r.value.items)
      if (d.ok) setDepartments(d.value.items)
    })
  }, [])

  // 只有确认有管理能力之后才去读列表。
  //
  // ⚠️ 这不是权限 —— 是**别把 403 当异常刷屏**：员工点进来时，
  //    三个列表各自 403 会盖住「你不是管理员」这一句真正有用的话。
  useEffect(() => {
    if (capabilities?.canManageMembers !== true) return
    reload()
  }, [capabilities, reload])

  /**
   * 跑一次写操作：先看服务端的答复，再刷新列表，再报结果。
   *
   * 顺序是有意的 —— **先刷新再报成功**的话，刷新期间列表还是旧的，
   * 而成功提示已经出来了，看到的人会以为列表本身没变。
   */
  const run = useCallback((call: () => Promise<AdminOutcome>, success: () => string): void => {
    setBusy(true)
    setNotice(null)
    void call().then((result) => {
      if (!result.ok) {
        setBusy(false)
        setNotice(messageOf(result.code ?? 'KVVI_FAILED', result.detail, copy))
        return
      }
      setBusy(false)
      setNotice(success())
      reload()
    })
  }, [reload, copy])

  if (denied !== undefined) {
    return <p role="alert" style={{ fontSize: 12.5 }}>{copy('admin.failed', { detail: denied })}</p>
  }
  if (capabilities === null) {
    return <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('panel.loading')}</p>
  }
  if (!capabilities.canManageMembers) {
    return <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('admin.noPermission')}</p>
  }

  const state: AdminState = {
    copy, capabilities, members, roles, departments, busy, reload, run,
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <strong style={{ fontSize: 13 }}>{copy('admin.title')}</strong>
        <span style={{ flex: 1 }} />
        {capabilities.canManageBuilder ? null : (
          <span style={{ fontSize: 11, opacity: .6 }}>{copy('admin.readonly')}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button type="button" aria-pressed={tab === 'members'}
          style={{ fontSize: 12, fontWeight: tab === 'members' ? 600 : 400 }}
          onClick={() => { setTab('members') }}>{copy('admin.tab.members')}</button>
        <button type="button" aria-pressed={tab === 'roles'}
          style={{ fontSize: 12, fontWeight: tab === 'roles' ? 600 : 400 }}
          onClick={() => { setTab('roles') }}>{copy('admin.tab.roles')}</button>
        {/* Publishing and the company brand are owner-only on the server;
            showing these tabs only to an owner is clarity, not enforcement —
            the platform re-judges every call, and these are the calls whose
            effect reaches the whole company. Reading the brand is open to any
            session (employees see it), writing is not. */}
        {capabilities?.role === 'owner' ? (
          <>
            <button type="button" aria-pressed={tab === 'brand'}
              style={{ fontSize: 12, fontWeight: tab === 'brand' ? 600 : 400 }}
              onClick={() => { setTab('brand') }}>{copy('brand.tab')}</button>
            <button type="button" aria-pressed={tab === 'publish'}
              style={{ fontSize: 12, fontWeight: tab === 'publish' ? 600 : 400 }}
              onClick={() => { setTab('publish') }}>{copy('publish.tab')}</button>
          </>
        ) : null}
      </div>

      {listError === undefined ? null : (
        <p role="alert" style={{ fontSize: 12.5, marginBottom: 8 }}>
          {copy('admin.failed', { detail: listError })}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" style={{ fontSize: 12.5, marginBottom: 8 }} data-kvvi-admin-notice="1">
          {notice}
        </p>
      )}

      {tab === 'members' ? <MemberAdmin state={state} />
        : tab === 'roles' ? <RoleAdmin state={state} />
          : tab === 'brand' ? <KvviBrandAdmin copy={copy} />
            : <KvviPublishAdmin copy={copy} />}
    </div>
  )
}

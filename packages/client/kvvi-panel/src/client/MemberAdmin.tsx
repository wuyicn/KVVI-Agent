/**
 * 员工管理：建账号、停用/恢复、授予搭建模式与管理员角色。
 *
 * ── 停用是两步，不是一步 ────────────────────────────────────────────────
 *
 * 停用会**立刻结束该账号的全部会话**。一条点了就生效的「停用」按钮，在
 * 一张每行都有按钮的表里点错位置的代价，是有人当场被踢下线。
 * 所以它是两步：点「停用」后按钮变成「确认停用」，不点确认什么都不发生。
 *
 * 用两步而不是 `window.confirm`：原生确认框在自动化测试里无法断言，
 * 而「点错位置不会立刻生效」这件事**正是**需要被断言的行为。
 *
 * ── 越权与自授权都显示服务端的码 ────────────────────────────────────────
 *
 * 「不能对自己做这件事」（§9.6.7）、「这是最后一位所有者」都由服务端判定，
 * 界面只负责把码翻译成一句人话。在这里再判一次会让两条判据随时间分叉，
 * 而分叉的方向一定是**界面以为拦住了、服务端没有**。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createMember, reactivateMember, setBuilderAccess, setPlatformRole, suspendMember } from './api.ts'
import type { AdminState } from './AdminShell.tsx'

/**
 * Render the members half.
 * @param props - the shared administration state.
 * @returns the members table and its create row.
 */
export function MemberAdmin({ state }: { readonly state: AdminState }): ReactNode {
  const { copy, capabilities, members, departments, busy, run } = state
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [deptId, setDeptId] = useState('')
  /** 已经点过一次「停用」的那一行；再点一次才真的停用。 */
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <div>
      <div style={{ fontSize: 12, opacity: .6, marginBottom: 8 }}>{copy('admin.hint.members')}</div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        <input aria-label={copy('member.loginPlaceholder')} placeholder={copy('member.loginPlaceholder')}
          value={login} onChange={(e) => { setLogin(e.target.value) }}
          style={{ padding: '6px 8px', fontSize: 12 }} />
        <input aria-label={copy('member.passwordPlaceholder')}
          placeholder={copy('member.passwordPlaceholder')} type="password"
          value={password} onChange={(e) => { setPassword(e.target.value) }}
          style={{ padding: '6px 8px', fontSize: 12 }} />
        <select aria-label={copy('member.department')} value={deptId}
          onChange={(e) => { setDeptId(e.target.value) }}
          style={{ padding: '6px 8px', fontSize: 12 }}>
          <option value="">{copy('member.departmentPlaceholder')}</option>
          {departments.map(d => <option key={d.deptId} value={d.deptId}>{d.name}</option>)}
        </select>
        <button type="button" disabled={busy} style={{ fontSize: 12 }}
          onClick={() => {
            const created = login
            run(() => createMember({
              login, password, ...(deptId === '' ? {} : { deptId }),
            }), () => {
              setLogin('')
              setPassword('')
              setDeptId('')
              return copy('member.created', { login: created })
            })
          }}>{copy('member.create')}</button>
      </div>

      {members.length === 0 ? (
        <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('member.empty')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
            <thead>
              <tr>
                {[copy('member.login'), copy('member.status'), copy('member.department'),
                  copy('member.roles'), copy('member.builder'), copy('member.actions')]
                  .map(heading => (
                    <th key={heading} style={{
                      textAlign: 'left', padding: '6px 8px',
                      borderBottom: '1px solid var(--dsw-border, #e5e7eb)',
                    }}>{heading}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {members.map(member => (
                <tr key={member.userId}>
                  <td style={{ padding: '6px 8px' }}>{member.login}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {member.status === 'ACTIVE' ? copy('member.active') : copy('member.suspended')}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{member.deptName ?? ''}</td>
                  <td style={{ padding: '6px 8px' }}>{member.roleCodes.join('、')}</td>
                  <td style={{ padding: '6px 8px' }}>{member.builder ? '✓' : ''}</td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    {member.status === 'ACTIVE' ? (
                      <button type="button" disabled={busy} style={{ fontSize: 12, marginRight: 4 }}
                        onClick={() => {
                          // 第一次点击只是进入确认态。停用会踢掉全部会话。
                          if (confirming !== member.userId) {
                            setConfirming(member.userId)
                            return
                          }
                          setConfirming(null)
                          run(() => suspendMember(member.userId), () =>
                            copy('member.suspendedNotice', { login: member.login, endedSessions: '—' }))
                        }}
                      >{confirming === member.userId ? copy('member.confirmSuspend') : copy('member.suspend')}</button>
                    ) : (
                      <button type="button" disabled={busy} style={{ fontSize: 12, marginRight: 4 }}
                        onClick={() => {
                          run(() => reactivateMember(member.userId),
                            () => copy('member.reactivated', { login: member.login }))
                        }}>{copy('member.reactivate')}</button>
                    )}

                    <button type="button" disabled={busy || !capabilities.canManageBuilder}
                      style={{ fontSize: 12, marginRight: 4 }}
                      onClick={() => {
                        run(() => setBuilderAccess(member.userId, !member.builder), () => member.builder
                          ? copy('member.builderRevoked', { login: member.login, ended: '—' })
                          : copy('member.builderGranted', { login: member.login }))
                      }}>{member.builder ? copy('member.revokeBuilder') : copy('member.grantBuilder')}</button>

                    <button type="button" disabled={busy || !capabilities.canManagePlatformRoles}
                      style={{ fontSize: 12 }}
                      onClick={() => {
                        const isAdmin = member.platformRole === 'admin'
                        run(() => setPlatformRole(member.userId, 'admin', !isAdmin), () => isAdmin
                          ? copy('member.adminRevoked', { login: member.login })
                          : copy('member.adminGranted', { login: member.login }))
                      }}>{member.platformRole === 'admin'
                        ? copy('member.revokeAdmin') : copy('member.grantAdmin')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

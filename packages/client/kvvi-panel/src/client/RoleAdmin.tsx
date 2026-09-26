/**
 * 角色与权限：建角色、编辑策略。
 *
 * ── 一次授权是四个维度上的**一个整体** ──────────────────────────────────
 *
 * 表单（能开哪些单）、字段（每个字段可见/脱敏/隐藏/只读）、流程（能走哪些
 * 动作）、数据范围（看得到谁的数据）不是四件独立的事 —— 一条只配了表单没配
 * 数据范围的策略，在数据范围上是「没有范围」，也就是看不到任何行。
 * 所以编辑一次**整体替换**：删掉旧的，写入新的，同一个事务。
 *
 * ── 数据范围是**并集**，不是档位高低 ────────────────────────────────────
 *
 * 五档 `SELF`/`STORE`/`DEPARTMENT`/`DEPARTMENT_AND_CHILDREN`/`COMPANY` 在库里
 * 是数组，表示「这些范围都看得到」。把它做成单选下拉是**语义错误**：
 * 选了「部门」就看不见自己的单据了。所以这里是多选，并且把这句话写在界面上。
 *
 * ── 平台保留角色不在这里配 ──────────────────────────────────────────────
 *
 * `owner`/`admin` 决定「谁能管理」，不属于业务权限。把它们放进同一个编辑器，
 * 会让人以为「给这个角色勾上 COMPANY 就能管公司」—— 那是两回事。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createRole, replacePolicies } from './api.ts'
import type { Policy } from './api.ts'
import type { AdminState } from './AdminShell.tsx'
import { PolicyEditor } from './PolicyEditor.tsx'

/**
 * Render the roles half.
 * @param props - the shared administration state.
 * @returns the roles list and the inline policy editor.
 */
export function RoleAdmin({ state }: { readonly state: AdminState }): ReactNode {
  const { copy, capabilities, roles, busy, run } = state
  const [roleCode, setRoleCode] = useState('')
  const [name, setName] = useState('')
  /** 正在编辑策略的角色代号；同时只展开一个，避免两张表叠在一起看不清。 */
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <div>
      <div style={{ fontSize: 12, opacity: .6, marginBottom: 8 }}>{copy('admin.hint.roles')}</div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        <input aria-label={copy('role.codePlaceholder')} placeholder={copy('role.codePlaceholder')}
          value={roleCode} onChange={(e) => { setRoleCode(e.target.value) }}
          style={{ padding: '6px 8px', fontSize: 12 }} />
        <input aria-label={copy('role.namePlaceholder')} placeholder={copy('role.namePlaceholder')}
          value={name} onChange={(e) => { setName(e.target.value) }}
          style={{ padding: '6px 8px', fontSize: 12 }} />
        <button type="button" disabled={busy} style={{ fontSize: 12 }}
          onClick={() => {
            const created = roleCode
            run(() => createRole({ roleCode, name }), () => {
              setRoleCode('')
              setName('')
              return copy('role.created', { roleCode: created })
            })
          }}>{copy('role.create')}</button>
      </div>

      {roles.length === 0 ? (
        <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('role.empty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {roles.map(role => (
            <li key={role.roleCode} style={{
              padding: '8px 0', borderTop: '1px solid var(--dsw-border, #f1f2f4)',
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{role.name}</span>
                <code style={{ fontSize: 11.5, opacity: .6 }}>{role.roleCode}</code>
                <span style={{ fontSize: 11.5, opacity: .6 }}>
                  {copy('role.members')} {role.memberCount}
                </span>
                {role.reserved ? (
                  <span style={{ fontSize: 11.5, opacity: .6 }}>{copy('role.reserved')}</span>
                ) : null}
                <span style={{ flex: 1 }} />
                {role.reserved ? null : (
                  <button type="button" style={{ fontSize: 12 }}
                    onClick={() => { setEditing(editing === role.roleCode ? null : role.roleCode) }}
                  >{copy('role.editPolicies')}</button>
                )}
              </div>

              {role.reserved ? (
                <div style={{ fontSize: 11.5, opacity: .6, marginTop: 4 }}>
                  {copy('role.reservedNotice')}
                </div>
              ) : null}

              {editing === role.roleCode ? (
                <PolicyEditor
                  copy={copy}
                  roleCode={role.roleCode}
                  policies={role.policies}
                  capabilities={capabilities}
                  busy={busy}
                  onSave={(next: readonly Policy[]) => {
                    run(() => replacePolicies(role.roleCode, next),
                      () => copy('policy.saved', { count: String(next.length) }))
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

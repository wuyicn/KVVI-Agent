/**
 * 策略编辑器：一个角色的四维权限。
 *
 * ── 每一行的选项来自服务端 ──────────────────────────────────────────────
 *
 * 维度、五档数据范围、四种字段可见性都由 `/admin/capabilities` 给出，
 * 而不是在这里再写一份常量。写两份的后果不是「多打几个字」：
 * 服务端加了第六档而界面没有，那一档就永远配不出来；界面多了一档而服务端
 * 没有，用户会以为自己配上了，直到保存被拒 —— 而拒绝信息指向 `dataScopes`
 * 这个字段名，看不出是「界面给了一个不存在的档」。
 *
 * ── 数据范围是多选 ──────────────────────────────────────────────────────
 *
 * 五档在库里是**数组**（并集）。做成单选下拉就丢了语义：勾了「部门」的人
 * 会看不见自己的单据。所以这里是一排复选框，并且把「多项 = 这些范围都看得到」
 * 写在旁边 —— 一个会被误读的多选比一个单选更坏。
 *
 * ── 动作是自由文本 ──────────────────────────────────────────────────────
 *
 * `actions` 的可选值取决于维度与资源（例如 `FORM` 上是 read/create/update/submit，
 * `DATA` 上是空的）。当前平台没有「某维度有哪些动作」的清单端点，
 * 所以这里如实让用户输入逗号分隔的动作，**不假装有一个下拉**。
 * 这是一条已知缺口，写进 README 而不是用猜测的枚举兜住。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AdminCapabilities, Policy } from './api.ts'
import type { Copy } from './FormView.tsx'
import type { KvviKey } from './locales.ts'

/**
 * 这一行的下拉要有哪些维度。
 *
 * ⚠️ 必须**并上这一行自己的维度**：服务端的能力表里没有它时（界面比服务端旧、
 * 或那一档刚下线），若不显示，`<select>` 会渲染成空白 —— 用户看到一行没有维度
 * 的策略，一保存就把它改成了列表里的第一项。**先能看见，才谈得上改对。**
 * @param current - the dimension this row already carries.
 * @param known - the dimensions the server offers.
 * @returns the option list, current first when it is unknown.
 */
function dimensionsFor(current: string, known: readonly string[]): readonly string[] {
  return known.includes(current) ? known : [current, ...known]
}

/**
 * 维度 → 词条。**逐个列出而不是拼字符串**：拼出来的键在类型上不是词条键，
 * 而且服务端加一个维度时界面会静默显示空白 —— 显式列表下它显示原始 code，
 * 那才是「这一版界面不认识它」该有的样子。
 * @param dimension - the server's dimension code.
 * @returns the dictionary key, or `null` when this build has no wording for it.
 */
function dimensionKey(dimension: string): KvviKey | null {
  switch (dimension) {
    case 'FORM': return 'policy.dimension.FORM'
    case 'FIELD': return 'policy.dimension.FIELD'
    case 'FLOW': return 'policy.dimension.FLOW'
    case 'DATA': return 'policy.dimension.DATA'
    default: return null
  }
}

/**
 * 字段可见性 → 词条。
 * @param visibility - the server's visibility code.
 * @returns the dictionary key, or `null` when this build has no wording for it.
 */
function visibilityKey(visibility: string): KvviKey | null {
  switch (visibility) {
    case 'VISIBLE': return 'policy.visibility.VISIBLE'
    case 'MASKED': return 'policy.visibility.MASKED'
    case 'HIDDEN': return 'policy.visibility.HIDDEN'
    case 'READONLY': return 'policy.visibility.READONLY'
    default: return null
  }
}

/** Props the policy editor accepts. */
export interface PolicyEditorProps {
  readonly copy: Copy
  readonly roleCode: string
  readonly policies: readonly Policy[]
  readonly capabilities: AdminCapabilities
  readonly busy: boolean
  readonly onSave: (policies: readonly Policy[]) => void
}

/** 一行正在编辑的策略；与 `Policy` 的区别是动作在这里是逗号分隔的字符串。 */
interface Draft {
  readonly key: string
  readonly dimension: string
  readonly resourceCode: string
  readonly actions: string
  readonly dataScopes: readonly string[]
  readonly fieldVisibility: string
}

let nextKey = 0
/** 一个稳定的行标识：策略的维度 + 资源在角色内唯一，但编辑中会变，所以用计数器。 */
function keyOf(): string {
  nextKey += 1
  return `p${String(nextKey)}`
}

function draftOf(policy: Policy): Draft {
  return {
    key: keyOf(),
    dimension: policy.dimension,
    resourceCode: policy.resourceCode,
    actions: policy.actions.join(','),
    dataScopes: policy.dataScopes,
    fieldVisibility: policy.fieldVisibility ?? '',
  }
}

/** 把编辑中的一行折回 `Policy`。 */
function policyOf(draft: Draft): Policy {
  return {
    dimension: draft.dimension,
    resourceCode: draft.resourceCode,
    actions: draft.actions.split(',').map(a => a.trim()).filter(a => a !== ''),
    dataScopes: [...draft.dataScopes],
    fieldVisibility: draft.dimension === 'FIELD' && draft.fieldVisibility !== ''
      ? draft.fieldVisibility
      : null,
  }
}

/**
 * Render the policy rows of one role.
 * @param props - the role, its policies, and the server's option lists.
 * @returns the editor.
 */
export function PolicyEditor({
  copy, roleCode, policies, capabilities, busy, onSave,
}: PolicyEditorProps): ReactNode {
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => policies.map(draftOf))

  const patch = (key: string, next: Partial<Draft>): void => {
    setDrafts(rows => rows.map(row => (row.key === key ? { ...row, ...next } : row)))
  }

  return (
    <div style={{ marginTop: 8, paddingLeft: 8, borderLeft: '2px solid var(--dsw-border, #f1f2f4)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        {copy('policy.title', { roleCode })}
      </div>

      {drafts.length === 0 ? (
        <p style={{ fontSize: 12, opacity: .7 }}>{copy('policy.empty')}</p>
      ) : null}

      {drafts.map(draft => (
        <div key={draft.key} style={{
          display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8,
        }}>
          <select aria-label={copy('policy.dimension')} value={draft.dimension}
            onChange={(e) => { patch(draft.key, { dimension: e.target.value }) }}
            style={{ padding: '4px 6px', fontSize: 12 }}>
            {dimensionsFor(draft.dimension, capabilities.dimensions).map((dimension) => {
              const key = dimensionKey(dimension)
              return (
                <option key={dimension} value={dimension}>
                  {key === null ? dimension : copy(key)}
                </option>
              )
            })}
          </select>

          <input aria-label={copy('policy.resource')} placeholder={copy('policy.resourceAll')}
            value={draft.resourceCode}
            onChange={(e) => { patch(draft.key, { resourceCode: e.target.value }) }}
            style={{ padding: '4px 6px', fontSize: 12, width: 140 }} />

          <input aria-label={copy('policy.actions')} placeholder={copy('policy.actions')}
            value={draft.actions}
            onChange={(e) => { patch(draft.key, { actions: e.target.value }) }}
            style={{ padding: '4px 6px', fontSize: 12, width: 150 }} />

          {draft.dimension === 'FIELD' ? (
            <select aria-label={copy('policy.fieldVisibility')} value={draft.fieldVisibility}
              onChange={(e) => { patch(draft.key, { fieldVisibility: e.target.value }) }}
              style={{ padding: '4px 6px', fontSize: 12 }}>
              <option value="" />
              {capabilities.fieldVisibilities.map((visibility) => {
                const key = visibilityKey(visibility)
                return (
                  <option key={visibility} value={visibility}>
                    {key === null ? visibility : copy(key)}
                  </option>
                )
              })}
            </select>
          ) : null}

          {draft.dimension === 'DATA' ? (
            <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', gap: 8 }}>
              <legend style={{ fontSize: 11, opacity: .6, padding: 0 }}>{copy('policy.dataScopes')}</legend>
              {capabilities.dataScopes.map(scope => (
                <label key={scope} style={{ fontSize: 11.5 }}>
                  <input type="checkbox" aria-label={scope}
                    checked={draft.dataScopes.includes(scope)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...draft.dataScopes, scope]
                        : draft.dataScopes.filter(s => s !== scope)
                      patch(draft.key, { dataScopes: next })
                    }} />
                  <span style={{ marginLeft: 4 }}>{scope}</span>
                </label>
              ))}
            </fieldset>
          ) : null}

          <button type="button" style={{ fontSize: 12 }}
            onClick={() => { setDrafts(rows => rows.filter(row => row.key !== draft.key)) }}
          >{copy('policy.remove')}</button>
        </div>
      ))}

      <div style={{ fontSize: 11, opacity: .6, marginBottom: 8 }}>
        {copy('policy.supersetWarning')}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={{ fontSize: 12 }}
          onClick={() => {
            setDrafts(rows => [...rows, draftOf({
              dimension: 'FORM', resourceCode: '*', actions: ['read'],
              dataScopes: [], fieldVisibility: null,
            })])
          }}>{copy('policy.add')}</button>
        <button type="button" disabled={busy} style={{ fontSize: 12 }}
          onClick={() => { onSave(drafts.map(policyOf)) }}
        >{copy('policy.save')}</button>
      </div>
    </div>
  )
}

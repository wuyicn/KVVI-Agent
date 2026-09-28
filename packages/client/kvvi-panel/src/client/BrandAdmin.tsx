/**
 * 「品牌」：所有者改本公司的名称、标志与标语。
 *
 * ── 读得到，不等于改得到 ────────────────────────────────────────────────
 *
 * 读是任何有效会话都能做的（员工界面要显示本公司的牌子），写只有所有者能。
 * 这个页面只有所有者看得见，但那是**清晰度**不是权限 —— 平台每个接口各自
 * 再判一次，判定用会话里的身份。
 *
 * ── 保存只发改动过的键 ──────────────────────────────────────────────────
 *
 * ⚠️ PUT 的语义是「没给的键不动」。所以一次保存**必须省略没改动的字段**：
 * 把三个字段整份发出去（未动的发空串）会把另外两个清掉，而平台会报成功 ——
 * 因为它收到的请求本身是合法的。改一个名字顺手删掉标志和标语，是这个页面
 * 最容易犯、也最难在事后发现的错，所以判据落在 `brandingPatch` 上并由测试盯住。
 *
 * ── 没读到 ≠ 没设置 ────────────────────────────────────────────────────
 *
 * 读失败时**不画表单**：手里没有服务端的现值，就没法算「改动过哪些键」，
 * 那时让谁按下保存都可能把三个字段清空。页面显示「拒了」还是「连不上」，
 * 以及一颗重试按钮 —— 那不是空白页，是一句能据此行动的话。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { readCompanyBranding, writeCompanyBranding } from './api.ts'
import type { ApiProblem, BrandingPatch, CompanyBranding } from './api.ts'
import type { Copy } from './FormView.tsx'

/** The three editable fields, in the order the form shows them. */
const FIELDS = ['name', 'logoUrl', 'tagline'] as const

/** One editable field's name. */
type BrandField = typeof FIELDS[number]

/**
 * The form's own state.
 *
 * Every box is a string, so an emptied box means "clear this value" — which is
 * a different instruction from "I did not touch this box", and the two must
 * stay distinguishable for {@link brandingPatch}.
 */
export type BrandDraft = Record<BrandField, string>

/** What the page knows about the platform's stored branding. */
export type BrandLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly branding: CompanyBranding }
  | { readonly status: 'failed'; readonly code: string; readonly detail: string | undefined }

/** What the page says after a save attempt. */
interface BrandNotice {
  /** `saved` / `unchanged` are outcomes; `refused` keeps the platform's code. */
  readonly kind: 'saved' | 'unchanged' | 'refused'
  readonly text: string
  /** Field-level refusals, shown verbatim when the platform named any. */
  readonly problems?: readonly ApiProblem[]
}

/** Props the brand half accepts. */
export interface KvviBrandAdminProps {
  readonly copy: Copy
}

/** The client's own code for "the request never reached the platform". */
const UNREACHABLE = 'KVVI_UNREACHABLE'

/** The client's own code for "the caller withdrew the request". */
const ABORTED = 'KVVI_ABORTED'

/** A company with nothing set: the form's starting text before the read lands. */
const NOTHING_SET: CompanyBranding = { name: null, logoUrl: null, tagline: null }

/**
 * One sentence for a failed **write**, keeping the platform's refusal apart
 * from a network failure.
 *
 * Those two need different people: a refusal means the session, the role, or
 * the values themselves; a network failure means the deployment. One shared
 * "保存失败" would send both of them to the wrong place.
 *
 * The detail is spelled the same way `AdminShell.describeFailure` spells it;
 * this file does not import that one because AdminShell renders this component.
 * @param code - the platform's code, or this client's own transport code.
 * @param detail - the platform's extra context, when it sent any.
 * @param copy - the dictionary.
 * @returns the sentence to display.
 */
export function brandWriteFailure(code: string, detail: string | undefined, copy: Copy): string {
  if (code === UNREACHABLE) return copy('brand.write.unreachable')
  return copy('brand.write.refused', { detail: detail === undefined ? code : `${code}：${detail}` })
}

/**
 * The form state that shows one branding read.
 * @param branding - the three values as the platform sent them.
 * @returns the three boxes' initial text.
 */
export function brandDraftOf(branding: CompanyBranding): BrandDraft {
  return {
    name: branding.name ?? '',
    logoUrl: branding.logoUrl ?? '',
    tagline: branding.tagline ?? '',
  }
}

/**
 * The body a save sends: **only the fields the owner actually changed**.
 *
 * A field equal to what was read is omitted, which is what leaves it alone;
 * an emptied field is sent as null, which is what clears it.
 * @param initial - the branding as last read from the platform.
 * @param draft - the form's current text.
 * @returns the changed keys only; empty when nothing changed.
 */
export function brandingPatch(initial: CompanyBranding, draft: BrandDraft): BrandingPatch {
  const patch: {
    name?: string | null
    logoUrl?: string | null
    tagline?: string | null
  } = {}
  for (const field of FIELDS) {
    const after = draft[field]
    if (after === (initial[field] ?? '')) continue
    patch[field] = after.trim() === '' ? null : after
  }
  return patch
}

/**
 * Render the brand half of enterprise administration.
 * @param props - the dictionary seat.
 * @returns the three-field form, or the reason it could not be shown.
 */
export function KvviBrandAdmin({ copy }: KvviBrandAdminProps): ReactNode {
  const [load, setLoad] = useState<BrandLoad>({ status: 'loading' })
  const [draft, setDraft] = useState<BrandDraft>(() => brandDraftOf(NOTHING_SET))
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<BrandNotice | null>(null)

  const read = useCallback((signal?: AbortSignal): void => {
    setBusy(true)
    setNotice(null)
    void readCompanyBranding(signal).then((result) => {
      if (!result.ok) {
        // An abort is this effect's own teardown, not a fact to report.
        if (result.code === ABORTED) return
        setBusy(false)
        setLoad({ status: 'failed', code: result.code, detail: result.detail })
        return
      }
      setBusy(false)
      setLoad({ status: 'ready', branding: result.value })
      setDraft(brandDraftOf(result.value))
    })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal)
    return () => { controller.abort() }
  }, [read])

  const save = useCallback((initial: CompanyBranding): void => {
    const patch = brandingPatch(initial, draft)
    // Nothing changed means nothing to say to the platform: a PUT with an
    // empty body would be a write that writes nothing, and it would still be
    // recorded as a change.
    if (Object.keys(patch).length === 0) {
      setNotice({ kind: 'unchanged', text: copy('brand.unchanged') })
      return
    }
    setBusy(true)
    setNotice(null)
    void writeCompanyBranding(patch).then((result) => {
      setBusy(false)
      if (!result.ok) {
        setNotice({
          kind: 'refused',
          text: brandWriteFailure(result.code, result.detail, copy),
          ...(result.problems === undefined ? {} : { problems: result.problems }),
        })
        return
      }
      // The write's body is the state the platform now holds, so it seeds the
      // form: what the server stored is what the next save compares against. A
      // bodyless 200 or a 204 is a successful write that carries none — that
      // case re-reads, because three empty boxes would read as "everything was
      // cleared".
      const stored: CompanyBranding | undefined = result.value
      if (stored === undefined) {
        read()
      } else {
        setLoad({ status: 'ready', branding: stored })
        setDraft(brandDraftOf(stored))
      }
      // After read()'s own reset, so a success is not reported as nothing.
      setNotice({ kind: 'saved', text: copy('brand.saved') })
    })
  }, [draft, copy])

  return (
    <div>
      <div style={{ fontSize: 12, opacity: .6, marginBottom: 8 }}>{copy('brand.hint')}</div>

      {notice === null ? null : (
        <div
          role={notice.kind === 'refused' ? 'alert' : 'status'}
          data-kvvi-brand-notice={notice.kind}
          style={{ fontSize: 12.5, marginBottom: 8 }}
        >
          {notice.text}
          {notice.problems === undefined ? null : (
            <ul style={{ margin: '4px 0 0 16px' }}>
              {notice.problems.map(problem => (
                <li key={problem.field}>{problem.field}：{problem.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {load.status === 'loading' ? (
        <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('panel.loading')}</p>
      ) : load.status === 'failed' ? (
        <div>
          {/* Two different failures, two different sentences: a refusal is
              about this session, an unreachable platform is about the
              deployment. Both are shown, neither is dressed up as an empty
              brand the company never configured. */}
          <p role="alert" data-kvvi-brand-error="1" style={{ fontSize: 12.5 }}>
            {load.code === UNREACHABLE
              ? copy('brand.read.unreachable')
              : copy('brand.read.refused', {
                detail: load.detail === undefined ? load.code : `${load.code}：${load.detail}`,
              })}
          </p>
          <button type="button" disabled={busy} style={{ fontSize: 12 }} onClick={() => { read() }}>
            {copy('brand.retry')}
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          {FIELDS.map(field => (
            <label key={field} style={{ fontSize: 12 }}>
              <span style={{ display: 'inline-block', minWidth: 72 }}>
                {copy(`brand.${field}`)}
              </span>
              <input
                aria-label={copy(`brand.${field}`)}
                data-kvvi-brand-field={field}
                value={draft[field]}
                onChange={(e) => {
                  const value = e.target.value
                  setDraft(current => ({ ...current, [field]: value }))
                }}
                style={{ padding: '6px 8px', fontSize: 12, minWidth: 280 }}
              />
            </label>
          ))}
          <button type="button" disabled={busy} data-kvvi-brand-save="1"
            style={{ fontSize: 12 }} onClick={() => { save(load.branding) }}>
            {busy ? copy('brand.saving') : copy('brand.save')}
          </button>
        </div>
      )}
    </div>
  )
}

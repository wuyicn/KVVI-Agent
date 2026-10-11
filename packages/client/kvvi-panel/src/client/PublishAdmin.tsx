/**
 * The publish half of enterprise administration: pending drafts, the diff an
 * approver has to read, and the publish that follows.
 *
 * ── Why this page exists, and why it is only half of publishing ─────────
 *
 * The publish channel was implemented and tested from the first day and had
 * **no caller at all** — no route, no page, no tool. A builder delivered six
 * validated contracts and then said, in its own delivery note, "publishing is
 * yours to do in the workbench" — and the workbench had no such button.
 *
 * This is that button, and it is deliberately only the second half:
 *
 * | Step | Who | Where |
 * |---|---|---|
 * | Submit (with the contracts) | the builder | the agent / the CLI scaffold |
 * | Approve + publish | the owner | here |
 *
 * The split is §9.6.1, not ergonomics. Submitting needs the contract files,
 * which live in the builder's workspace and cannot be read from a browser —
 * and more importantly, the person who built must not be the person who
 * approves. One surface cannot do both without one account holding both.
 *
 * ── Nothing here is optimistic ─────────────────────────────────────────
 *
 * Every write waits for the platform and shows the platform's own code on
 * refusal. A page that shows success and rolls back later is worse here than
 * elsewhere: a permission change believed to have taken effect is a permission
 * change nobody re-checks.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { decideDraft, getDraft, listDrafts, publishDraft } from './api.ts'
import type { PublishDraft, PublishDraftDetail } from './api.ts'
import type { Copy } from './FormView.tsx'

/** Server refusal codes this page knows how to explain. */
const REFUSAL_KEYS: Record<string, string> = {
  KVVI_UNIQUE_EXISTING_DUPLICATES: 'publish.refused.duplicates',
  KVVI_UNIQUE_PUBLICATION_PENDING: 'form.rulesUpdating',
  KVVI_SELF_APPROVAL_FORBIDDEN: 'publish.refused.selfApproval',
  KVVI_APPROVAL_DIGEST_MISMATCH: 'publish.refused.digest',
  KVVI_NOT_OWNER: 'publish.refused.notOwner',
  KVVI_DRAFT_NOT_APPROVED: 'publish.refused.notApproved',
  KVVI_DRAFT_PAYLOAD_MISSING: 'publish.refused.payloadMissing',
  KVVI_DRAFT_NOT_AWAITING_APPROVAL: 'publish.refused.notAwaiting',
}

/**
 * Turn a refusal into a sentence.
 *
 * ⚠️ **Unregistered codes pass through verbatim.** Inventing "save failed"
 * would erase the only diagnostic value the code has, and it is exactly what
 * an operator greps for.
 * @param code - the platform's stable code.
 * @param copy - the dictionary.
 * @returns a sentence, or the code itself.
 */
function explain(code: string, copy: Copy): string {
  const key = REFUSAL_KEYS[code]
  return key === undefined ? code : copy(key as never)
}

/** Props the publish half accepts. */
export interface KvviPublishAdminProps {
  readonly copy: Copy
}

/**
 * Render the publish half.
 * @param props - the dictionary seat.
 * @returns the drafts list and the diff of whichever one is open.
 */
export function KvviPublishAdmin({ copy }: KvviPublishAdminProps): ReactNode {
  const [drafts, setDrafts] = useState<readonly PublishDraft[]>([])
  const [detail, setDetail] = useState<PublishDraftDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const refresh = useCallback(async () => {
    const listed = await listDrafts()
    if (listed.ok) setDrafts(listed.value.items)
    else setNote(explain(listed.code, copy))
  }, [copy])

  useEffect(() => { void refresh() }, [refresh])

  /**
   * Run one write, then reload. The list is reloaded even on failure: the
   * platform may have refused because the draft moved on, and showing the
   * stale row would hide exactly that.
   * @param action - the write to perform.
   */
  const run = async (action: () => Promise<{ ok: boolean; code?: string }>): Promise<void> => {
    setBusy(true)
    const result = await action()
    setNote(result.ok ? '' : explain(result.code ?? 'KVVI_UNKNOWN', copy))
    setBusy(false)
    await refresh()
  }

  const open = async (draftId: string): Promise<void> => {
    const read = await getDraft(draftId)
    if (read.ok) setDetail(read.value)
    else setNote(explain(read.code, copy))
  }

  return (
    <div>
      <div style={{ fontSize: 12, opacity: .6, marginBottom: 8 }}>{copy('publish.hint')}</div>

      {note === '' ? null : (
        <div role="alert" style={{ fontSize: 12, marginBottom: 8 }} data-kvvi-publish-error="">
          {note}
        </div>
      )}

      {drafts.length === 0 ? (
        <div style={{ fontSize: 12, opacity: .6 }}>{copy('publish.empty')}</div>
      ) : (
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{copy('publish.col.proposer')}</th>
              <th style={{ textAlign: 'left' }}>{copy('publish.col.status')}</th>
              <th style={{ textAlign: 'left' }}>{copy('publish.col.created')}</th>
              <th style={{ textAlign: 'left' }}>{copy('publish.col.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map(draft => (
              <tr key={draft.draftId} data-kvvi-draft={draft.draftId}>
                <td>{draft.proposer}</td>
                <td><code>{draft.status}</code></td>
                <td>{draft.created_at}</td>
                <td>
                  <button type="button" disabled={busy}
                    onClick={() => { void open(draft.draftId) }}>
                    {copy('publish.view')}
                  </button>
                  {' '}
                  <button type="button" disabled={busy || draft.status !== 'AWAITING_APPROVAL'}
                    data-kvvi-approve=""
                    onClick={() => {
                      void run(async () => {
                        const out = await decideDraft(draft.draftId, draft.change_digest)
                        return out.ok ? { ok: true } : { ok: false, code: out.code }
                      })
                    }}>
                    {copy('publish.approve')}
                  </button>
                  {' '}
                  <button type="button" disabled={busy || draft.status !== 'APPROVED'}
                    data-kvvi-publish=""
                    onClick={() => {
                      void run(async () => {
                        const out = await publishDraft(draft.draftId)
                        return out.ok ? { ok: true } : { ok: false, code: out.code }
                      })
                    }}>
                    {copy('publish.publish')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail === null ? null : (
        <div data-kvvi-draft-diff="" style={{ marginTop: 12, fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>{copy('publish.diff.title')}</div>
          <div>
            {copy('publish.diff.counts', {
              added: detail.diff_report?.counts?.added ?? 0,
              removed: detail.diff_report?.counts?.removed ?? 0,
              changed: detail.diff_report?.counts?.changed ?? 0,
            })}
          </div>
          {/* The faces are what §9.6.6 requires a diff report to cover; showing
              them is how an approver sees that all of them were considered. */}
          <ul style={{ margin: '4px 0 0 16px' }}>
            {(detail.diff_report?.faces ?? []).map(face => <li key={face}>{face}</li>)}
          </ul>
          <div style={{ opacity: .6 }}>{copy('publish.diff.digest', { digest: detail.change_digest })}</div>
        </div>
      )}
    </div>
  )
}

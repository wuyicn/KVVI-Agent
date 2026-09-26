/**
 * "我的系统": the employee's entry into the published business systems.
 *
 * ── The two halves of one system ────────────────────────────────────────────
 *
 * A published system carries one `view-schema`, whose `view_type` says whether
 * it is a form, a list or a detail page. What an employee needs from a system,
 * though, is always the same pair: **fill in a new record** and **see the
 * records**. This shell offers both, and each half is grounded in an endpoint
 * the platform actually serves:
 *
 * | Half | Source |
 * |---|---|
 * | 填单 | the published `view-schema`, drawn by the closed registry |
 * | 记录 | `GET /systems/:id/records`, filtered by the platform's field visibility |
 *
 * ── Failures are shown, never smoothed over ─────────────────────────────────
 *
 * "The system cannot run" (`KVVI_RUNTIME_CONTRACT_INCOMPLETE`), "the read was
 * refused" and "there is nothing yet" are three different facts with three
 * different fixes. Each keeps its own state, and the refusal codes are shown
 * verbatim because that is what an operator searches for.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  createRecord, getRecord, listRecords, listSystems, loadRuntime, updateRecord,
} from './api.ts'
import type { PublishedSystem, RecordRow, RecordView, RuntimeProjection } from './api.ts'
import type { Copy } from './FormView.tsx'
import { KvviFormView, fieldContextOf } from './FormView.tsx'
import { KvviListView } from './ListView.tsx'
import { KvviRecordDetail } from './RecordDetail.tsx'

/** Props the shell accepts. */
export interface KvviSystemShellProps {
  readonly copy: Copy
}

/** The half of a system currently shown. */
type Tab = 'form' | 'records'

/**
 * Read a failure into the sentence its code deserves.
 *
 * A code the panel does not know is shown with its detail, not hidden: an
 * unrecognised refusal is information, and replacing it with "出错了" would
 * destroy the only copy of it on the screen.
 * @param code - the platform's stable code.
 * @param detail - optional extra context the platform sent.
 * @returns the message to display.
 */
function describeFailure(code: string, detail?: string): string {
  return detail === undefined ? code : `${code}：${detail}`
}

/**
 * Render the systems list, or the open system.
 * @param props - copy from the surrounding panel.
 * @returns the shell.
 */
export function KvviSystemShell({ copy }: KvviSystemShellProps): ReactNode {
  const [systems, setSystems] = useState<readonly PublishedSystem[] | null>(null)
  const [systemsError, setSystemsError] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState<PublishedSystem | null>(null)

  const [projection, setProjection] = useState<RuntimeProjection | null>(null)
  const [projectionError, setProjectionError] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('form')

  const [rows, setRows] = useState<readonly RecordRow[]>([])
  const [visibility, setVisibility] = useState<Readonly<Record<string, string>>>({})
  const [listError, setListError] = useState<string | undefined>(undefined)

  const [detail, setDetail] = useState<RecordView | null>(null)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [conflictVersion, setConflictVersion] = useState<number | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void listSystems(controller.signal).then((result) => {
      if (result.ok) setSystems(result.value.items)
      else if (result.code !== 'KVVI_ABORTED') setSystemsError(describeFailure(result.code, result.detail))
    })
    return () => { controller.abort() }
  }, [])

  useEffect(() => {
    if (open === null) return undefined
    const controller = new AbortController()
    setProjection(null)
    setProjectionError(undefined)
    void loadRuntime(open.assetId, controller.signal).then((result) => {
      if (result.ok) setProjection(result.value)
      else if (result.code !== 'KVVI_ABORTED') setProjectionError(describeFailure(result.code, result.detail))
    })
    return () => { controller.abort() }
  }, [open])

  const refreshRows = useCallback((): void => {
    if (open === null) return
    setBusy(true)
    void listRecords(open.assetId).then((result) => {
      setBusy(false)
      if (result.ok) {
        setRows(result.value.items)
        setVisibility(result.value.fieldVisibility)
        setListError(undefined)
      } else {
        setListError(describeFailure(result.code, result.detail))
      }
    })
  }, [open])

  useEffect(() => {
    if (open === null || tab !== 'records') return
    refreshRows()
  }, [open, tab, refreshRows])

  const openRecord = (recordId: string): void => {
    if (open === null) return
    setDetailError(undefined)
    setConflictVersion(undefined)
    setSaved(false)
    void getRecord(open.assetId, recordId).then((result) => {
      if (result.ok) setDetail(result.value)
      else setDetailError(describeFailure(result.code, result.detail))
    })
  }

  const model = projection === null || open === null ? undefined : projection.models[open.assetId]
  const view = projection === null || open === null ? undefined : projection.views[open.assetId]
  const workflow = projection === null || open === null ? undefined : projection.workflows[open.assetId]
  const modes = detail?.fieldVisibility ?? visibility
  const fieldContext = fieldContextOf(model?.fields, modes)
  // Named so the optional prop can be *omitted* rather than passed as
  // `undefined` (`exactOptionalPropertyTypes`). Both are equivalent here, and
  // the spread is the form the rest of this file already uses.
  const stateLabel = detail === null ? undefined : workflow?.states?.[detail.state ?? '']?.label

  // ── The systems list ──────────────────────────────────────────────────────
  if (open === null) {
    return (
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{copy('systems.title')}</div>
        <div style={{ fontSize: 12, opacity: .6, marginBottom: 8 }}>{copy('systems.hint')}</div>
        {systemsError === undefined ? null : (
          <p role="alert" style={{ fontSize: 12.5 }}>{copy('systems.failed', { detail: systemsError })}</p>
        )}
        {systems !== null && systems.length === 0 ? (
          <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('systems.empty')}</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {(systems ?? []).map(system => (
              <li
                key={system.systemId}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 0',
                  borderTop: '1px solid var(--dsw-border, #f1f2f4)',
                }}
              >
                <span style={{ fontSize: 12.5 }}>{system.name}</span>
                <span style={{ fontSize: 12, opacity: .55 }}>{system.assetId}</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  style={{ fontSize: 12 }}
                  onClick={() => { setOpen(system); setTab('form'); setRows([]); setDetail(null) }}
                >
                  {copy('systems.open')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  // ── One record inside the open system ─────────────────────────────────────
  if (detail !== null || detailError !== undefined) {
    return (
      <div>
        <button
          type="button"
          style={{ fontSize: 12, marginBottom: 10 }}
          onClick={() => { setDetail(null); setDetailError(undefined) }}
        >
          {copy('detail.back')}
        </button>
        {detail === null ? (
          <p role="alert" style={{ fontSize: 12.5 }}>{detailError}</p>
        ) : (
          <KvviRecordDetail
            copy={copy}
            record={detail}
            fields={model?.fields}
            busy={busy}
            saved={saved}
            {...(stateLabel === undefined ? {} : { stateLabel })}
            {...(conflictVersion === undefined ? {} : { conflictRowVersion: conflictVersion })}
            {...(detailError === undefined ? {} : { error: detailError })}
            onBack={() => { setDetail(null); setDetailError(undefined) }}
            onSave={(data, rowVersion) => {
              setBusy(true)
              setSaved(false)
              setConflictVersion(undefined)
              void updateRecord(open.assetId, detail.recordId, data, rowVersion).then((result) => {
                setBusy(false)
                if (result.ok) {
                  setSaved(true)
                  setDetailError(undefined)
                  setDetail({ ...detail, rowVersion: result.value.rowVersion })
                  return
                }
                setDetailError(describeFailure(result.code, result.detail))
                if (result.currentRowVersion !== undefined) setConflictVersion(result.currentRowVersion)
              })
            }}
          />
        )}
      </div>
    )
  }

  // ── The open system's two halves ──────────────────────────────────────────
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <button type="button" style={{ fontSize: 12 }} onClick={() => { setOpen(null) }}>
          {copy('system.back')}
        </button>
        <strong style={{ fontSize: 13 }}>{open.name}</strong>
        <span style={{ flex: 1 }} />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button
          type="button"
          aria-pressed={tab === 'form'}
          style={{ fontSize: 12, fontWeight: tab === 'form' ? 600 : 400 }}
          onClick={() => { setTab('form') }}
        >
          {copy('system.tab.form')}
        </button>
        <button
          type="button"
          aria-pressed={tab === 'records'}
          style={{ fontSize: 12, fontWeight: tab === 'records' ? 600 : 400 }}
          onClick={() => { setTab('records') }}
        >
          {copy('system.tab.records')}
        </button>
      </div>

      {notice === null ? null : (
        <p style={{ fontSize: 12.5, marginBottom: 8 }} data-kvvi-notice="1">{notice}</p>
      )}

      {projectionError !== undefined ? (
        <p role="alert" style={{ fontSize: 12.5 }}>
          {copy('system.unrunnable', { detail: projectionError })}
        </p>
      ) : projection === null ? (
        <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('panel.loading')}</p>
      ) : tab === 'form' ? (
        view === undefined ? (
          <p role="alert" style={{ fontSize: 12.5 }}>
            {copy('system.unrunnable', { detail: 'KVVI_RUNTIME_CONTRACT_INCOMPLETE' })}
          </p>
        ) : (
          <KvviFormView
            spec={view}
            copy={copy}
            context={fieldContext}
            onSubmit={(data) => {
              setBusy(true)
              setNotice(null)
              void createRecord(open.assetId, data).then((result) => {
                setBusy(false)
                setNotice(result.ok
                  ? copy('form.created', { recordNo: result.value.recordNo ?? result.value.recordId })
                  : copy('form.failed', { detail: describeFailure(result.code, result.detail) }))
              })
            }}
          />
        )
      ) : (
        <KvviListView
          copy={copy}
          fields={model?.fields}
          rows={rows}
          fieldVisibility={visibility}
          busy={busy}
          {...(model?.name === undefined ? {} : { title: model.name })}
          {...(listError === undefined ? {} : { error: listError })}
          onOpen={openRecord}
          onRefresh={refreshRows}
        />
      )}
    </div>
  )
}

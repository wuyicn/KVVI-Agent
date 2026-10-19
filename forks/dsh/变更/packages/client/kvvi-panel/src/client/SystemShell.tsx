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
  createRecord, getRecord, listRecords, listSystems, loadRuntime, readFormFields, updateRecord,
} from './api.ts'
import type { AuthorizedField, PublishedSystem, RecordRow, RecordView, RuntimeProjection } from './api.ts'
import type { Copy } from './FormView.tsx'
import { KvviFormView, fieldContextOf } from './FormView.tsx'
import { KvviListView } from './ListView.tsx'
import { KvviRecordDetail } from './RecordDetail.tsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ReadFailure } from './ReadFailure.tsx'
import { coerceCreateData } from './values.ts'
import css from './business.module.css'

/** Props the shell accepts. */
export interface KvviSystemShellProps {
  readonly initialSystem?: PublishedSystem
  readonly copy: Copy
  readonly onDock?: (system: PublishedSystem, mode: 'form' | 'records') => void
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
export function KvviSystemShell({ copy, onDock, initialSystem }: KvviSystemShellProps): ReactNode {
  const [systems, setSystems] = useState<readonly PublishedSystem[] | null>(null)
  const [systemsError, setSystemsError] = useState<string | undefined>(undefined)
  const [open, setOpen] = useState<PublishedSystem | null>(initialSystem ?? null)
  const [systemsAttempt, setSystemsAttempt] = useState(0)
  const [runtimeAttempt, setRuntimeAttempt] = useState(0)

  const [projection, setProjection] = useState<RuntimeProjection | null>(null)
  const [projectionError, setProjectionError] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<Tab>('form')

  const [rows, setRows] = useState<readonly RecordRow[]>([])
  const [visibility, setVisibility] = useState<Readonly<Record<string, string>>>({})
  const [formFields, setFormFields] = useState<readonly AuthorizedField[] | null>(null)
  const [formError, setFormError] = useState<string | undefined>()
  const [formAttempt, setFormAttempt] = useState(0)
  const [listError, setListError] = useState<string | undefined>(undefined)

  const [detail, setDetail] = useState<RecordView | null>(null)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [conflictVersion, setConflictVersion] = useState<number | undefined>(undefined)
  const [saved, setSaved] = useState(false)

  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setSystemsError(undefined)
    setSystems(null)
    void listSystems(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setSystems(result.value.items)
      else if (result.code !== 'KVVI_ABORTED') setSystemsError(describeFailure(result.code, result.detail))
    })
    return () => { controller.abort() }
  }, [systemsAttempt])

  useEffect(() => {
    if (open === null) return undefined
    const controller = new AbortController()
    setProjection(null)
    setFormFields(null)
    setProjectionError(undefined)
    void loadRuntime(open.assetId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setProjection(result.value)
      else if (result.code !== 'KVVI_ABORTED') setProjectionError(describeFailure(result.code, result.detail))
    })
    return () => { controller.abort() }
  }, [open, runtimeAttempt])

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

  // The form's field visibility does not come from the records list: an empty
  // system has no rows, so `listRecords` returns an empty `fieldVisibility` and a
  // `HIDDEN` field would render as visible on first open (acceptance U1). The
  // `/fields` endpoint answers "which fields may this session see" without any
  // records, so it is the form's source of truth.
  useEffect(() => {
    if (open === null || tab !== 'form' || projection === null) return undefined
    const controller = new AbortController()
    setFormFields(null)
    setFormError(undefined)
    void readFormFields(open.assetId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setFormFields(result.value.fields)
      else setFormError(describeFailure(result.code, result.detail))
    })
    return () => { controller.abort() }
  }, [open, tab, projection, formAttempt])

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
  const formModes = Object.fromEntries((model?.fields ?? []).map(field => {
    const rawMode = formFields?.find(visible => visible.field_code === field.field_code)?.visibility ?? 'HIDDEN'
    const mode = ['VISIBLE', 'READONLY', 'MASKED'].includes(rawMode) ? rawMode : 'HIDDEN'
    return [field.field_code, mode === 'VISIBLE' && field.write_policy === 'SYSTEM' ? 'READONLY' : mode]
  }))
  const createFields = (model?.fields ?? []).filter(field => formFields?.some(visible => visible.field_code === field.field_code))
    .map(field => ({ ...field, type_config: { ...field.type_config, ...formFields?.find(visible => visible.field_code === field.field_code)?.type_config,
      options: formFields?.find(visible => visible.field_code === field.field_code)?.options ?? [] } }))
  const modes = tab === 'form' ? formModes : visibility
  const fieldContext = fieldContextOf(tab === 'form' ? createFields : model?.fields, modes)
  // Named so the optional prop can be *omitted* rather than passed as
  // `undefined` (`exactOptionalPropertyTypes`). Both are equivalent here, and
  // the spread is the form the rest of this file already uses.
  const stateLabel = detail === null ? undefined : workflow?.stateLabels?.[detail.state ?? '']?.label

  // ── The systems list ──────────────────────────────────────────────────────
  if (open === null) {
    return (
      <div>
        <h3 className={css.sectionTitle}>{copy('systems.title')}</h3>
        <p className={css.hint}>{copy('systems.hint')}</p>
        {systemsError === undefined ? null : (
          <ReadFailure error={systemsError} copy={copy} onRetry={() => { setSystemsAttempt(value => value + 1) }} />
        )}
        {systems === null && systemsError === undefined ? <p role="status" className={css.empty}>{copy('panel.loading')}</p> : null}
        {systems !== null && systems.length === 0 ? (
          <p className={css.empty}>{copy('systems.empty')}</p>
        ) : (
          <ul className={css.systemList}>
            {(systems ?? []).map(system => (
              <li
                key={system.systemId}
                className={css.systemRow}
              >
                <div>
                  <div className={css.systemName}>{system.name}</div>
                  {system.name === system.assetId ? null : <div className={css.hint}>{system.assetId}</div>}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setOpen(system); setTab('form'); setRows([]); setDetail(null) }}
                >
                  {copy('systems.open')}
                </Button>
                {onDock === undefined ? null : <Button variant="ghost" onClick={() => { onDock(system, 'form') }}>{copy('system.dock')}</Button>}
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
                  setDetail({ ...detail, data: { ...detail.data, ...data }, rowVersion: result.value.rowVersion })
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
      <div className={css.systemHeading}>
        <Button variant="outline" onClick={() => { setOpen(null) }}>
          {copy('system.back')}
        </Button>
        <h3 className={css.sectionTitle}>{open.name}</h3>
      </div>

      <div className={css.viewTabs}>
        <Button
          type="button"
          aria-pressed={tab === 'form'}
          variant={tab === 'form' ? 'primary' : 'ghost'}
          onClick={() => { setTab('form') }}
        >
          {copy('system.tab.form')}
        </Button>
        <Button
          type="button"
          aria-pressed={tab === 'records'}
          variant={tab === 'records' ? 'primary' : 'ghost'}
          onClick={() => { setTab('records') }}
        >
          {copy('system.tab.records')}
        </Button>
      </div>

      {notice === null ? null : (
        <p style={{ fontSize: 12.5, marginBottom: 8 }} data-kvvi-notice="1">{notice}</p>
      )}

      {projectionError !== undefined ? (
        <ReadFailure error={projectionError} copy={copy} onRetry={() => { setRuntimeAttempt(value => value + 1) }} />
      ) : projection === null ? (
        <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('panel.loading')}</p>
      ) : tab === 'form' ? (
        view === undefined ? (
          <p role="alert" style={{ fontSize: 12.5 }}>
            {copy('system.unrunnable', { detail: 'KVVI_RUNTIME_CONTRACT_INCOMPLETE' })}
          </p>
        ) : formError !== undefined ? (
          <ReadFailure error={formError} copy={copy} onRetry={() => { setFormAttempt(value => value + 1) }} />
        ) : formFields === null ? (
          <p role="status">{copy('panel.loading')}</p>
        ) : (
          <KvviFormView
            spec={view}
            copy={copy}
            context={fieldContext}
            busy={busy}
            onSubmit={(data) => {
              if (busy) return
              const converted = coerceCreateData(createFields, data, formModes)
              if (converted.invalidFields.length > 0) {
                setNotice(copy('field.invalidValue', { fields: converted.invalidFields.map(code => model?.fields?.find(field => field.field_code === code)?.label ?? code).join('、') }))
                return
              }
              setBusy(true)
              setNotice(null)
              void createRecord(open.assetId, converted.data).then((result) => {
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

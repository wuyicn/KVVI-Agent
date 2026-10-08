/** Authenticated business content inside the original session-bound DSH tab. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { createRecord, getRecord, listRecords, loadRuntime, readFormFields, updateRecord } from './api.ts'
import type { AuthorizedField, RecordPage, RecordView, RuntimeProjection } from './api.ts'
import { businessAddress, parseBusinessAddress } from './business-tabs.ts'
import type { createBusinessStore } from './business-store.ts'
import { KvviFormView, fieldContextOf } from './FormView.tsx'
import { KvviListView } from './ListView.tsx'
import { KvviRecordDetail } from './RecordDetail.tsx'
import { ReadFailure } from './ReadFailure.tsx'
import css from './business.module.css'

export type BusinessBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'kvviPanel'> & PropsStore<ReturnType<typeof createBusinessStore>>

/** Every read is cancelled on navigation; writes settle only for their original occurrence. */
export function BusinessBody({ useTabInfo, ...props }: BusinessBodyProps) {
  const { tab } = useTabInfo()
  return <BusinessContent {...props} address={tab.navigation.address} signal={tab.signal}
    openResource={(address, options) => { tab.actions.openResource(address, options) }} />
}
export interface BusinessContentProps extends Pick<BusinessBodyProps, 'useStore' | 'actions' | 't'> {
  address: string
  signal: AbortSignal
  openResource: (address: string, options?: { replaceTab: boolean }) => void
}
/** One authorized renderer shared by the main business page and workspace dock. */
export function BusinessContent({ address, signal, openResource, useStore, actions, t }: BusinessContentProps) {
  const route = parseBusinessAddress(address)
  const draft = useStore(state => state.drafts[route?.assetId ?? ''])
  const [projection, setProjection] = useState<RuntimeProjection | null>(null)
  const [page, setPage] = useState<RecordPage | null>(null)
  const [allowedFields, setAllowedFields] = useState<AuthorizedField[] | null>(null)
  const write = useStore(state => state.writes[address])
  const revision = (write?.revision ?? 0) + useStore(state => state.revisions[route?.assetId ?? ''] ?? 0)
  const busy = write?.busy === true
  const conflictVersion = write?.currentRowVersion
  const [detail, setDetail] = useState<RecordView | null>(null)
  const [readError, setError] = useState<string | undefined>()
  const error = readError ?? write?.error
  const [notice, setNotice] = useState<string | undefined>()
  const [attempt, setAttempt] = useState(0)
  const [dialog, setDialog] = useState(false)
  const live = useRef(true)
  const writing = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    const controller = new AbortController()
    setProjection(null); setAllowedFields(null); setPage(null); setDetail(null); setError(undefined); setNotice(undefined)
    if (route === null) { setError('KVVI_BAD_REQUEST'); return () => { controller.abort() } }
    const { assetId, mode, recordId } = route
    void (async () => {
      const runtime = await loadRuntime(assetId, controller.signal)
      if (controller.signal.aborted) return
      if (!runtime.ok) { setError(runtime.code); return }
      setProjection(runtime.value)
      if (mode === 'form') {
        const result = await readFormFields(assetId, controller.signal)
        if (controller.signal.aborted) return
        if (result.ok) setAllowedFields(result.value.fields); else setError(result.code)
      } else if (mode === 'records') {
        const result = await listRecords(assetId, controller.signal)
        if (controller.signal.aborted) return
        if (result.ok) setPage(result.value); else setError(result.code)
      } else if (mode === 'detail' && recordId !== undefined) {
        const result = await getRecord(assetId, recordId, controller.signal)
        if (controller.signal.aborted) return
        if (result.ok) setDetail(result.value); else setError(result.code)
      }
    })()
    return () => { controller.abort() }
  }, [address, attempt, revision])
  if (route === null) return <ReadFailure error="KVVI_BAD_REQUEST" copy={t} onRetry={() => { setAttempt(a => a + 1) }} />
  const { assetId, mode, recordId } = route
  const model = projection?.models[assetId]
  const view = projection?.views[assetId]
  const open = (next: 'form' | 'records') => { openResource(businessAddress(assetId, next)) }
  const create = (data: Record<string, string>) => {
    if (writing.current || busy || allowedFields === null) return
    const submittedDraft = { ...draft }
    writing.current = true; actions.begin(address); setError(undefined)
    void createRecord(assetId, data).then((result) => {
      writing.current = false
      actions.finish(address, result.ok ? { busy: false } : {
        busy: false, error: result.code, fields: (result.problems ?? []).map(problem => problem.field),
      }, result.ok)
      if (result.ok) {
        actions.invalidate(assetId)
        actions.clearIfUnchanged(assetId, submittedDraft)
        if (live.current) setDialog(false)
        if (!signal.aborted) openResource(businessAddress(assetId, 'detail', result.value.recordId), { replaceTab: true })
      }
    })
  }
  const failure = readError !== undefined ? <ReadFailure error={readError} copy={t} onRetry={() => { setAttempt(a => a + 1) }} /> : write?.error === undefined ? null : <div role="alert" className={css.notice}>
    <p>{t(write.error === 'KVVI_NOT_ALLOWED' ? 'form.denied' : (write.fields?.length ?? 0) > 0 ? 'form.fixFields' : 'form.writeFailed', { fields: (write.fields ?? []).map(code => model?.fields?.find(field => field.field_code === code)?.label ?? code).join('、') })}</p>
    <details><summary>{t('form.diagnostics')}</summary><code>{write.error}</code></details>
  </div>
  const form = view === undefined ? <p role="alert">{t('system.unrunnable', { detail: 'KVVI_RUNTIME_CONTRACT_INCOMPLETE' })}</p> :
    <KvviFormView spec={view} copy={t} context={fieldContextOf((model?.fields ?? []).filter(field => allowedFields?.some(visible => visible.field_code === field.field_code)).map(field => ({ ...field, type_config: { ...field.type_config, options: allowedFields?.find(visible => visible.field_code === field.field_code)?.options ?? [] } })), Object.fromEntries((model?.fields ?? []).map(field => [field.field_code, allowedFields?.some(visible => visible.field_code === field.field_code) === true ? 'VISIBLE' : 'HIDDEN'])))} values={draft ?? {}}
      onValuesChange={(values) => { actions.change(assetId, values) }} onSubmit={create} busy={busy} />
  return <section className={css.dockBody}>
    <header className={css.systemHeading}><h2 className={css.sectionTitle}>{projection?.system.name ?? t('panel.loading')}</h2></header>
    <nav className={css.viewTabs} aria-label={t('panel.aria')}>
      <Button variant={mode === 'form' ? 'primary' : 'ghost'} onClick={() => { open('form') }}>{t('dock.form')}</Button>
      <Button variant={mode === 'records' ? 'primary' : 'ghost'} onClick={() => { open('records') }}>{t('dock.records')}</Button>
      {mode === 'form' ? <Button variant="outline" disabled={allowedFields === null} onClick={() => { setDialog(true) }}>{t('dock.dialog')}</Button> : null}
    </nav>
    {failure}
    {notice === undefined ? null : <p role="status">{notice}</p>}
    {projection === null ? <p role="status">{t('panel.loading')}</p> : mode === 'form' ? (allowedFields === null ? null : dialog ? null : form) : mode === 'records' ?
      <KvviListView copy={t} fields={model?.fields} rows={page?.items ?? []} fieldVisibility={page?.fieldVisibility ?? {}}
        busy={page === null && error === undefined} {...(error === undefined ? {} : { error })}
        onOpen={(id) => { openResource(businessAddress(assetId, 'detail', id)) }} onRefresh={() => { setAttempt(a => a + 1) }} /> :
      detail === null ? null : <KvviRecordDetail key={detail.recordId + ':' + detail.rowVersion} copy={t} record={detail}
        fields={model?.fields} busy={busy} {...(error === undefined ? {} : { error })} {...(conflictVersion === undefined ? {} : { conflictRowVersion: conflictVersion })} onBack={() => { open('records') }}
        onSave={(data, rowVersion) => {
          if (writing.current || busy || recordId === undefined) return
          writing.current = true; actions.begin(address); setError(undefined)
          void updateRecord(assetId, recordId, data, rowVersion).then((result) => {
            writing.current = false
            actions.finish(address, result.ok ? { busy: false } : {
              busy: false, error: result.code,
              ...(result.currentRowVersion === undefined ? {} : { currentRowVersion: result.currentRowVersion }),
            }, result.ok)
            if (result.ok) actions.invalidate(assetId)
            if (live.current && !signal.aborted && result.ok) setNotice(t('detail.saved'))
          })
        }} />}
    {dialog ? <Modal open closeLabel={t('panel.close')} title={projection?.system.name ?? t('dock.form')} onClose={() => { setDialog(false) }}>
      {form}{failure}
    </Modal> : null}
  </section>
}

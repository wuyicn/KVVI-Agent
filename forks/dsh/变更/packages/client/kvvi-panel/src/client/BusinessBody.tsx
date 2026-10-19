/** Authenticated business content inside the original session-bound DSH tab. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { getRecord, listRecords, loadRuntime, readFormFields } from './api.ts'
import type { AuthorizedField, RecordPage, RecordView, RuntimeProjection, RecordWriteInput, RecordWriteResult } from './api.ts'
import { businessAddress, parseBusinessAddress } from './business-tabs.ts'
import type { createBusinessStore } from './business-store.ts'
import { KvviFormView, fieldContextOf } from './FormView.tsx'
import { KvviListView } from './ListView.tsx'
import { KvviRecordDetail } from './RecordDetail.tsx'
import { ReadFailure } from './ReadFailure.tsx'
import { coerceCreateData } from './values.ts'
import { RecordWriteGuard } from './RecordWriteGuard.tsx'
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
  presentation?: 'workbench' | 'dock'
  openResource: (address: string, options?: { replaceTab: boolean }) => void
}
/** One authorized renderer shared by the main business page and workspace dock. */
export function BusinessContent(props: BusinessContentProps) {
  const identity = props.useStore(state => state.identity)
  return <BusinessContentSession key={identity} {...props}/>
}
function BusinessContentSession({ address, signal, openResource, useStore, actions, t, presentation = 'dock' }: BusinessContentProps) {
  const identity = useStore(state => state.identity)
  const route = parseBusinessAddress(address)
  const draft = useStore(state => state.drafts[route?.assetId ?? ''])
  const selected = useStore(state => state.selections[route?.assetId ?? ''] ?? [])
  const [projection, setProjection] = useState<RuntimeProjection | null>(null)
  const [page, setPage] = useState<RecordPage | null>(null)
  const [allowedFields, setAllowedFields] = useState<AuthorizedField[] | null>(null)
  const write = useStore(state => state.writes[address])
  const revision = (write?.revision ?? 0) + useStore(state => state.revisions[route?.assetId ?? ''] ?? 0)
  const conflictVersion = write?.currentRowVersion
  const [detail, setDetail] = useState<RecordView | null>(null)
  const [readError, setError] = useState<string | undefined>()
  const error = readError ?? write?.error
  const [notice, setNotice] = useState<string | undefined>()
  const [attempt, setAttempt] = useState(0)
  const [dialog, setDialog] = useState(false)
  const [formError, setFormError] = useState<string | undefined>()
  const submittedCreate = useRef<{assetId: string; draft: Record<string, string>; identity: string | undefined}>()
  useEffect(() => {
    if (write?.error !== 'KVVI_FORM_ARCHIVED') return
    setDialog(false); setProjection(null); setPage(null); setDetail(null); setAllowedFields(null)
    setError('KVVI_FORM_ARCHIVED')
    globalThis.dispatchEvent(new Event('kvvi-business-directory-refresh'))
  }, [write?.error])
  useEffect(() => {
    const controller = new AbortController()
    setProjection(null); setAllowedFields(null); setPage(null); setDetail(null); setError(undefined); setNotice(undefined)
    if (route === null) { setError('KVVI_BAD_REQUEST'); return () => { controller.abort() } }
    const { assetId, mode, recordId } = route
    actions.select(assetId, [])
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
  useEffect(() => { setDialog(false); setFormError(undefined) }, [address])
  useEffect(() => {
    if (!dialog || route?.mode === 'form' || route === null) return
    const controller = new AbortController()
    setAllowedFields(null); setFormError(undefined)
    void readFormFields(route.assetId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setAllowedFields(result.value.fields); else setFormError(result.code)
    })
    return () => { controller.abort() }
  }, [dialog, address])
  if (route === null) return <ReadFailure error="KVVI_BAD_REQUEST" copy={t} onRetry={() => { setAttempt(a => a + 1) }} />
  const { assetId, mode } = route
  const model = projection?.models[assetId]
  const view = projection?.views[assetId]
  const formModes = Object.fromEntries((model?.fields ?? []).map(field => {
    const rawMode = allowedFields?.find(visible => visible.field_code === field.field_code)?.visibility ?? 'HIDDEN'
    const mode = ['VISIBLE', 'READONLY', 'MASKED'].includes(rawMode) ? rawMode : 'HIDDEN'
    return [field.field_code, mode === 'VISIBLE' && field.write_policy === 'SYSTEM' ? 'READONLY' : mode]
  }))
  const createFields = (model?.fields ?? []).filter(field => allowedFields?.some(visible => visible.field_code === field.field_code))
    .map(field => ({ ...field, type_config: { ...field.type_config, ...allowedFields?.find(visible => visible.field_code === field.field_code)?.type_config,
      options: allowedFields?.find(visible => visible.field_code === field.field_code)?.options ?? [] } }))
  const open = (next: 'form' | 'records') => { openResource(businessAddress(assetId, next)) }
  const create = (data: Record<string, string>, submit: (input: RecordWriteInput) => Promise<RecordWriteResult | undefined>) => {
    if (allowedFields === null || error === 'KVVI_FORM_ARCHIVED') return
    const converted = coerceCreateData(createFields, data, formModes)
    if (converted.invalidFields.length > 0) {
      actions.finish(address, { busy: false, error: 'KVVI_FIELD_TYPE_INVALID', fields: converted.invalidFields }, false, identity)
      return
    }
    submittedCreate.current = { assetId, draft: { ...draft }, identity }
    actions.finish(address, { busy: false }, false, identity); setError(undefined)
    void submit({ data: converted.data })
  }
  const reload = () => {
    actions.finish(address, { busy: false }, true, identity)
    actions.invalidate(assetId, identity); setAttempt(value => value + 1)
  }
  const created = (result: RecordWriteResult) => {
    // Both the initial submit and an explicit retry complete this occurrence.
    // Restored results use onView and never clear a newly entered draft.
    const submitted = submittedCreate.current
    if (submitted?.assetId === assetId) {
      actions.clearIfUnchanged(assetId, submitted.draft, submitted.identity)
      submittedCreate.current = undefined
    }
    actions.finish(address, { busy: false }, true, identity); actions.invalidate(assetId, identity)
    setDialog(false)
    if (!signal.aborted && presentation !== 'workbench') openResource(businessAddress(assetId, 'detail', result.recordId), { replaceTab: true })
  }
  const viewCreated = (result: RecordWriteResult) => {
    setDialog(false); actions.invalidate(assetId, identity)
    if (!signal.aborted) openResource(businessAddress(assetId, 'detail', result.recordId), { replaceTab: true })
  }
  const archived = (failure: { code: string }) => {
    if (failure.code === 'KVVI_FORM_ARCHIVED') actions.finish(address, { busy: false, error: failure.code }, false, identity)
  }
  const failure = readError !== undefined ? <ReadFailure error={readError} copy={t} onRetry={() => { setAttempt(a => a + 1) }} /> : write?.error === undefined ? null : <div role="alert" className={css.notice}>
    <p>{t(write.error === 'KVVI_FIELD_DUPLICATE' ? 'form.duplicate' : write.error === 'KVVI_UNIQUE_PUBLICATION_PENDING' ? 'form.rulesUpdating' : write.error === 'KVVI_NOT_ALLOWED' ? 'form.denied' : (write.fields?.length ?? 0) > 0 ? 'form.fixFields' : 'form.writeFailed', { fields: (write.fields ?? []).map(code => model?.fields?.find(field => field.field_code === code)?.label ?? code).join('、') })}</p>
    <details><summary>{t('form.diagnostics')}</summary><code>{write.error}</code></details>
  </div>
  const form = view === undefined ? <p role="alert">{t('system.unrunnable', { detail: 'KVVI_RUNTIME_CONTRACT_INCOMPLETE' })}</p> :
    <RecordWriteGuard target={{ assetId }} identity={identity} generation={revision + attempt} copy={t}
      onCommitted={created} onView={viewCreated} onFailure={archived} onReload={reload}>
      {({ busy, submit }) => <KvviFormView spec={view} copy={t} context={fieldContextOf(createFields, formModes)} values={draft ?? {}}
        onValuesChange={(values) => { actions.change(assetId, values) }} onSubmit={data => { create(data, submit) }} busy={busy} />}
    </RecordWriteGuard>
  if (error === 'KVVI_FORM_ARCHIVED') return <ReadFailure error={error} copy={t} onRetry={() => {
    actions.finish(address, { busy: false }, false, identity)
    setAttempt(a => a + 1)
  }}/>
  return <section className={css.dockBody}>
    <header className={css.systemHeading}><h2 className={css.sectionTitle}>{view?.name ?? model?.name ?? projection?.system.name ?? t('panel.loading')}</h2></header>
    {presentation === 'dock' ? <nav className={css.viewTabs} aria-label={t('panel.aria')}>
      <Button variant={mode === 'form' ? 'primary' : 'ghost'} onClick={() => { open('form') }}>{t('dock.form')}</Button>
      <Button variant={mode === 'records' ? 'primary' : 'ghost'} onClick={() => { open('records') }}>{t('dock.records')}</Button>
      {mode === 'form' ? <Button variant="outline" disabled={allowedFields === null} onClick={() => { setDialog(true) }}>{t('dock.dialog')}</Button> : null}
    </nav> : null}
    {failure}
    {notice === undefined ? null : <p role="status">{notice}</p>}
    {projection === null ? <p role="status">{t('panel.loading')}</p> : mode === 'form' ? (allowedFields === null ? null : dialog ? null : form) : mode === 'records' ?
      <KvviListView key={assetId} copy={t} fields={model?.fields} rows={page?.items ?? []} fieldVisibility={page?.fieldVisibility ?? {}}
        onSelection={(ids) => { actions.select(assetId, ids) }}
        selectedIds={selected}
        onCreate={() => { setDialog(true) }}
        busy={page === null && error === undefined} {...(error === undefined ? {} : { error })}
        onOpen={(id) => { openResource(businessAddress(assetId, 'detail', id)) }} onRefresh={() => { setAttempt(a => a + 1) }} /> :
      detail === null ? null : <RecordWriteGuard target={{ assetId, recordId: detail.recordId }} identity={identity}
        generation={revision + attempt} copy={t} onFailure={archived} onReload={reload}
        onCommitted={() => {
          actions.finish(address, { busy: false }, true, identity); actions.invalidate(assetId, identity)
          if (!signal.aborted) setNotice(t('detail.saved'))
        }}>
        {({ busy, submit }) => <KvviRecordDetail key={detail.recordId + ':' + detail.rowVersion} copy={t} record={detail}
          fields={model?.fields} busy={busy} {...(error === undefined ? {} : { error })} {...(conflictVersion === undefined ? {} : { conflictRowVersion: conflictVersion })} onBack={() => { open('records') }}
          onSave={(data, rowVersion) => {
            actions.finish(address, { busy: false }, false, identity); setError(undefined)
            void submit({ data, rowVersion })
          }} />}
      </RecordWriteGuard>}
    {dialog ? <Modal open closeLabel={t('panel.close')} title={projection?.system.name ?? t('dock.form')} onClose={() => { setDialog(false) }}>
      {formError === undefined ? allowedFields === null ? <p role="status">{t('panel.loading')}</p> : form : <ReadFailure error={formError} copy={t} onRetry={() => { setDialog(false) }}/>} {failure}
    </Modal> : null}
  </section>
}

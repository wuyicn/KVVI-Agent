/** Inert draft preview: local trial values never reach business record endpoints. */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { readEntrance, request } from './api.ts'
import type { ModelField, ViewSpec } from './api.ts'
import { fieldContextOf, KvviFormView } from './FormView.tsx'
import type { createBusinessStore } from './business-store.ts'
import css from './business.module.css'

interface DraftField extends ModelField {
  required: boolean
  default?: string
  constraints?: { trim?: boolean; min_length?: number; max_length?: number }
}
interface Draft {
  intentId: string
  digest: string
  assetId: string
  canSubmit: unknown
  validation: unknown
  model: { name: string; fields: DraftField[] }
  view: ViewSpec
  uniqueRules: string[][]
}
type Props = PropsLocale<'kvviPanel'> & PropsStore<ReturnType<typeof createBusinessStore>> & { intentId: string; running: boolean }

/** @param path - a workspace path, used as a hint only. @returns a managed intent hint; the server independently verifies ownership. */
export function previewIntent(path: string | undefined): string | undefined {
  return /\/business-workspaces\/[a-f0-9]{64}\/([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/?$/u.exec(path ?? '')?.[1]
}

/** @param intentId - server-owned build identity. @returns a tenant-free resource address, not access authority. */
export function previewAddress(intentId: string): string { return `dsh-resource://kvvi-draft/${intentId}` }

/** @param props - session and tab lifecycle provided by the slot framework. @returns the current session's preview only. */
export function BuilderPreviewBody(props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'kvviPanel'> & PropsStore<ReturnType<typeof createBusinessStore>>) {
  const { tab } = props.useTabInfo()
  const cwd = props.useSessions(s => s.byId[props.sessionId]?.cwd)
  const running = props.useSession(s => s.running)
  const intentId = previewIntent(cwd)
  if (intentId === undefined || tab.navigation.address !== previewAddress(intentId)) return <p role="alert">{props.t('preview.unavailable')}</p>
  return <BuilderPreview {...props} intentId={intentId} running={running}/>
}

/** @param props - current managed draft identity and session-scoped trial state. @returns a preview, never a publishable form. */
export function BuilderPreview({ intentId, running, useStore, actions, t }: Props) {
  const [loaded, setLoaded] = useState<{ intent: string; draft: Draft; identity: string }>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [checking, setChecking] = useState(true)
  const [trialError, setTrialError] = useState<string>()
  const [success, setSuccess] = useState(false)
  const [examples, setExamples] = useState<Record<string, string>[]>([])
  const identity = useStore(s => s.identity)
  const draft = loaded?.intent === intentId && loaded.identity === identity ? loaded.draft : undefined
  const key = `preview:${intentId}:${draft?.digest ?? ''}`
  const saved = useStore(s => s.drafts[key])
  const values = saved ?? Object.fromEntries((draft?.model.fields ?? []).map(f => [f.field_code, f.default ?? '']))
  useEffect(() => {
    const controller = new AbortController()
    const cancelled = () => controller.signal.aborted
    setChecking(true); setError(undefined)
    void (async () => {
      const entrance = await readEntrance(controller.signal)
      if (cancelled()) return
      if (!entrance.ok || entrance.value.gateway !== 'BUILDER') { setLoaded(undefined); setError('builder'); return }
      const current = JSON.stringify([entrance.value.companyId, entrance.value.userId, entrance.value.sessionId])
      actions.identify(current)
      const result = await request<Draft>('GET', '/api/kvvi-builder-preview/' + encodeURIComponent(intentId), undefined, controller.signal, '')
      if (cancelled()) return
      if (!result.ok) { setError(result.code); return }
      if (result.value.intentId !== intentId || result.value.canSubmit !== false || result.value.validation !== 'not_checked') { setError('KVVI_BAD_RESPONSE'); return }
      setLoaded({ intent: intentId, identity: current, draft: result.value })
    })().catch(() => { if (!controller.signal.aborted) setError('KVVI_NETWORK_ERROR') })
      .finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => { controller.abort() }
  }, [intentId, running, attempt, actions])
  useEffect(() => { setExamples([]); setTrialError(undefined); setSuccess(false) }, [intentId, draft?.digest, identity])
  const check = (input: Record<string, string>) => {
    if (!draft || checking || running) return
    setSuccess(false); setTrialError(undefined)
    const normalized: Record<string, string> = {}
    for (const field of draft.model.fields) {
      const raw = input[field.field_code] ?? '', value = field.constraints?.trim ? raw.trim() : raw
      normalized[field.field_code] = value
      let invalid = field.required && !value
      if (value) {
        const length = Array.from(value).length
        invalid ||= length < (field.constraints?.min_length ?? 0) || length > (field.constraints?.max_length ?? Infinity)
        if (field.type === 'single_select') invalid ||= !field.type_config?.options?.some(o => o.code === value)
        if (field.type === 'date') {
          const date = new Date(value + 'T00:00:00Z')
          invalid ||= !/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value
        }
      }
      if (invalid) { setTrialError(t('preview.invalidField', { field: field.label ?? field.field_code })); return }
    }
    for (const rule of draft.uniqueRules) {
      if (rule.every(f => normalized[f] !== '') && examples.some(row => rule.every(f => row[f] === normalized[f]))) {
        setTrialError(t('preview.duplicate', { field: rule.map(f => draft.model.fields.find(v => v.field_code === f)?.label ?? f).join('、') })); return
      }
    }
    setExamples(rows => [...rows.slice(-99), normalized]); setSuccess(true)
  }
  return <section className={css.dockBody} aria-label={t('preview.title')}>
    <header className={css.workbenchHeader}><h2>{draft?.view.name ?? t('preview.title')}</h2>
      <Button disabled={checking || running} onClick={() => { setAttempt(v => v + 1) }}>{t('preview.refresh')}</Button></header>
    <p>{t('preview.explanation')}</p>
    <p role="status">{running ? t('preview.updating') : checking ? t('panel.loading') : t('preview.notChecked')}</p>
    {error === undefined ? null : <p role="alert">{t(error === 'builder' ? 'preview.builderRequired' : 'preview.unavailable')}</p>}
    {draft === undefined ? null : <>
      <KvviFormView spec={draft.view} context={fieldContextOf(draft.model.fields.map(f => ({ ...f,
        label: (f.label ?? f.field_code) + (f.required ? t('preview.required') : ''),
        ...(f.type_config?.options === undefined ? {} : { type_config: { options: f.type_config.options.filter(o => !('enabled' in o) || o.enabled !== false) } }),
      })))} values={values} onValuesChange={(next) => { actions.change(key, next); setSuccess(false); setTrialError(undefined) }}
      copy={(k, p) => k === 'form.submit' ? t('preview.check') : t(k, p)} onSubmit={check} busy={checking || running}/>
      {draft.uniqueRules.length ? <p>{t('preview.unique', { field: draft.uniqueRules.map(r => r.map(f => draft.model.fields.find(v => v.field_code === f)?.label ?? f).join(' + ')).join('；') })}</p> : null}
      {trialError === undefined ? null : <p role="alert">{trialError}</p>}
      {success ? <p role="status">{t('preview.passed')}</p> : null}
      <Button onClick={() => { actions.change(key, {}); setExamples([]); setTrialError(undefined); setSuccess(false) }}>{t('preview.clear')}</Button>
      <p>{t('preview.permissions')}</p><Button disabled>{t('preview.confirm')}</Button>
    </>}
  </section>
}

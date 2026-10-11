/** Business data takes the main area; the original Conversation is an optional assistant. */
import { useEffect, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { adminCapabilities, readEntrance, loadRuntime } from './api.ts'
import { createBuildIntent, loadDirectory, type BusinessForm, type Directory } from './business-directory-api.ts'
import { BusinessDirectory } from './BusinessDirectory.tsx'
import { BusinessDirectoryDialogs, type DirectoryDialog } from './BusinessDirectoryDialogs.tsx'
import type { PublishedSystem } from './api.ts'
import { BusinessActivity } from './BusinessActivity.tsx'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BusinessContent } from './BusinessBody.tsx'
import { businessAddress, parseBusinessAddress } from './business-tabs.ts'
import type { createBusinessStore } from './business-store.ts'
import { ReadFailure } from './ReadFailure.tsx'
import css from './business.module.css'
export interface BusinessPageInjected {
  enterBuilder: () => Promise<void>
  consumeBuildResume?: () => boolean
  startBuilder: (name: string, intentId: string) => Promise<void>
  designBusiness: (assetId: string, workspaceId?: string) => Promise<void>
  back: () => void
  manage: () => void
  bindBusiness: (
    system: PublishedSystem, current: SessionId | undefined, workspaceId: string | undefined, signal: AbortSignal,
  ) => Promise<SessionReference | undefined>
}
export type BusinessPageProps = PropsRuntime<'main'> & PropsLocale<'kvviPanel'> & PropsStore<ReturnType<typeof createBusinessStore>> & PropsRenderSlots<'kvvi.business.session'> & PropsRenderFactories & BusinessPageInjected
export function BusinessPage({ t, back, manage, bindBusiness, useSessions, useWorkspaces,
  SessionProvider, renderSlot, useStore, actions, startBuilder, designBusiness, enterBuilder, consumeBuildResume }: BusinessPageProps) {
  const current = useSessions(state => Object.values(state.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id)
  const workspaces = useWorkspaces(state => state.items)
  const [directory, setDirectory] = useState<Directory>({ groups: [], forms: [] })
  const [system, setSystem] = useState<BusinessForm | null>(null)
  const [session, setSession] = useState<SessionReference | undefined>()
  const [address, setAddress] = useState('')
  const [query, setQuery] = useState('')
  const [ai, setAI] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [archived, setArchived] = useState(false)
  const [dialog, setDialog] = useState<DirectoryDialog>()
  const [auditPending, setAuditPending] = useState(false)
  const [workspaceId, setWorkspaceId] = useState('')
  const [canAdmin, setCanAdmin] = useState(false)
  const [builder, setBuilder] = useState(false)
  const [canBuild, setCanBuild] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState(false)
  const [buildGroup, setBuildGroup] = useState('')
  const [designing, setDesigning] = useState(false)
  const buildOperation = useRef<{ group: string; name: string; id: string }>()
  const buildInFlight = useRef(false)
  const [entering, setEntering] = useState(false)
  const collapsed = useStore(s => s.collapsed)
  const selection = useRef<BusinessForm | null>(null)
  const identity = useRef('')
  const navigation = useRef(0)
  const association = useRef<AbortController | undefined>()
  useEffect(() => {
    const controller = new AbortController()
    setError(undefined); setLoading(true)
    void (async () => {
      const entrance = await readEntrance(controller.signal)
      if (controller.signal.aborted) return
      if (!entrance.ok) {
        clearSelection(); clearBuilderDraft(); setDirectory({ groups: [], forms: [] }); setBuilder(false); setCanBuild(false); setCanAdmin(false); actions.identify(''); identity.current = ''; setError(entrance.code); setLoading(false); return
      }
      const scope = JSON.stringify([entrance.value.companyId, entrance.value.userId, entrance.value.sessionId, entrance.value.gateway])
      if (identity.current !== scope) {
        clearSelection(); clearBuilderDraft(); setDirectory({ groups: [], forms: [] }); setQuery(''); actions.identify(scope); identity.current = scope
      }
      const activeBuilder = entrance.value.gateway === 'BUILDER'
      setBuilder(activeBuilder); setCanBuild(activeBuilder || entrance.value.allowedGateways?.includes('BUILDER') === true)
      if (archived && !activeBuilder) { setArchived(false); return }
      const result = await loadDirectory({ archived, signal: controller.signal })
      if (controller.signal.aborted) return
      setLoading(false)
      if (!result.ok) { clearSelection(); setDirectory({ groups: [], forms: [] }); setError(result.code); return }
      setDirectory(result.value)
      if (activeBuilder && consumeBuildResume?.()) {
        setCreating(true)
      }
      const next = result.value.forms.find(f => f.assetId === selection.current?.assetId) ?? result.value.forms[0]
      if (next === undefined) clearSelection()
      else if (next.assetId !== selection.current?.assetId || next.archived !== selection.current.archived
        || next.actions.join() !== selection.current.actions.join()) enter(next)
      else { selection.current = next; setSystem(next) }
    })()
    void adminCapabilities(controller.signal).then((result) => { if (!controller.signal.aborted && result.ok) setCanAdmin(result.value.role === 'owner' || result.value.role === 'admin') })
    return () => { controller.abort() }
  }, [attempt, archived])
  useEffect(() => {
    const refresh = () => { setAttempt(v => v + 1) }
    globalThis.addEventListener('focus', refresh)
    globalThis.addEventListener('kvvi-business-directory-refresh', refresh)
    return () => {
      globalThis.removeEventListener('focus', refresh)
      globalThis.removeEventListener('kvvi-business-directory-refresh', refresh)
    }
  }, [])
  useEffect(() => () => { navigation.current++; association.current?.abort() }, [])
  useEffect(() => () => { session?.release() }, [session])
  const enter = (next: BusinessForm, selectedWorkspace?: string) => {
    association.current?.abort()
    const controller = new AbortController()
    association.current = controller
    const token = ++navigation.current
    selection.current = next; setSystem(next); setAI(false); setSession(undefined); setBusy(false); setError(undefined)
    setAddress(businessAddress(next.assetId, next.actions.includes('read') ? 'records' : 'form'))
    setWorkspaceId(selectedWorkspace ?? '')
    if (next.archived || !next.actions.length) return
    setBusy(true)
    const published: PublishedSystem = {
      assetId: next.assetId, systemId: next.systemId, name: next.name, schemaCode: next.schemaCode, publishedAt: next.publishedAt,
    }
    void bindBusiness(published, current, selectedWorkspace, controller.signal).then((id) => {
      if (token !== navigation.current) { id?.release(); return }
      setSession(id); setBusy(false)
      if (id === undefined) setError(t('business.workspaceMissing'))
    }).catch(() => { if (token === navigation.current) { setBusy(false); setError(t('business.workspaceMissing')) } })
  }
  const clearSelection = () => {
    navigation.current++; association.current?.abort()
    selection.current = null
    setSystem(null); setSession(undefined); setAI(false); setBusy(false); setError(undefined)
  }
  const clearBuilderDraft = () => {
    setDialog(undefined); setCreating(false); setName(''); setBuildError(false); setAuditPending(false)
    setDesigning(false); setBuildGroup(''); setBuilding(false); buildOperation.current = undefined
  }
  const beginBuild = async () => {
    if (buildInFlight.current || building) return
    buildInFlight.current = true
    setBuilding(true); setBuildError(false)
    const scope = identity.current
    if (buildOperation.current?.group !== buildGroup || buildOperation.current.name !== name.trim()) {
      buildOperation.current = { group: buildGroup, name: name.trim(), id: randomUUID() }
    }
    try {
      const result = await createBuildIntent(buildGroup || null, buildOperation.current.id)
      if (identity.current !== scope) return
      if (!result.ok || !result.value.intentId) { setBuildError(true); return }
      await startBuilder(name.trim(), result.value.intentId)
      if (identity.current === scope) { setCreating(false); setName(''); buildOperation.current = undefined }
    } catch (_error) { if (identity.current === scope) setBuildError(true) }
    finally { buildInFlight.current = false; if (identity.current === scope) setBuilding(false) }
  }
  const newForm = async () => {
    if (entering) return
    if (builder) { setCreating(true); setBuildGroup(system?.groupId ?? ''); setBuildError(false); return }
    setEntering(true); setBuildError(false)
    try { await enterBuilder() }
    catch (_error) { setBuildError(true) }
    finally { setEntering(false) }
  }
  const editForm = async (chosenWorkspace?: string) => {
    if (system === null || building) return
    const scope = identity.current
    setBuilding(true); setBuildError(false)
    try { await designBusiness(system.assetId, chosenWorkspace); if (identity.current === scope) setDesigning(false) }
    catch (_error) { if (identity.current === scope) { setDesigning(true); setBuildError(true) } }
    finally { if (identity.current === scope) setBuilding(false) }
  }
  return <section className={css.workbench}>
    <header className={css.workbenchHeader}><div><h1>{t('panel.title')}</h1><p className={css.hint}>{t('panel.subtitle')}</p></div><div className={css.directoryActions}>
      {canAdmin ? <Button variant="ghost" onClick={manage}>{t('admin.title')}</Button> : null}
      {builder ? <><Button variant="outline" onClick={() => { setDialog({ action: 'group.create', input: {} }) }}>{t('directory.newGroup')}</Button><Button variant="ghost" aria-pressed={archived} onClick={() => { clearSelection(); setArchived(!archived) }}>{t(archived ? 'directory.active' : 'directory.archived')}</Button></> : null}
      {canBuild ? <Button variant="primary" icon={<IconPlusOutline16/>} disabled={entering} onClick={() => { void newForm() }}>{t('directory.newForm')}</Button> : null}
      <Button variant="ghost" onClick={() => { setAttempt(v => v + 1) }}>{t('directory.refresh')}</Button><Button variant="ghost" onClick={back}>{t('panel.close')}</Button>
    </div></header>
    {error !== undefined && (system === null || error.startsWith('KVVI_')) ? <ReadFailure error={error} copy={t} onRetry={() => { setAttempt(v => v + 1) }}/> : null}
    {auditPending ? <p role="status" className={css.notice}>{t('directory.auditPending')}</p> : null}
    <div className={css.workbenchBody} data-ai-open={ai || undefined}>
      <BusinessDirectory {...directory} {...(system === null ? {} : { selectedAssetId: system.assetId })}
        query={query} builder={builder} collapsed={collapsed} copy={t}
        onQuery={setQuery} onSelect={enter} onCollapse={actions.collapse} onManage={(action, group) => {
          setDialog({ action, input: { target: group.groupId, name: group.name, expectedVersion: group.version } })
        }}/>
      <div className={css.businessWorkspace}>
        {system !== null ? <div className={css.formManagement}><strong>{system.name}</strong><div>
          {builder ? <>{!archived ? <Button variant="ghost" onClick={() => { setDialog({ action: 'form.move', input: { target: system.assetId, expectedVersion: system.version, groupId: system.groupId } }) }}>{t('directory.move')}</Button> : null}<Button variant="ghost" onClick={() => { setDialog({ action: archived ? 'form.restore' : 'form.archive', input: { target: system.assetId, expectedVersion: system.version } }) }}>{t(archived ? 'directory.restore' : 'directory.archive')}</Button></> : null}
          {!archived ? <>
            {builder ? <Button variant="outline" disabled={busy || building} onClick={() => { void editForm() }}>{t('business.design')}</Button> : null}
            <Button variant="outline" disabled={session === undefined || busy} aria-pressed={ai} onClick={() => { setAI(!ai) }}>{t(ai ? 'business.ai.close' : 'business.ai')}</Button></> : null}
        </div></div> : null}
        <div className={css.businessWorkspaceBody}>
          {loading ? <p role="status">{t('panel.loading')}</p> : system === null ? <p className={css.empty}>{t('directory.empty')}</p> : archived ? <p className={css.empty}>{t('directory.archivedHint')}</p> : !system.actions.length ? <p className={css.empty}>{t('directory.managementOnly')}</p> : busy ? <p role="status">{t('business.connecting')}</p> : session === undefined ? <div className={css.primaryBusiness}>
            <div className={css.association}><p className={css.hint}>{error}</p><label>{t('business.workspace')}<select className={css.control} aria-label={t('business.workspace')} value={workspaceId} onChange={(e) => { if (e.target.value) enter(system, e.target.value) }}><option value="">{t('business.workspace.choose')}</option>{workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId}>{w.title}</option>)}</select></label></div>
            <StandaloneBusiness t={t} useStore={useStore} actions={actions} address={address} navigate={setAddress}/>
          </div> : <SessionProvider session={session}>
            <div className={css.primaryBusiness}>{renderSlot('kvvi.business.session', { identity: identity.current, address, navigate: setAddress })}</div>
            {ai ? <aside className={css.assistantPane} aria-label={t('business.ai')}><div className={css.assistantHeading}><strong>{t('business.ai')}</strong><Button variant="ghost" onClick={() => { setAI(false) }}>{t('business.ai.close')}</Button></div>{renderSlot('kvvi.business.session', { identity: identity.current, address, navigate: setAddress, assistant: true })}</aside> : null}
          </SessionProvider>}
        </div></div>
    </div>
    {dialog ? <BusinessDirectoryDialogs dialog={dialog} groups={directory.groups} copy={t} onClose={() => { setDialog(undefined) }}
      onCommitted={(pending) => { setAuditPending(pending); setDialog(undefined); setAttempt(v => v + 1) }}
      onConflict={() => { setAttempt(v => v + 1) }}/> : null}
    {buildError && !creating ? <p role="alert" className={css.notice}>{t('business.buildFailed')}</p> : null}
    {designing ? <Modal open title={t('business.design')} closeLabel={t('panel.close')} onClose={() => { if (!building) setDesigning(false) }}>
      <p>{t('business.editWorkspaceHint')}</p>
      <label className={css.field}>{t('business.workspace')}<select className={css.control} value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value) }}><option value="">{t('business.workspace.choose')}</option>{workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId}>{w.title}</option>)}</select></label>
      <Button variant="primary" disabled={building || !workspaceId} onClick={() => { void editForm(workspaceId) }}>{t('business.design')}</Button>
    </Modal> : null}
    {creating ? <Modal open title={t('business.new')} closeLabel={t('panel.close')} onClose={() => { if (!building) setCreating(false) }}>
      <p className={css.hint}>{t('business.buildHint')}</p>
      {buildError ? <p role="alert">{t('business.buildFailed')}</p> : null}
      <label className={css.field}>{t('business.name')}<input className={css.control} value={name} disabled={building} placeholder={t('business.nameOptional')} onChange={(e) => { setName(e.target.value) }} maxLength={80}/></label>
      <label className={css.field}>{t('business.buildGroup')}<select className={css.control} value={buildGroup} disabled={building} onChange={(e) => { setBuildGroup(e.target.value) }}><option value="">{t('directory.ungrouped')}</option>{directory.groups.map(g => <option key={g.groupId} value={g.groupId}>{g.name}</option>)}</select></label>
      <div className={css.formActions}><Button variant="primary" disabled={building} onClick={() => { void beginBuild() }}>{t('business.startBuild')}</Button></div>
    </Modal> : null}
  </section>
}
function StandaloneBusiness({ address, navigate, ...props }: Pick<BusinessPageProps, 't' | 'useStore' | 'actions'> & {
  address: string
  navigate: (address: string) => void
}) {
  const lifetime = useRef(new AbortController())
  const currentAddress = useRef(address)
  currentAddress.current = address
  useEffect(() => { const controller = lifetime.current; return () => { controller.abort() } }, [])
  return <BusinessContent {...props} address={address} signal={lifetime.current.signal} presentation="workbench"
    openResource={(next) => { if (currentAddress.current === address) navigate(next) }}/>
}
export interface BusinessSessionInjected {
  hooks: { businessComposerBlock: SnapshotStore<ComposerBlock | undefined> }
  insertContext: (text: string, revision: number) => void
}
export type BusinessSessionProps = PropsRuntime<'kvvi.business.session'> & PropsLocale<'kvviPanel'> & PropsStore<ReturnType<typeof createBusinessStore>> & PropsRenderFactories & InjectFace<BusinessSessionInjected>
export function BusinessSession({ address, navigate, assistant, ...props }: BusinessSessionProps) {
  const authenticated = props.useStore(state => state.identity)
  useEffect(() => { props.actions.identify(props.identity) }, [props.identity, props.actions])
  const lifetime = useRef(new AbortController())
  const currentAddress = useRef(address)
  currentAddress.current = address
  useEffect(() => { const controller = lifetime.current; return () => { controller.abort() } }, [])
  if (authenticated !== props.identity) return null
  return assistant ? <BusinessAssistant {...props} address={address}/> : <>
    <BusinessActivity {...props} afterWrite={() => {}}/>
    <BusinessContent {...props} address={address} signal={lifetime.current.signal} presentation="workbench"
      openResource={(next) => { if (currentAddress.current === address) navigate(next) }}/>
  </>
}
/** Put business references into the visible draft; submission remains the original logged Conversation path. */
function BusinessAssistant(props: Omit<BusinessSessionProps, 'navigate' | 'assistant'>) {
  const route = parseBusinessAddress(props.address)
  const assetId = route?.assetId
  const [title, setTitle] = useState<string | undefined>()
  const input = props.useInput(s => s)
  const blocked = props.useBusinessComposerBlock(s => s) !== undefined
  const selected = props.useStore(s => s.selections[assetId ?? ''] ?? [])
  const recordIds = route?.mode === 'detail' && route.recordId !== undefined ? [route.recordId] : selected
  useEffect(() => {
    const controller = new AbortController()
    setTitle(undefined)
    if (assetId !== undefined) void loadRuntime(assetId, controller.signal).then((result) => {
      if (!controller.signal.aborted && result.ok) {
        setTitle(result.value.views?.[assetId]?.name ?? result.value.models?.[assetId]?.name ?? result.value.system.name)
      }
    })
    return () => { controller.abort() }
  }, [assetId])
  const ask = () => {
    if (assetId === undefined || title === undefined || input.phase !== 'plain' || blocked) return
    const context = props.t('business.ai.context', { name: title, assetId })
      + (recordIds.length === 0 ? '' : '\n' + props.t('business.ai.records', { ids: JSON.stringify(recordIds) }))
    props.insertContext(context + '\n\n', input.draftRev)
  }
  return <div className={css.assistantContent}>
    <section className={css.contextCard} aria-label={props.t('business.ai.current')}>
      <span className={css.hint}>{props.t('business.ai.current')}</span>
      <strong>{title ?? props.t('panel.loading')}</strong>
      <span className={css.hint}>{recordIds.length === 0 ? props.t('business.ai.hint') : props.t('list.selected', { count: recordIds.length })}</span>
      <Button variant="outline" disabled={title === undefined || input.phase !== 'plain' || blocked} onClick={ask}>{props.t(recordIds.length === 0 ? 'business.ai.askForm' : 'business.ai.askRecords')}</Button>
    </section>
    {props.renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false, composerPlaceholder: props.t('business.ai.placeholder') }, {
      slots: { views: BusinessConversationView },
    })}</div>
}
function BusinessConversationView({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', { view: 'chat' })
}
export function BusinessIcon({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M8 5V3h8v2M3 10h18M9 10v3h6v-3"/></svg>
}

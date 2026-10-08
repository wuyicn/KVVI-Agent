/** Business data takes the main area; the original Conversation is an optional assistant. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Modal, IconPlusOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { listSystems, adminCapabilities, readEntrance, loadRuntime } from './api.ts'
import type { PublishedSystem } from './api.ts'
import { BusinessActivity } from './BusinessActivity.tsx'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BusinessContent } from './BusinessBody.tsx'
import { businessAddress } from './business-tabs.ts'
import type { createBusinessStore } from './business-store.ts'
import { ReadFailure } from './ReadFailure.tsx'
import css from './business.module.css'
export interface BusinessPageInjected {
  pickDirectory: () => Promise<string | null>
  startBuilder: (parent: string, name: string, purpose: string) => Promise<void>
  designBusiness: (workspaceId: string) => Promise<void>
  back: () => void
  manage: () => void
  bindBusiness: (system: PublishedSystem, current?: SessionId, workspaceId?: string) => Promise<SessionReference | undefined>
}
export type BusinessPageProps = PropsRuntime<'main'> & PropsLocale<'kvviPanel'> & PropsStore<ReturnType<typeof createBusinessStore>> & PropsRenderSlots<'kvvi.business.session'> & PropsRenderFactories & BusinessPageInjected
export function BusinessPage({ t, back, manage, bindBusiness, useSessions, useWorkspaces,
  SessionProvider, renderSlot, useStore, actions, pickDirectory, startBuilder, designBusiness }: BusinessPageProps) {
  const current = useSessions(state => Object.values(state.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id)
  const workspaces = useWorkspaces(state => state.items)
  const [systems, setSystems] = useState<PublishedSystem[]>([])
  const [system, setSystem] = useState<PublishedSystem | null>(null)
  const [session, setSession] = useState<SessionReference | undefined>()
  const [address, setAddress] = useState('')
  const [query, setQuery] = useState('')
  const [ai, setAI] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [workspaceId, setWorkspaceId] = useState('')
  const [canAdmin, setCanAdmin] = useState(false)
  const [builder, setBuilder] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [parent, setParent] = useState('')
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState(false)
  const [pageQuery, setPageQuery] = useState('')
  const [formName, setFormName] = useState('')
  const navigation = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    setError(undefined)
    void listSystems(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setSystems(result.value.items); else setError(result.code)
    })
    void readEntrance(controller.signal).then((result) => { if (!controller.signal.aborted) setBuilder(result.ok && result.value.gateway === 'BUILDER') })
    void adminCapabilities(controller.signal).then((result) => { if (!controller.signal.aborted && result.ok) setCanAdmin(result.value.role === 'owner' || result.value.role === 'admin') })
    return () => { controller.abort() }
  }, [attempt])
  useEffect(() => () => { navigation.current++ }, [])
  useEffect(() => () => { session?.release() }, [session])
  const enter = (next: PublishedSystem, selectedWorkspace?: string) => {
    const token = ++navigation.current
    setFormName(next.name); setPageQuery(''); setSystem(next); setAI(false); setSession(undefined); setBusy(true); setError(undefined)
    void loadRuntime(next.assetId).then((result) => {
      if (navigation.current === token && result.ok) {
        setFormName(result.value.views?.[next.assetId]?.name ?? result.value.models?.[next.assetId]?.name ?? next.name)
      }
    })
    setAddress(businessAddress(next.assetId, 'records'))
    setWorkspaceId(selectedWorkspace ?? '')
    void bindBusiness(next, current, selectedWorkspace).then((id) => {
      if (token !== navigation.current) { id?.release(); return }
      setSession(id); setBusy(false)
      if (id === undefined) setError(t('business.workspaceMissing'))
    }).catch(() => { if (token === navigation.current) { setBusy(false); setError(t('business.workspaceMissing')) } })
  }
  const home = () => { navigation.current++; setSystem(null); setSession(undefined); setAI(false); setBusy(false); setError(undefined) }
  return <section className={css.workbench}>
    <header className={css.workbenchHeader}><div>{system === null ? null : <div className={css.breadcrumb}><button type="button" onClick={home}>{t('panel.title')}</button><span>/</span><span>{system.name}</span></div>}<h1>{system?.name ?? t('panel.title')}</h1>{system === null ? <p className={css.hint}>{t('panel.subtitle')}</p> : null}</div><div>
      {system === null ? <>{canAdmin ? <Button variant="ghost" onClick={manage}>{t('admin.title')}</Button> : null}{builder ? <Button variant="primary" icon={<IconPlusOutline16/>} onClick={() => { setCreating(true); setBuildError(false) }}>{t('business.new')}</Button> : null}<Button variant="ghost" onClick={back}>{t('panel.close')}</Button></> : <>
        {builder ? <Button variant="outline" disabled={session === undefined || busy || building} onClick={() => { if (session === undefined) return; const w = workspaces.find(w => w.sessionIds.includes(session.sessionId)); if (w === undefined) return; setBuilding(true); void designBusiness(w.workspaceId).catch(() => { setBuildError(true) }).finally(() => { setBuilding(false) }) }}>{t('business.design')}</Button> : null}
        <Button variant="outline" disabled={session === undefined || busy} aria-pressed={ai} onClick={() => { setAI(!ai) }}>{t(ai ? 'business.ai.close' : 'business.ai')}</Button></>}
    </div></header>
    {system === null ? <div className={css.directory}>
      <label className={css.searchBox}><IconSearchOutline16/><input aria-label={t('business.search')} placeholder={t('business.search')} value={query} onChange={(e) => { setQuery(e.target.value) }}/></label>
      {error === undefined ? null : <ReadFailure error={error} copy={t} onRetry={() => { setAttempt(v => v + 1) }}/>}
      <div className={css.directoryTable}><table><thead><tr>{['business.name', 'business.contents', 'business.status', 'business.actions'].map(key => <th key={key}>{t(key as 'business.name')}</th>)}</tr></thead><tbody>{systems.filter(s => s.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(s => <tr key={s.systemId}><td><div className={css.businessName}><span className={css.businessChip}><BusinessIcon size={24}/></span><div><strong>{s.name}</strong><p className={css.hint}>{t('systems.hint')}</p></div></div></td><td>{t('business.formCount')}</td><td><span className={css.published}>{t('business.published')}</span></td><td><Button variant="outline" onClick={() => { enter(s) }}>{t('business.enter')}</Button></td></tr>)}</tbody></table></div>
      {!systems.length && error === undefined ? <p className={css.empty}>{t('systems.empty')}</p> : null}
    </div> : <div className={css.workbenchBody} data-ai-open={ai || undefined}>
      <aside className={css.resourceDirectory} aria-label={t('business.pages')}>
        <label className={css.searchBox}><IconSearchOutline16/><input aria-label={t('business.searchPages')} placeholder={t('business.searchPages')} value={pageQuery} onChange={(e) => { setPageQuery(e.target.value) }}/></label>
        {formName.toLocaleLowerCase().includes(pageQuery.toLocaleLowerCase()) ? <Button className={css.resourceActive} variant="ghost" onClick={() => { setAddress(businessAddress(system.assetId, 'records')) }}>{formName}</Button> : null}
      </aside>
      {busy ? <p role="status">{t('business.connecting')}</p> : session === undefined ? <div className={css.primaryBusiness}>
        <div className={css.association}><p className={css.hint}>{error}</p><label>{t('business.workspace')}<select className={css.control} aria-label={t('business.workspace')} value={workspaceId} onChange={(e) => { if (e.target.value) enter(system, e.target.value) }}><option value="">{t('business.workspace.choose')}</option>{workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId}>{w.title}</option>)}</select></label></div>
        <StandaloneBusiness t={t} useStore={useStore} actions={actions} address={address} navigate={setAddress}/>
      </div> : <SessionProvider session={session}>
        <div className={css.primaryBusiness}>{renderSlot('kvvi.business.session', { address, navigate: setAddress })}</div>
        {ai ? <aside className={css.assistantPane} aria-label={t('business.ai')}><div className={css.assistantHeading}><strong>{t('business.ai')}</strong><Button variant="ghost" onClick={() => { setAI(false) }}>{t('business.ai.close')}</Button></div>{renderSlot('kvvi.business.session', { address, navigate: setAddress, assistant: true })}</aside> : null}
      </SessionProvider>}
    </div>}
    {buildError && !creating ? <p role="alert" className={css.notice}>{t('business.buildFailed')}</p> : null}
    {creating ? <Modal open title={t('business.new')} closeLabel={t('panel.close')} onClose={() => { if (!building) setCreating(false) }}>
      <p className={css.hint}>{t('business.buildHint')}</p>
      {buildError ? <p role="alert">{t('business.buildFailed')}</p> : null}
      <label className={css.field}>{t('business.name')}<input className={css.control} value={name} onChange={(e) => { setName(e.target.value) }} maxLength={80}/></label>
      <label className={css.field}>{t('business.purpose')}<textarea className={css.control} value={purpose} onChange={(e) => { setPurpose(e.target.value) }}/></label>
      <label className={css.field}>{t('business.folder')}<input className={css.control} value={parent} readOnly/></label>
      <Button variant="outline" disabled={building} onClick={() => { void pickDirectory().then((path) => { if (path !== null) setParent(path) }).catch(() => { setBuildError(true) }) }}>{t('business.chooseFolder')}</Button>
      <div className={css.formActions}><Button variant="primary" disabled={building || !name.trim() || !purpose.trim() || !parent || /[\\/]/u.test(name)} onClick={() => { setBuilding(true); setBuildError(false); void startBuilder(parent, name.trim(), purpose.trim()).catch(() => { setBuildError(true) }).finally(() => { setBuilding(false) }) }}>{t('business.startBuild')}</Button></div>
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
export type BusinessSessionProps = PropsRuntime<'kvvi.business.session'> & PropsLocale<'kvviPanel'> & PropsStore<ReturnType<typeof createBusinessStore>> & PropsRenderFactories
export function BusinessSession({ address, navigate, assistant, ...props }: BusinessSessionProps) {
  const lifetime = useRef(new AbortController())
  const currentAddress = useRef(address)
  currentAddress.current = address
  useEffect(() => { const controller = lifetime.current; return () => { controller.abort() } }, [])
  return assistant ? <BusinessAssistant {...props}/> : <>
    <BusinessActivity {...props} afterWrite={() => {}}/>
    <BusinessContent {...props} address={address} signal={lifetime.current.signal} presentation="workbench"
      openResource={(next) => { if (currentAddress.current === address) navigate(next) }}/>
  </>
}
function BusinessAssistant(props: Omit<BusinessSessionProps, 'address' | 'navigate' | 'assistant'>) {
  const session = props.useSession(s => s)
  const conversation = props.useConversation(s => s)
  const blank = props.useSessions(s => s.byId[props.sessionId]?.blank)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const settling = shellPhase === 'blank' && session.openState === 'loading' && blank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || blank === true)
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'
  return props.renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
    slots: { views: BusinessConversationView },
  })
}
function BusinessConversationView({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', { view: 'chat' })
}
export function BusinessIcon({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M8 5V3h8v2M3 10h18M9 10v3h6v-3"/></svg>
}

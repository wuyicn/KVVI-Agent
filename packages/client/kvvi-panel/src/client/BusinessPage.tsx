/** Business data takes the main area; the original Conversation is an optional assistant. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { listSystems, adminCapabilities } from './api.ts'
import type { PublishedSystem } from './api.ts'
import { KvviSystemShell } from './SystemShell.tsx'
import { BusinessActivity } from './BusinessActivity.tsx'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BusinessContent } from './BusinessBody.tsx'
import { businessAddress } from './business-tabs.ts'
import type { createBusinessStore } from './business-store.ts'
import { ReadFailure } from './ReadFailure.tsx'
import css from './business.module.css'
export interface BusinessPageInjected {
  back: () => void
  manage: () => void
  bindBusiness: (system: PublishedSystem, current?: SessionId) => Promise<SessionReference | undefined>
}
export type BusinessPageProps = PropsRuntime<'main'> & PropsLocale<'kvviPanel'> & PropsRenderSlots<'kvvi.business.session'> & PropsRenderFactories & BusinessPageInjected
export function BusinessPage({ t, back, manage, bindBusiness, useSessions, SessionProvider, renderSlot }: BusinessPageProps) {
  const current = useSessions(state => Object.values(state.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id)
  const [systems, setSystems] = useState<PublishedSystem[]>([])
  const [system, setSystem] = useState<PublishedSystem | null>(null)
  const [session, setSession] = useState<SessionReference | undefined>()
  const [address, setAddress] = useState('')
  const [query, setQuery] = useState('')
  const [ai, setAI] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [canAdmin, setCanAdmin] = useState(false)
  const navigation = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    setError(undefined)
    void listSystems(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setSystems(result.value.items); else setError(result.code)
    })
    void adminCapabilities(controller.signal).then((result) => { if (!controller.signal.aborted && result.ok) setCanAdmin(result.value.role === 'owner' || result.value.role === 'admin') })
    return () => { controller.abort() }
  }, [attempt])
  useEffect(() => () => { navigation.current++ }, [])
  useEffect(() => () => { session?.release() }, [session])
  const enter = (next: PublishedSystem) => {
    const token = ++navigation.current
    setSystem(next); setAI(false); setSession(undefined); setBusy(true); setError(undefined)
    setAddress(businessAddress(next.assetId, 'records'))
    void bindBusiness(next, current).then((id) => {
      if (token !== navigation.current) { id?.release(); return }
      setSession(id); setBusy(false)
      if (id === undefined) setError(t('business.workspaceMissing'))
    }).catch(() => { if (token === navigation.current) { setBusy(false); setError(t('business.workspaceMissing')) } })
  }
  return <section className={css.workbench}>
    <header className={css.workbenchHeader}><div><h1>{system?.name ?? t('panel.title')}</h1><p className={css.hint}>{system === null ? t('panel.subtitle') : t('business.assistantHint')}</p></div><div>{canAdmin && system === null ? <Button variant="outline" onClick={manage}>{t('admin.title')}</Button> : null}{system === null ? <Button variant="ghost" onClick={back}>{t('panel.close')}</Button> : <><Button variant="ghost" onClick={() => { navigation.current++; setSystem(null); setSession(undefined); setAI(false); setBusy(false); setError(undefined) }}>{t('business.home')}</Button><Button variant="outline" disabled={session === undefined || busy} aria-pressed={ai} onClick={() => { setAI(!ai) }}>{t(ai ? 'business.ai.close' : 'business.ai')}</Button></>}</div></header>
    {system === null ? <div className={css.directory}><input className={css.control} aria-label={t('business.search')} placeholder={t('business.search')} value={query} onChange={(e) => { setQuery(e.target.value) }}/>{error === undefined ? null : <ReadFailure error={error} copy={t} onRetry={() => { setAttempt(v => v + 1) }}/>}<ul className={css.systemList}>{systems.filter(s => s.name.includes(query)).map(s => <li className={css.systemRow} key={s.systemId}><div><strong>{s.name}</strong><p className={css.hint}>{t('systems.hint')}</p></div><Button variant="outline" onClick={() => { enter(s) }}>{t('business.enter')}</Button></li>)}</ul>{!systems.length && error === undefined ? <p>{t('systems.empty')}</p> : null}</div> : <div className={css.workbenchBody} data-ai-open={ai || undefined}>
      <aside className={css.resourceDirectory} aria-label={t('panel.title')}><strong>{system.name}</strong><Button variant="ghost" onClick={() => { setAddress(businessAddress(system.assetId, 'records')) }}>{t('business.records')}</Button><Button variant="ghost" onClick={() => { setAddress(businessAddress(system.assetId, 'form')) }}>{t('dock.form')}</Button></aside>
      {busy ? <p role="status">{t('business.connecting')}</p> : session === undefined ? <div className={css.directory}><p role="status">{error}</p><KvviSystemShell key={system.assetId} initialSystem={system} copy={t}/></div> : <SessionProvider session={session}>
        <div className={css.primaryBusiness}>{renderSlot('kvvi.business.session', { address, navigate: setAddress })}</div>
        {ai ? <aside className={css.assistantPane} aria-label={t('business.ai')}><div className={css.assistantHeading}><strong>{t('business.ai')}</strong><Button variant="ghost" onClick={() => { setAI(false) }}>{t('business.ai.close')}</Button></div>{renderSlot('kvvi.business.session', { address, navigate: setAddress, assistant: true })}</aside> : null}
      </SessionProvider>}
    </div>}
  </section>
}
export type BusinessSessionProps = PropsRuntime<'kvvi.business.session'> & PropsLocale<'kvviPanel'> & PropsStore<ReturnType<typeof createBusinessStore>> & PropsRenderFactories
export function BusinessSession({ address, navigate, assistant, ...props }: BusinessSessionProps) {
  const lifetime = useRef(new AbortController())
  const currentAddress = useRef(address)
  currentAddress.current = address
  useEffect(() => { const controller = lifetime.current; return () => { controller.abort() } }, [])
  return assistant ? <BusinessAssistant {...props}/> : <>
    <BusinessActivity {...props} afterWrite={() => {}}/>
    <BusinessContent {...props} address={address} signal={lifetime.current.signal}
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

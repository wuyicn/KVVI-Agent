/** Actual platform identity, with the existing settings dialog as a callback. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Button, IconSettingsOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './business.module.css'
interface Profile { login: string | null; companyName: string | null }
export type AccountAreaProps = PropsRuntime<'settings.account'> & PropsLocale<'kvviPanel'>
/** The account menu owns local viewing state, never roles or permissions. */
export function AccountArea({ wide, openSettings, t }: AccountAreaProps) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState(false)
  const [menu, setMenu] = useState(false)
  const [notifications, setNotifications] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/auth/session', { signal: controller.signal }).then(async (result) => {
      if (!result.ok) throw new Error('session')
      const value = await result.json() as Profile
      if (!controller.signal.aborted) setProfile(value)
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => { controller.abort() }
  }, [])
  useEffect(() => {
    if (!menu) return undefined
    const close = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setMenu(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(false); anchor.current?.focus() } }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [menu])
  const name = profile?.login ?? t(error ? 'account.failed' : 'account.loading')
  return <div ref={container} className={css.accountArea}>
    <button ref={anchor} type="button" className={css.accountTrigger} aria-label={t('account.open')} aria-expanded={menu}
      onClick={() => { setMenu(v => !v) }}>
      <span className={css.avatar} aria-hidden="true">{profile?.login?.slice(0, 1).toUpperCase() ?? '·'}</span>
      {wide ? <span className={css.accountName}>{name}</span> : null}
    </button>
    <button type="button" className={css.notificationTrigger} aria-label={t('account.notifications')}
      onClick={() => { setMenu(false); setNotifications(true) }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></svg></button>
    {menu ? <div className={css.accountMenu}>
      <strong>{name}</strong><p className={css.hint}>{profile?.companyName}</p>
      <Button variant="ghost" onClick={() => { setMenu(false); openSettings(() => { anchor.current?.focus() }) }}><IconSettingsOutline16 size={16} />{t('account.settings')}</Button>
      <Button variant="ghost" disabled={loggingOut} onClick={() => {
        setLoggingOut(true)
        void fetch('/auth/logout', { method: 'POST' }).then((result) => {
          if (result.ok) globalThis.location.assign('/kvvi/login')
          else { setError(true); setLoggingOut(false) }
        }).catch(() => { setError(true); setLoggingOut(false) })
      }}>{t('account.logout')}</Button>
      {error ? <p role="alert">{t('account.failed')}</p> : null}
    </div> : null}
    {notifications ? <Modal open closeLabel={t('panel.close')} title={t('account.notifications')} onClose={() => { setNotifications(false); anchor.current?.focus() }}>
      <p>{t('account.noNotifications')}</p>
    </Modal> : null}
  </div>
}

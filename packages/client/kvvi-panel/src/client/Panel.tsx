/**
 * Presentational components for the KVVI business panel.
 *
 * These are pure props consumers: they read nothing from context, subscribe to
 * nothing, and hold only the transient state of their own request. Registration
 * lives in `index.ts`, and the dictionary lives in `locales.ts` — no component
 * in this package carries product copy.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { KvviAdminShell } from './AdminShell.tsx'
import { KvviSystemShell } from './SystemShell.tsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PublishedSystem } from './api.ts'
import { adminCapabilities } from './api.ts'
import css from './business.module.css'

/**
 * The translate seat this panel's entries receive.
 *
 * `TranslateNS<'kvviPanel'>` is the exact type the slot registration puts on
 * `t` when it declares `locale: NS`; naming it here keeps the components free
 * of the framework's prop composition while staying key-checked.
 */
export type KvviTranslate = TranslateNS<'kvviPanel'>

/**
 * Event the sidebar entry raises to ask the overlay to open.
 *
 * The two occupy different slots, so neither can render the other; a DOM event
 * is the narrowest thing that crosses between them without a module-level
 * mutable shared by every consumer. The name is namespaced to this package.
 */
export const KVVI_OPEN_EVENT = 'kvvi-panel:open'

/**
 * Render the panel over the conversation area.
 * @param props - the framework's `t` seat and `onClose` from the registration site.
 * @returns the overlay.
 */
export function KvviPanel({ t, onClose, onDock, embedded }: {
  readonly t: KvviTranslate
  readonly onClose: () => void
  readonly onDock?: (system: PublishedSystem, mode: 'form' | 'records') => void
  readonly embedded?: boolean
}): ReactNode {
  // 两半是同一层的两个入口：**业务**是员工每天用的，**企业管理**只有
  // 所有者与管理员用得到。放在一个面板的两个页签里，是因为它们共享
  // 「我是谁、我在哪家公司」这一个前提 —— 分成两个悬浮层会让这个前提看起来像两个。
  const [page, setPage] = useState<'business' | 'admin'>('business')
  const [canAdmin, setCanAdmin] = useState(false)
  const [capabilityError, setCapabilityError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setCanAdmin(false)
    setCapabilityError(null)
    void adminCapabilities(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setCanAdmin(result.value.role === 'owner' || result.value.role === 'admin')
      else setCapabilityError(result.code)
    })
    return () => { controller.abort() }
  }, [attempt])

  return (
    <BusinessFrame embedded={embedded} title={t('panel.aria')} onClose={onClose}>
      <header className={css.header}>
        <div>
          <h2 className={css.title}>{t('panel.title')}</h2>
          <p className={css.hint}>{t('panel.subtitle')}</p>
        </div>
        <Button variant="outline" onClick={onClose}>{t('panel.close')}</Button>
      </header>
      {canAdmin ? (
        <nav className={css.tabs} aria-label={t('panel.aria')}>
          <Button aria-pressed={page === 'business'} variant={page === 'business' ? 'primary' : 'ghost'}
            onClick={() => { setPage('business') }}>{t('panel.tab.business')}</Button>
          <Button aria-pressed={page === 'admin'} variant={page === 'admin' ? 'primary' : 'ghost'}
            onClick={() => { setPage('admin') }}>{t('admin.title')}</Button>
        </nav>
      ) : null}
      <div className={css.content}>
        {capabilityError === null ? null : (
          <div className={css.notice} role="alert">
            <p>{t('panel.capabilitiesFailed')}</p>
            <code>{capabilityError}</code>
            <Button variant="outline" onClick={() => { setAttempt(value => value + 1) }}>{t('panel.retryCapabilities')}</Button>
          </div>
        )}
        {page === 'admin' && canAdmin ? <KvviAdminShell copy={t} /> : <KvviSystemShell copy={t} {...(onDock === undefined ? {} : { onDock })} />}
      </div>
    </BusinessFrame>
  )
}

/**
 * Render the sidebar foot entry.
 * @param props - host-supplied width hint (`wide: false` is the 56px rail).
 * @returns the entry button.
 */
export function KvviEntry(
  { wide, onOpen, t }: SidebarFooterActionOwnerProps & {
    readonly onOpen: () => void
    readonly t: KvviTranslate
  },
): ReactNode {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t('panel.title')}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        border: 'none', background: 'none', cursor: 'pointer',
        color: 'inherit', padding: '6px 8px', borderRadius: 8, fontSize: 13,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14 }}>▣</span>
      {wide ? <span>{t('panel.title')}</span> : null}
    </button>
  )
}

/**
 * Build the sidebar foot entry as a component.
 *
 * A factory rather than a module-level component: the bundle's public surface
 * stays `apply`/`inject`, and the registration site names what it registers.
 * @returns the entry component.
 */
export function createKvviEntry(): (props: SidebarFooterActionOwnerProps & { t: KvviTranslate }) => ReactNode {
  return props => (
    <KvviEntry
      {...props}
      onOpen={() => { globalThis.dispatchEvent(new Event(KVVI_OPEN_EVENT)) }}
    />
  )
}

/**
 * Build the panel as a component that owns its own closed/open state.
 *
 * The state is local because it is not shared with any other entry and does not
 * need to survive a remount: the panel is a transient view, not a layout fact.
 * @returns the overlay component.
 */
export function createKvviOverlay(): (props: { t: KvviTranslate }) => ReactNode {
  return ({ t }) => {
    const [open, setOpen] = useState(false)
    useEffect(() => {
      const openPanel = (): void => { setOpen(true) }
      globalThis.addEventListener(KVVI_OPEN_EVENT, openPanel)
      return () => { globalThis.removeEventListener(KVVI_OPEN_EVENT, openPanel) }
    }, [])
    return open ? <KvviPanel t={t} onClose={() => { setOpen(false) }} /> : null
  }
}

/** One directory surface offered as a main page or its legacy dialog. */
function BusinessFrame({ embedded, title, onClose, children }: {
  embedded: boolean | undefined
  title: string
  onClose: () => void
  children: ReactNode
}) {
  return embedded === true ? <section className={css.businessPage}>{children}</section> : <Modal open headless title={title} onClose={onClose} className={css.panel ?? ''}>{children}</Modal>
}

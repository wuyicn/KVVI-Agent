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
export function KvviPanel({ t, onClose }: {
  readonly t: KvviTranslate
  readonly onClose: () => void
}): ReactNode {
  // 两半是同一层的两个入口：**业务**是员工每天用的，**企业管理**只有
  // 所有者与管理员用得到。放在一个面板的两个页签里，是因为它们共享
  // 「我是谁、我在哪家公司」这一个前提 —— 分成两个悬浮层会让这个前提看起来像两个。
  const [page, setPage] = useState<'business' | 'admin'>('business')

  return (
    <div
      role="dialog"
      aria-label={t('panel.aria')}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, padding: 24,
        background: 'rgba(16,24,40,.28)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(event) => { event.stopPropagation() }}
        style={{
          background: 'var(--dsw-surface, #fff)', color: 'var(--dsw-fg, #111827)',
          borderRadius: 14, padding: '22px 24px', width: '100%',
          maxWidth: 760, maxHeight: '82vh', overflow: 'auto',
          boxShadow: '0 12px 32px rgba(16,24,40,.18)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
          <strong style={{ fontSize: 15 }}>{t('panel.title')}</strong>
          <button type="button" aria-pressed={page === 'business'}
            style={{ fontSize: 12, fontWeight: page === 'business' ? 600 : 400 }}
            onClick={() => { setPage('business') }}>{t('panel.tab.business')}</button>
          <button type="button" aria-pressed={page === 'admin'}
            style={{ fontSize: 12, fontWeight: page === 'admin' ? 600 : 400 }}
            onClick={() => { setPage('admin') }}>{t('admin.title')}</button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{
              border: '1px solid var(--dsw-border, #e5e7eb)', background: 'none',
              borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              color: 'inherit',
            }}
          >
            {t('panel.close')}
          </button>
        </div>

        {page === 'business' ? <KvviSystemShell copy={t} /> : <KvviAdminShell copy={t} />}
      </div>
    </div>
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

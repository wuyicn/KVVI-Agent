/**
 * Session banner: the visible half of "your sign-in ended".
 *
 * Pure presentation. It reads the notice through the injected hook seat and
 * calls the injected re-login callback; it does not fetch, does not decide
 * when a session ended, and does not build a login form. The login page is the
 * platform's and is reached by navigation — a second one here would be a
 * second authentication surface.
 */

import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type { SessionNoticeState } from './session-notice.ts'

/** What the plugin injects into the banner registration. */
export interface SessionBannerInjected {
  hooks: {
    /** Live notice; the renderer binds it as the `useSessionNotice` seat. */
    sessionNotice: SnapshotStore<SessionNoticeState>
  }
  /** Leave for the platform's login page, carrying the reason. */
  relogin: (code: string) => void
}

/** The banner's props: runtime share, locale seat, and the injected face. */
export type SessionBannerProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS>
  & InjectFace<SessionBannerInjected>

/**
 * Render the banner, or nothing when the session is fine.
 * @param props - Derived props shares provided by the slot renderer.
 * @returns The banner, or `null`.
 */
export function SessionBanner(props: SessionBannerProps): ReactNode {
  const { notice } = props.useSessionNotice(value => value)
  if (notice === null) return null
  return (
    <div
      data-kvvi-session-banner=""
      role="alert"
      style={{
        position: 'fixed',
        insetInline: 0,
        insetBlockStart: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        fontSize: 13,
        lineHeight: 1.4,
        borderBlockEnd: '1px solid var(--dsw-separator)',
        background: 'var(--dsw-surface)',
      }}
    >
      <strong>{props.t('session.ended.title')}</strong>
      <span>{props.t('session.ended.body', { reason: notice.message })}</span>
      {/* The code travels verbatim: it is what an operator quotes in a report. */}
      <code data-kvvi-session-code={notice.code}>{notice.code}</code>
      <button type="button" onClick={() => { props.relogin(notice.code) }}>
        {props.t('session.ended.relogin')}
      </button>
    </div>
  )
}

/** Global business directory and owner administration keep their existing APIs. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PublishedSystem } from './api.ts'
import { KvviPanel } from './Panel.tsx'
export interface BusinessPageInjected { back: () => void; openDock: (sessionId: SessionId, system: PublishedSystem, mode: 'form' | 'records') => void }
export function BusinessPage(props: PropsRuntime<'main'> & PropsLocale<'kvviPanel'> & BusinessPageInjected) {
  const sessionId = props.useSessions(state => Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  return <KvviPanel t={props.t} onClose={props.back} {...(sessionId === undefined ? {} : { onDock: (system: PublishedSystem, mode: 'form' | 'records') => { props.openDock(sessionId, system, mode) } })} embedded />
}
export function BusinessIcon({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M8 5V3h8v2M3 10h18M9 10v3h6v-3"/></svg>
}

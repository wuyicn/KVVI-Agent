/** Open an available managed draft without a model turn or publication. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { readEntrance, request } from './api.ts'
import { previewIntent } from './BuilderPreview.tsx'

/** The resource opener belongs to the plugin's application registration. */
export interface BuilderPreviewEntryInjected { openPreview: (intentId: string) => void }

/** @param props - current session facts and resource opener. @returns a builder-only draft shortcut. */
export function BuilderPreviewEntry({ sessionId, useSessions, useSession, openPreview, t }: PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'kvviPanel'> & BuilderPreviewEntryInjected) {
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const running = useSession(s => s.running)
  const intent = previewIntent(cwd)
  const [available, setAvailable] = useState<string>()
  const opened = useRef<string>()
  useEffect(() => {
    const controller = new AbortController()
    const cancelled = () => controller.signal.aborted
    setAvailable(undefined)
    if (intent === undefined) return () => { controller.abort() }
    void (async () => {
      const identity = await readEntrance(controller.signal)
      if (cancelled() || !identity.ok || identity.value.gateway !== 'BUILDER') return
      setAvailable(intent)
      if (running) return
      const result = await request<{ intentId: string; canSubmit: unknown }>('GET', '/api/kvvi-builder-preview/' + intent, undefined, controller.signal, '')
      if (cancelled() || !result.ok || result.value.intentId !== intent || result.value.canSubmit !== false) return
      if (opened.current !== intent) { opened.current = intent; openPreview(intent) }
    })().catch(() => { /* The panel displays the read failure after an explicit open. */ })
    return () => { controller.abort() }
  }, [sessionId, intent, running, openPreview])
  return available === intent && intent !== undefined
    ? <Button variant="ghost" onClick={() => { openPreview(intent) }}>{t('preview.title')}</Button> : null
}

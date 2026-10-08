/** Business shortcuts beside the conversation title; workspace identity stays authoritative. */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { listSystems } from './api.ts'
import type { PublishedSystem } from './api.ts'
export interface BusinessHeaderInjected {
  open: (assetId: string, mode: 'form' | 'records') => void
  choose: () => void
  resolveBusiness: (sessionId: SessionId, systems: readonly PublishedSystem[], signal: AbortSignal) => Promise<PublishedSystem | undefined>
}
export function BusinessHeader({ sessionId,useSessions,useWorkspaces,t,open,choose,resolveBusiness }: PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'kvviPanel'> & BusinessHeaderInjected) {
  const cwd=useSessions(state=>state.byId[sessionId]?.cwd)
  const workspaceId = useWorkspaces(state => state.items.find(workspace => workspace.sessionIds.includes(sessionId))?.workspaceId)
  const [system,setSystem]=useState<PublishedSystem | undefined>()
  useEffect(() => {
    const controller = new AbortController()
    setSystem(undefined)
    void listSystems(controller.signal).then(async (result) => {
      if (!result.ok || controller.signal.aborted) return
      const resolved = await resolveBusiness(sessionId, result.value.items, controller.signal)
      if (!controller.signal.aborted) setSystem(resolved)
    }).catch(() => { if (!controller.signal.aborted) setSystem(undefined) })
    return () => { controller.abort() }
  }, [sessionId, cwd, workspaceId, resolveBusiness])
  if(system===undefined)return <Button variant="ghost" onClick={choose}>{t('panel.title')}</Button>
  return <><Button variant="ghost" onClick={()=>{open(system.assetId,'form')}}>{t('business.workspace.form')}</Button><Button variant="ghost" onClick={()=>{open(system.assetId,'records')}}>{t('business.records')}</Button></>
}

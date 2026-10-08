/** Business shortcuts beside the conversation title; workspace identity stays authoritative. */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { listSystems } from './api.ts'
import type { PublishedSystem } from './api.ts'
export interface BusinessHeaderInjected { open: (assetId: string, mode: 'form' | 'records') => void; choose: () => void }
export function BusinessHeader({ sessionId,useSessions,t,open,choose }: PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'kvviPanel'> & BusinessHeaderInjected) {
  const cwd=useSessions(state=>state.byId[sessionId]?.cwd)
  const [systems,setSystems]=useState<PublishedSystem[]>([])
  useEffect(() => {
    const controller = new AbortController()
    void listSystems(controller.signal).then((result) => {
      if (result.ok && !controller.signal.aborted) setSystems(result.value.items)
    })
    return () => { controller.abort() }
  }, [])
  const folder=cwd?.split('/').filter(Boolean).at(-1)
  const system=systems.find(item=>item.name===folder||item.schemaCode===folder)
  if(system===undefined)return <Button variant="ghost" onClick={choose}>{t('panel.title')}</Button>
  return <><Button variant="ghost" onClick={()=>{open(system.assetId,'form')}}>{t('dock.form')}</Button><Button variant="ghost" onClick={()=>{open(system.assetId,'records')}}>{t('dock.records')}</Button></>
}

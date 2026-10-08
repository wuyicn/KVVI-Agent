/** Observe structured successful writes; replayed history never opens a pane. */
import { useEffect, useRef } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { createBusinessStore } from './business-store.ts'
export function writtenBusiness(node: ToolResultNode): string | undefined {
  if (node.isError || node.call === null || !['record_create', 'record_update'].includes(node.call.name)) return undefined
  try {
    const args = JSON.parse(node.call.argsRaw) as { system?: unknown }
    const value = JSON.parse(node.content.filter(c => c.type === 'text').map(c => c.text).join('')) as { recordId?: unknown }
    return typeof args.system === 'string' && args.system.length > 0 && typeof value.recordId === 'string' ? args.system : undefined
  } catch { return undefined }
}
export type BusinessActivityProps = PropsRuntime<'conversation.session.header.actions'> & PropsStore<ReturnType<typeof createBusinessStore>> & {
  afterWrite: (assetId: string) => void
}
export function BusinessActivity({ useConversation, actions, afterWrite, usePanelInfo, useSession }: BusinessActivityProps) {
  const workspace = usePanelInfo(info => info.activePanelId === null)
  const openState = useSession(s => s.openState)
  const nodes = useConversation(snapshot => snapshot.views.get('chat')?.legacy.nodes)
  const seen = useRef<number | undefined>()
  useEffect(() => {
    if (nodes === undefined || openState !== 'open') { seen.current = undefined; return }
    const latest = nodes.at(-1)?.seq ?? 0
    if (seen.current === undefined) { seen.current = latest; return }
    const previous = seen.current; seen.current = Math.max(previous, latest)
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]
      if (node === undefined) continue
      if (node.seq <= previous) break
      if (node.kind !== 'tool-result') continue
      const assetId = writtenBusiness(node)
      if (assetId !== undefined) { actions.invalidate(assetId); if (workspace) afterWrite(assetId) }
    }
  }, [nodes, actions, afterWrite, workspace, openState])
  return null
}

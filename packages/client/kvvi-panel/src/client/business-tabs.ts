/** Stable, tenant-free business addresses. Authentication remains same-origin. */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Copy } from './FormView.tsx'

export type BusinessMode = 'form' | 'records' | 'detail'
export interface BusinessAddress { assetId: string; mode: BusinessMode; recordId?: string }
export const BUSINESS_TAB_ID = '@deepseek-ai/dsh-client-kvvi-panel/business'

/** Compose the content identity, never an authentication or authorization token. */
export function businessAddress(assetId: string, mode: BusinessMode, recordId?: string): string {
  return `dsh-resource://kvvi-business/${encodeURIComponent(assetId)}/${mode}${recordId === undefined ? '' : '/' + encodeURIComponent(recordId)}`
}

/** Validate restored/untrusted resource addresses before issuing any request. */
export function parseBusinessAddress(address: string): BusinessAddress | null {
  const match = /^dsh-resource:\/\/kvvi-business\/([^/?#]+)\/(form|records|detail)(?:\/([^/?#]+))?$/u.exec(address)
  if (match === null || (match[2] === 'detail') !== (match[3] !== undefined)) return null
  try {
    const assetId = decodeURIComponent(match[1] ?? '')
    const recordId = match[3] === undefined ? undefined : decodeURIComponent(match[3])
    if (!assetId || /[\x00-\x1f]/u.test(assetId) || (recordId !== undefined && /[\x00-\x1f]/u.test(recordId))) return null
    return { assetId, mode: match[2] as BusinessMode, ...(recordId === undefined ? {} : { recordId }) }
  } catch { return null }
}

/** The resource registry owns routing and deduplication; it does not grant access. */
export function businessDefinition(copy: Copy): SidebarRightTabDefinition {
  return {
    id: BUSINESS_TAB_ID, kind: 'kvvi-business', patterns: ['dsh-resource://kvvi-business/**'],
    priority: 'builtin', canOpen: address => parseBusinessAddress(address) !== null,
    title: (address) => {
      const parsed = parseBusinessAddress(address)
      return copy(parsed?.mode === 'form' ? 'dock.form' : parsed?.mode === 'records' ? 'dock.records' : 'dock.detail')
    },
  }
}

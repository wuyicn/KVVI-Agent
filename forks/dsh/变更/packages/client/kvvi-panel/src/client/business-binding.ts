/** Workspace selection hints resolve only against the current published catalogue. */
import type { PublishedSystem } from './api.ts'

export type BusinessHint = { kind: 'absent' } | { kind: 'unavailable' } | { kind: 'selected'; assetId: string }

/** @param candidates - authorized markers. @param systems - full visible catalogue.
 * @param assetId - current form. @param explicit - selected workspace, never overriding a conflicting marker.
 * @returns one unambiguous workspace; unmarked explicit choices require a fresh business session.
 */
export function businessWorkspace<T extends { workspaceId: string; title: string; hint: BusinessHint }>(
  candidates: readonly T[], systems: readonly PublishedSystem[], assetId: string, explicit?: string,
): T | undefined {
  const matches = candidates.filter((c) => {
    if (explicit !== undefined && c.workspaceId !== explicit) return false
    if (c.hint.kind === 'unavailable') return false
    if (explicit !== undefined && c.hint.kind === 'absent') return true
    return businessFromHint(systems, c.title, c.hint)?.assetId === assetId
  })
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * @param candidates - workspaces and their authorized marker reads.
 * @param assetId - published form being edited.
 * @param explicit - user's explicit workspace selection.
 * @returns only a unique marker match, or an explicitly chosen unmarked workspace. Names never select edits.
 */
export function editWorkspace(candidates: readonly { workspaceId: string; hint: BusinessHint }[], assetId: string, explicit?: string) {
  const matches = candidates.filter(c => (explicit === undefined || explicit === c.workspaceId)
    && (c.hint.kind === 'selected' ? c.hint.assetId === assetId : explicit !== undefined && c.hint.kind === 'absent'))
  return matches.length === 1 ? matches[0]?.workspaceId : undefined
}

/** @param text - complete workspace marker. @param eof - whether the read was complete. @returns a selection or an unusable marker. */
export function parseBusinessHint(text: string, eof: boolean): BusinessHint {
  if (!eof || new TextEncoder().encode(text).length > 4096) return { kind: 'unavailable' }
  try {
    const hint: unknown = JSON.parse(text)
    if (hint === null || typeof hint !== 'object' || !('assetId' in hint)
      || typeof hint.assetId !== 'string' || !hint.assetId || /[\x00-\x1f]/u.test(hint.assetId)) return { kind: 'unavailable' }
    return { kind: 'selected', assetId: hint.assetId }
  } catch (_error) {
    return { kind: 'unavailable' } // Invalid JSON must not fall back to an unrelated name match.
  }
}

/**
 * @param systems - current company catalogue.
 * @param name - exact workspace name.
 * @param hint - authorized marker read.
 * @returns the sole matching published business.
 */
export function businessFromHint(
  systems: readonly PublishedSystem[], name: string | undefined, hint: BusinessHint,
): PublishedSystem | undefined {
  if (hint.kind === 'unavailable') return undefined
  const matches = systems.filter(system => hint.kind === 'selected'
    ? system.assetId === hint.assetId
    : name !== undefined && (system.name === name || system.assetId === name || system.name + '系统' === name))
  return matches.length === 1 ? matches[0] : undefined
}

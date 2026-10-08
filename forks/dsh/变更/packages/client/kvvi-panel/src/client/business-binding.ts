/** Workspace selection hints resolve only against the current published catalogue. */
import type { PublishedSystem } from './api.ts'

export type BusinessHint = { kind: 'absent' } | { kind: 'unavailable' } | { kind: 'selected'; assetId: string }

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

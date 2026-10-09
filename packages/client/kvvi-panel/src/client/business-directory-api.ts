/** Company directory metadata; permissions are still enforced for each record request. */
import { request, type ApiResult, type PublishedSystem } from './api.ts'
export interface BusinessGroup { groupId: string; name: string; version: number; position: number }
export interface BusinessForm extends PublishedSystem {
  groupId: string | null
  archived: boolean
  version: number
  actions: readonly string[]
}
export interface Directory { groups: BusinessGroup[]; forms: BusinessForm[] }
export type DirectoryAction = 'group.create' | 'group.rename' | 'group.delete' | 'form.move' | 'form.archive' | 'form.restore'
export interface DirectoryInput { target?: string; expectedVersion?: number; name?: string; groupId?: string | null; confirmed?: boolean }
/** @param groupId - intended company group. @param operationId - stable retry identifier. @returns a server-owned build intention. */
export function createBuildIntent(groupId: string | null, operationId: string) {
  return request<{ intentId: string; version: number }>('POST', '/business-build-intents', { groupId }, undefined, undefined,
    { 'Idempotency-Key': operationId })
}
/** @param options - archive filter and request lifetime. @returns server-owned company directory. */
export async function loadDirectory(
  { archived = false, signal }: { archived?: boolean; signal?: AbortSignal },
): Promise<ApiResult<Directory>> {
  const result = await request<unknown>('GET', '/business-directory' + (archived ? '?archived=true' : ''), undefined, signal)
  if (!result.ok) return result
  const value = result.value
  if (!object(value) || !Array.isArray(value.groups) || !value.groups.every(g => object(g) && typeof g.groupId === 'string' && typeof g.name === 'string' && Number.isSafeInteger(g.version) && Number.isSafeInteger(g.position))
    || !Array.isArray(value.forms) || !value.forms.every(f => object(f) && ['assetId', 'systemId', 'name', 'schemaCode', 'publishedAt'].every(k => typeof f[k] === 'string') && (f.groupId === null || typeof f.groupId === 'string') && typeof f.archived === 'boolean' && Number.isSafeInteger(f.version) && Array.isArray(f.actions) && f.actions.every(a => typeof a === 'string'))) {
    return { ok: false, code: 'KVVI_BAD_RESPONSE', status: 200 }
  }
  return { ok: true, value: value as unknown as Directory }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
/**
 * @param action - management operation.
 * @param input - target version and values.
 * @param options - stable retry identity and lifetime.
 * @returns committed result or the original refusal code.
 */
export function writeDirectory(
  action: DirectoryAction, { target, ...body }: DirectoryInput,
  { operationId, signal }: { operationId: string; signal?: AbortSignal },
) {
  const path = action.startsWith('group.') ? '/business-groups' + (target === undefined ? '' : '/' + encodeURIComponent(target))
    : '/business-forms/' + encodeURIComponent(target ?? '') + '/' + (action === 'form.move' ? 'group' : action.split('.')[1])
  const method = action === 'group.delete' ? 'DELETE' : action === 'group.rename' || action === 'form.move' ? 'PATCH' : 'POST'
  return request<{ result: unknown; auditPending: boolean }>(method, path, body, signal, undefined, { 'Idempotency-Key': operationId })
}

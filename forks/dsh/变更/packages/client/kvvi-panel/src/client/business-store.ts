/** Session-scoped, non-persisted business drafts and pending writes. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
export interface BusinessWrite { busy: boolean; revision?: number; error?: string; fields?: string[]; currentRowVersion?: number }
export interface BusinessDraftState {
  identity: string
  collapsed: string[]
  drafts: Record<string, Record<string, string>>
  writes: Record<string, BusinessWrite>
  revisions: Record<string, number>
  selections: Record<string, readonly string[]>
}
/** Shared handle for every business tab occurrence in the same session. */
export function createBusinessStore() {
  return defineStore({
    init: (): BusinessDraftState => ({ identity: '', collapsed: [], drafts: {}, writes: {}, revisions: {}, selections: {} }),
    actions: {
      identify(state: BusinessDraftState, identity: string) {
        if (state.identity === identity) return
        state.identity = identity; state.collapsed = []; state.drafts = {}; state.writes = {}; state.revisions = {}; state.selections = {}
      },
      collapse(state: BusinessDraftState, groupId: string) {
        state.collapsed = state.collapsed.includes(groupId) ? state.collapsed.filter(id => id !== groupId) : [...state.collapsed, groupId]
      },
      /** Keep only viewing identifiers, never business row data. */
      select(state: BusinessDraftState, assetId: string, ids: readonly string[]) { state.selections[assetId] = [...new Set(ids)] },
      invalidate(state: BusinessDraftState, assetId: string, identity?: string) {
        if (identity !== undefined && identity !== state.identity) return
        state.revisions[assetId] = (state.revisions[assetId] ?? 0) + 1
      },
      change(state: BusinessDraftState, assetId: string, values: Record<string, string>) { state.drafts[assetId] = values },
      clearIfUnchanged(state: BusinessDraftState, assetId: string, submitted: Record<string, string>, identity?: string) {
        if (identity !== undefined && identity !== state.identity) return
        const draft = state.drafts[assetId]
        if (draft !== undefined && Object.keys(draft).length === Object.keys(submitted).length
          && Object.entries(draft).every(([key, value]) => submitted[key] === value)) {
          state.drafts = Object.fromEntries(Object.entries(state.drafts).filter(([key]) => key !== assetId))
        }
      },
      begin(state: BusinessDraftState, address: string) {
        state.writes[address] = { busy: true, revision: state.writes[address]?.revision ?? 0 }
      },
      finish(state: BusinessDraftState, address: string, result: BusinessWrite, succeeded = false, identity?: string) {
        if (identity !== undefined && identity !== state.identity) return
        state.writes[address] = { ...result, revision: (state.writes[address]?.revision ?? 0) + (succeeded ? 1 : 0) }
      },
    },
  })
}

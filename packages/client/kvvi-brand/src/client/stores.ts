/**
 * The branding read's state, shared by the five occupants.
 *
 * ── Why this is a declared store ────────────────────────────────────────────
 *
 * Five registrations in two unrelated hosts (the sidebar and the hero) render
 * pieces of one fact that arrives asynchronously. The fact outlives any one
 * occupant and must reach all of them, which is exactly what a store declared
 * at registration is for; a per-component fetch would read the endpoint five
 * times, and a module-level handle would outlive the plugin's own reload.
 *
 * ── What it keeps apart ────────────────────────────────────────────────────
 *
 * `ready` with three nulls (this company has no branding) and `failed` with a
 * `BrandingFailure` (the read did not produce an answer) are different states,
 * not one empty one. Both render the built-in brand, but only one of them is
 * something an operator would want to know about.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { BrandingFailure, CompanyBranding } from './branding.ts'

/** What the branding read is doing. */
export interface BrandingState {
  /**
   * `loading` until the read settles; `ready` and `failed` are terminal.
   *
   * The fields are mutable because they are the actions' immer draft, the same
   * declaration form the layout and file-tree stores use; the engine freezes
   * the published snapshot outside production.
   */
  status: 'loading' | 'ready' | 'failed'
  /** The company's branding once read; null before then and after a failure. */
  branding: CompanyBranding | null
  /** Why the read produced nothing; null unless it failed. */
  failure: BrandingFailure | null
}

/** The store's complete write set. */
type BrandingActions = {
  loaded: (draft: BrandingState, branding: CompanyBranding) => void
  failed: (draft: BrandingState, failure: BrandingFailure) => void
}

/**
 * Create the branding store handle. Built once per plugin activation and handed
 * to every occupant registration, so all five read one instance.
 * @returns the store handle (spec, types, identity, and factory in one).
 */
export function createBrandingStore(): EngineStoreHandle<BrandingState, BrandingActions> {
  return defineStore({
    init: (): BrandingState => ({ status: 'loading', branding: null, failure: null }),
    actions: {
      loaded: (draft, branding) => {
        draft.status = 'ready'
        draft.branding = branding
        draft.failure = null
      },
      failed: (draft, failure) => {
        draft.status = 'failed'
        draft.branding = null
        draft.failure = failure
      },
    },
  })
}

/** The branding store handle type, for the occupants' store share. */
export type BrandingStore = ReturnType<typeof createBrandingStore>

/**
 * The company's product name, or null when it has not set one.
 * @param state - the store snapshot.
 * @returns the name or null.
 */
export function companyNameOf(state: BrandingState): string | null {
  return state.branding?.name ?? null
}

/**
 * The company's logo URL, or null when it has not set one.
 * @param state - the store snapshot.
 * @returns the URL or null.
 */
export function logoUrlOf(state: BrandingState): string | null {
  return state.branding?.logoUrl ?? null
}

/**
 * The company's tagline, or null when it has not set one.
 * @param state - the store snapshot.
 * @returns the tagline or null.
 */
export function taglineOf(state: BrandingState): string | null {
  return state.branding?.tagline ?? null
}

/**
 * Whether this company has stated any branding at all.
 *
 * The brand mark and the product name fall back per field — a company that set
 * only a name keeps the KVVI mark — but the hero's preview badge is a product
 * identity statement rather than a field, so it goes as soon as the company
 * has said anything about who it is.
 * @param state - the store snapshot.
 * @returns whether any branding value is set.
 */
export function hasBranding(state: BrandingState): boolean {
  const branding = state.branding
  return branding !== null
    && (branding.name !== null || branding.logoUrl !== null || branding.tagline !== null)
}

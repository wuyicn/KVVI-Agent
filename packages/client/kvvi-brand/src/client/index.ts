/**
 * KVVI's brand occupants, browser half.
 *
 * ── Five slots, one fact ────────────────────────────────────────────────────
 *
 * The company's branding is read once and shared by every occupant through a
 * store declared at registration, so the sidebar and the hero cannot disagree
 * about who this tenant is, and a reload of this plugin starts exactly one
 * read.
 *
 * | Slot | Declared by | Contribution |
 * |---|---|---|
 * | `sidebar.brand.mark` | `ui-sidebar` | company logo, else the KVVI mark |
 * | `sidebar.brand.name` | `ui-sidebar` | company name, else the product name |
 * | `conversation.hero.brand.mark` | `ui-conversation` | company logo, else the KVVI mark |
 * | `conversation.hero.title` | `ui-conversation` | company tagline, else the owner's headline |
 * | `conversation.hero.badge` | `ui-conversation` | nothing, else the owner's badge |
 *
 * ── Why the conversation slots are occupied at all ──────────────────────────
 *
 * `ui-brand-official` occupies the two sidebar slots under the `official` build
 * profile, which KVVI's builds do not set, so those slots are free here. The
 * hero's headline and badge are hard-coded locale entries in `ui-conversation`,
 * and `ctx.locale.register` refuses a duplicate (namespace, locale) pair — a
 * second package cannot retranslate them. Slots are the only way to replace
 * that copy, which is why `ui-conversation` declares the two and this package
 * fills them.
 *
 * ── Declaration-aware, and atomic ───────────────────────────────────────────
 *
 * Every registration waits on its own slot's declaration, so the whole set
 * works whether this row activates before or after the declarers, withdraws
 * when a declaration collapses (HMR), and never leaves a half-branded shell.
 * The nested `inject` calls install the five as one generator effect.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { CompanyBrandMark, CompanyBrandName, HeroBadge, HeroHeadline } from './Brand.tsx'
import { readBranding } from './branding.ts'
import { createBrandingStore } from './stores.ts'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/** Dictionary namespace the two hero occupants translate the owner's copy from. */
const CONVERSATION_NS = 'conversation'

/**
 * Fill the KVVI brand slots as one declaration-aware registration set.
 *
 * The five are filled together because a mark without its name, or a hero whose
 * headline is the customer's while its badge still says "preview", is an
 * incoherent brand; a generator keeps them installed and rolled back as a unit.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const handle = createBrandingStore()
  // One instance per plugin activation, created here and handed to all five
  // registrations: the framework's per-entry instance would give each occupant
  // its own copy of a fact that has to be identical across them.
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }

  ctx.effect(() => {
    const controller = new AbortController()
    void readBranding(controller.signal).then((result) => {
      // An aborted read is this effect's own teardown, not a fact to publish.
      if (result.status === 'aborted') return
      if (result.status === 'failed') {
        instance.actions.failed(result.failure)
        return
      }
      instance.actions.loaded(result.branding)
    })
    return () => { controller.abort() }
  }, 'kvvi-brand: company branding')

  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', () =>
        ctx.slots.inject('conversation.hero.title', () =>
          ctx.slots.inject('conversation.hero.badge', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark', store }, CompanyBrandMark)
            yield ctx.slots.register({ name: 'sidebar.brand.name', store }, CompanyBrandName)
            yield ctx.slots.register({ name: 'conversation.hero.brand.mark', store }, CompanyBrandMark)
            yield ctx.slots.register(
              { name: 'conversation.hero.title', store, locale: CONVERSATION_NS },
              HeroHeadline,
            )
            yield ctx.slots.register(
              { name: 'conversation.hero.badge', store, locale: CONVERSATION_NS },
              HeroBadge,
            )
          })))))
}

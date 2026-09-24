/**
 * KVVI occupants for the generic browser-brand slots, browser half.
 *
 * Upstream's `ui-brand-official` occupies the same two slots but registers only
 * under the `official` build profile; KVVI's builds do not set that profile, so
 * the slots are free here and this package takes them unconditionally. That is
 * why the KVVI brand needs no edit to any upstream source file.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { KvviBrandMark, KvviBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the sidebar brand slots as one declaration-aware registration set.
 *
 * The two slots are filled together because a mark without its name (or the
 * reverse) is an incoherent brand; a generator keeps them installed and rolled
 * back as a unit.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, KvviBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, KvviBrandName)
    }))
}

/**
 * KVVI business panel, browser half: one sidebar entry plus one overlay page.
 *
 * Why this package exists instead of a separate frontend: the product reuses
 * DSH's own web interface and only adds what an employee needs on top of it.
 * The conversation view, session list, and tool rendering already exist here.
 *
 * DSH's extension point is the slot registry (`ctx.slots`), not a source edit.
 * Two upstream-declared `list` slots are filled, so both registrations append
 * rather than replace:
 *
 * | Slot | Declared by | Contribution |
 * |---|---|---|
 * | `sidebar.footer.action` | `ui-sidebar` | the entry at the sidebar foot |
 * | `shell.overlay` | `ui-layout` | the panel itself |
 *
 * Data comes from the KVVI platform service, not from DSH: the platform is the
 * only process that knows who this session is, which company they belong to,
 * and what they may do. The DSH runtime knows no tenant and must not.
 *
 * This module carries no JSX: the client bundle entry is fixed at
 * `src/client/index.ts`, so every component lives beside it in `Panel.tsx`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createKvviEntry, createKvviOverlay } from './Panel.tsx'

/** Key distinguishing this package's occupants inside both `list` slots. */
const KVVI_PANEL_ID = '@deepseek-ai/dsh-client-kvvi-panel'

/** Services this browser half requires. Only the slot registry is mandatory. */
export const inject = ['slots']

/**
 * Register this package's sidebar entry and overlay.
 *
 * The entry and the panel are two halves of one thing, so they share an open
 * flag held here: putting it in either component's local state would leave the
 * button unable to reach the panel. Subscribers are notified through the
 * renderer's own binding rather than a bespoke subscription in the components.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
      { name: 'sidebar.footer.action', id: KVVI_PANEL_ID },
      createKvviEntry(),
    )),
    'kvvi-panel: sidebar entry',
  )

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: KVVI_PANEL_ID },
      createKvviOverlay(),
    )),
    'kvvi-panel: business panel',
  )
}

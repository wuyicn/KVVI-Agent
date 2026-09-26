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
 * Copy comes from this package's own namespace. Both registrations declare
 * `locale`, which is what puts the typed `t` seat on their components.
 *
 * This module carries no JSX: the client bundle entry is fixed at
 * `src/client/index.ts`, so every component lives beside it in other files.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createKvviEntry, createKvviOverlay } from './Panel.tsx'
import { en, NS, zh, type KvviKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Business-panel copy: the systems list, the form/list/detail views, refusals. */
    kvviPanel: KvviKey
  }
}

/** Key distinguishing this package's occupants inside both `list` slots. */
const KVVI_PANEL_ID = '@deepseek-ai/dsh-client-kvvi-panel'

/** Services this browser half requires: the slot registry and the dictionary. */
export const inject = ['slots', 'locale']

/**
 * Register this package's dictionaries, sidebar entry and overlay.
 *
 * The entry and the panel are two halves of one thing, so they share an open
 * flag held inside the overlay: putting it in either component's local state
 * would leave the button unable to reach the panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'kvvi-panel: dictionaries')

  ctx.effect(
    () => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
      { name: 'sidebar.footer.action', id: KVVI_PANEL_ID, locale: NS },
      createKvviEntry(),
    )),
    'kvvi-panel: sidebar entry',
  )

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: KVVI_PANEL_ID, locale: NS },
      createKvviOverlay(),
    )),
    'kvvi-panel: business panel',
  )
}

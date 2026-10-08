/** KVVI UI contributes a global business page, authenticated account area and
 * session-bound resources through DSH slots and injected services. The platform
 * remains the sole authority for identity, tenant membership and permissions.
 * The legacy overlay stays available to existing callers.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createKvviOverlay } from './Panel.tsx'
import { SessionBanner, type SessionBannerInjected } from './SessionBanner.tsx'
import { SessionNoticeController } from './session-notice.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BusinessPage, BusinessIcon } from './BusinessPage.tsx'
import { AccountArea } from './AccountArea.tsx'
import { BusinessHeader } from './BusinessHeader.tsx'
import { BusinessBody } from './BusinessBody.tsx'
import { businessAddress, businessDefinition, BUSINESS_TAB_ID } from './business-tabs.ts'
import { createBusinessStore } from './business-store.ts'
import { en, NS, zh, type KvviKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Business-panel copy: the systems list, the form/list/detail views, refusals. */
    kvviPanel: KvviKey
  }
}

/** Key distinguishing this package's occupants inside both `list` slots. */
const KVVI_PANEL_ID = '@deepseek-ai/dsh-client-kvvi-panel'

/** A distinct key: the banner and the panel are independent occupants. */
const KVVI_SESSION_ID = '@deepseek-ai/dsh-client-kvvi-panel/session-banner'

/** Services this browser half requires: the slot registry and the dictionary. */
export const inject = ['slots', 'locale', 'layout', 'sidebarRight', 'sidebarRightTabs']

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

  // The sign-in-end notice. The wrapper sees every response the page makes —
  // the runtime RPC, the platform's own endpoints, and the product API — which
  // is the only layer that covers all three sources. `ctx.effect` owns its
  // disposer so a plugin reload cannot stack wrappers.
  const notice = new SessionNoticeController()
  ctx.effect(() => notice.install(), 'kvvi-panel: session notice watcher')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: KVVI_SESSION_ID,
    locale: NS,
    inject: (): SessionBannerInjected => ({
      hooks: { sessionNotice: notice.state },
      relogin: (code: string) => {
        // The reason travels in the query so the login page can say which kind
        // of ending this was; an unexplained login page is what we are fixing.
        globalThis.location.assign('/kvvi/login?error=' + encodeURIComponent(code))
      },
    }),
  }, SessionBanner))

  const t = ctx.locale.bind(NS)
  const panelId = 'kvvi-business' as MainPanelId
  ctx.effect(() => ctx.sidebarRightTabs.register(businessDefinition(t)), 'kvvi-panel: business resource type')
  const store = createBusinessStore()
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: BUSINESS_TAB_ID, locale: NS, store,
  }, BusinessBody))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: KVVI_PANEL_ID, locale: NS,
    inject: () => ({
      open: (assetId, mode) => { ctx.sidebarRight.openResource(businessAddress(assetId, mode)) },
      choose: () => { ctx.layout.selectPanel(panelId) },
    }),
  }, BusinessHeader))
  ctx.slots.inject('settings.account', () => ctx.slots.register({ name: 'settings.account', locale: NS }, AccountArea))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: -10, label: () => t('panel.title'),
  }, BusinessIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: NS,
    inject: () => ({
      back: () => { ctx.layout.selectPanel(null) },
      openDock: (sessionId, system, mode) => {
        ctx.layout.selectPanel(null)
        ctx.sidebarRight.openResourceIn(sessionId, businessAddress(system.assetId, mode))
      },
    }),
  }, BusinessPage))

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: KVVI_PANEL_ID, locale: NS },
      createKvviOverlay(),
    )),
    'kvvi-panel: business panel',
  )
}

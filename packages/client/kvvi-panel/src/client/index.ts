/** KVVI UI contributes a global business page, authenticated account area and
 * session-bound resources through DSH slots and injected services. The platform
 * remains the sole authority for identity, tenant membership and permissions.
 * The legacy overlay stays available to existing callers.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createKvviOverlay, KVVI_OPEN_EVENT } from './Panel.tsx'
import { SessionBanner, type SessionBannerInjected } from './SessionBanner.tsx'
import { SessionNoticeController } from './session-notice.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BusinessPage, BusinessIcon, BusinessSession, type BusinessPageInjected } from './BusinessPage.tsx'
import { AccountArea } from './AccountArea.tsx'
import { BusinessHeader } from './BusinessHeader.tsx'
import { BusinessActivity } from './BusinessActivity.tsx'
import { BusinessBody } from './BusinessBody.tsx'
import { businessAddress, businessDefinition, BUSINESS_TAB_ID } from './business-tabs.ts'
import { createBusinessStore } from './business-store.ts'
import { en, NS, zh, type KvviKey } from './locales.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { kvviBusiness: unknown }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'kvvi.business.session': { kind: 'single'; scope: 'session'; owner: { address: string; navigate: (address: string) => void; assistant?: boolean } }
  }
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
export const inject = ['slots', 'locale', 'layout', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace', 'sessions', 'workspaces']

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
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: KVVI_PANEL_ID + '/activity', store,
    inject: sessionId => ({ afterWrite: (assetId: string) => {
      ctx.sidebarRight.openResourceIn(sessionId, businessAddress(assetId, 'records'))
    } }),
  }, BusinessActivity))
  ctx.slots.inject('settings.account', () => ctx.slots.register({ name: 'settings.account', locale: NS }, AccountArea))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: -10, label: () => t('panel.title'),
  }, BusinessIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: NS, store: createBusinessStore(),
    children: { 'kvvi.business.session': { kind: 'single', scope: 'session' } },
    inject: (): BusinessPageInjected => ({
      back: () => { ctx.layout.selectPanel(null) },
      manage: () => { globalThis.dispatchEvent(new Event(KVVI_OPEN_EVENT)) },
      bindBusiness: async (system, current, workspaceId) => {
        const matches = ctx.workspaces.list.getSnapshot().items.filter(w => workspaceId === undefined
          ? w.title === system.name || w.title === system.assetId || w.title === system.name + '系统'
          : w.workspaceId === workspaceId)
        if (matches.length !== 1) return undefined
        const workspace = matches[0]
        if (workspace === undefined) return undefined
        const id = current !== undefined && workspace.sessionIds.includes(current)
          ? current : await ctx.uiWorkspace.connectWorkspace(workspace.workspaceId)
        const reference = ctx.sessions.retain(id, { source: 'kvviBusiness' })
        try { await reference.ready; return reference } catch (error) { reference.release(); throw error }
      },
    }),
  }, BusinessPage))

  ctx.slots.inject('kvvi.business.session', () => ctx.slots.register({
    name: 'kvvi.business.session', locale: NS, store,
  }, BusinessSession))

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: KVVI_PANEL_ID, locale: NS },
      createKvviOverlay(),
    )),
    'kvvi-panel: business panel',
  )
}

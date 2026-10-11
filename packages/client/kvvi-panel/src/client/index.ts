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
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import { BusinessPage, BusinessIcon, BusinessSession, type BusinessPageInjected, type BusinessSessionInjected } from './BusinessPage.tsx'
import { AccountArea } from './AccountArea.tsx'
import { BusinessHeader } from './BusinessHeader.tsx'
import { BusinessActivity } from './BusinessActivity.tsx'
import { BusinessBody } from './BusinessBody.tsx'
import { businessAddress, businessDefinition, BUSINESS_TAB_ID } from './business-tabs.ts'
import { createBusinessStore } from './business-store.ts'
import { en, NS, zh, type KvviKey } from './locales.ts'
import { readEntrance, request } from './api.ts'
import { businessFromHint, businessWorkspace, editWorkspace, parseBusinessHint, type BusinessHint } from './business-binding.ts'
import { loadDirectory } from './business-directory-api.ts'
import { createBuilderStarter } from './builder-start.ts'
import type { SubmissionHandle } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { kvviBusiness: unknown }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'kvvi.business.session': { kind: 'single'; scope: 'session'; owner: { identity: string; address: string; navigate: (address: string) => void; assistant?: boolean } }
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
export const inject = ['slots', 'locale', 'layout', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace', 'sessions', 'workspaces', 'remote', 'remote.workspaceFiles', 'remote.workspace', 'conversation']

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
  const readHint = async (sessionId: import('@deepseek-ai/dsh-session/types').SessionId, signal: AbortSignal): Promise<BusinessHint> => {
    const result = await ctx.remote.workspaceFiles.read(sessionId, '.kvvi-system.json', { offset: 1, limit: 128 }, signal)
    if (!result.ok) return { kind: result.error.code === 'workspace-file/not-found' ? 'absent' : 'unavailable' }
    return parseBusinessHint(result.value.text, result.value.eof)
  }
  const submissions = new Map<string, SubmissionHandle>()
  const sessionAssets = new Map<SessionId, string>()
  const startBuilder = createBuilderStarter({
    createDirectory: async (intentId) => {
      const result = await request<{ path: string }>('POST', '/api/kvvi-business-directory/' + encodeURIComponent(intentId), undefined, undefined, '')
      if (!result.ok) throw new Error(result.code)
      if (typeof result.value.path !== 'string' || !result.value.path) throw new Error('KVVI_BAD_RESPONSE')
      return result.value.path
    },
    createWorkspace: async (path, name) => {
      const workspace = await ctx.workspaces.create({ path })
      const titles = new Set(ctx.workspaces.list.getSnapshot().items.filter(w => w.workspaceId !== workspace.workspaceId).map(w => w.title))
      const base = name || t('business.untitled')
      let title = base, suffix = 2
      while (titles.has(title)) title = `${base} (${String(suffix++)})`
      // The Host owns title uniqueness; another client may win after our snapshot.
      // Its Workspace feed publishes the accepted title to all clients.
      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await ctx.remote.workspace.rename({ workspaceId: workspace.workspaceId, title })
        if (result.ok) return result.value.workspace
        if (result.error.code !== 'workspace/name-conflict') throw new Error(result.error.code)
        title = `${base} (${String(suffix++)})`
        while (titles.has(title)) title = `${base} (${String(suffix++)})`
      }
      throw new Error('KVVI_BUILD_NAME_CONFLICT')
    },
    createSession: workspace => ctx.sessions.create({ workspaceId: workspace.workspaceId }),
    send: async (id, text, operation) => {
      const reference = ctx.sessions.retain(id, { source: 'kvviBusiness' })
      try {
        const { session } = await reference.ready
        ctx.uiWorkspace.openSession(id)
        let submission = submissions.get(operation)
        if (submission === undefined) {
          submission = session.beginSubmission({ mode: 'queue', text, attachments: [] })
          submissions.set(operation, submission)
        }
        const result = await session.prompt([{ type: 'text', text }], 'queue', undefined, submission.requestId)
        if (!result.ok) throw result.error
      } finally { reference.release() }
    },
  })
  const panelId = 'kvvi-business' as MainPanelId
  let resumeBuild = new URLSearchParams(globalThis.location.search).get('kvvi-new-form') === '1'
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
      resolveBusiness: async (sessionId, systems, signal) => {
        const hint = await readHint(sessionId, signal)
        const workspace = ctx.workspaces.list.getSnapshot().items.find(w => w.sessionIds.includes(sessionId))
        const name = workspace?.title ?? ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd?.split(/[\\/]/u).filter(Boolean).at(-1)
        return businessFromHint(systems, name, hint)
      },
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
      consumeBuildResume: () => { const pending = resumeBuild; resumeBuild = false; return pending },
      enterBuilder: async () => {
        const result = await request('POST', '/auth/enter-builder', {}, undefined, '', { 'x-kvvi-builder-intent': '1' })
        if (!result.ok) throw new Error(result.code)
        // Reconnect the Host with the new authenticated identity before building.
        globalThis.location.assign('/?kvvi-new-form=1')
      },
      startBuilder: async (name, intentId) => {
        const entrance = await readEntrance()
        if (!entrance.ok || entrance.value.gateway !== 'BUILDER') throw new Error('KVVI_NOT_ALLOWED')
        await startBuilder(name, intentId)
      },
      designBusiness: async (assetId, explicitWorkspace) => {
        const entrance = await readEntrance()
        if (!entrance.ok || entrance.value.gateway !== 'BUILDER') throw new Error('KVVI_NOT_ALLOWED')
        const directory = await loadDirectory({ archived: false })
        if (!directory.ok || !directory.value.forms.some(f => f.assetId === assetId)) throw new Error('KVVI_NOT_ALLOWED')
        const controller = new AbortController()
        const candidates = await Promise.all(ctx.workspaces.list.getSnapshot().items.map(async w => ({
          workspaceId: w.workspaceId,
          hint: w.sessionIds[0] === undefined ? { kind: 'unavailable' } as const : await readHint(w.sessionIds[0], controller.signal),
        })))
        const workspaceId = editWorkspace(candidates, assetId, explicitWorkspace)
        if (workspaceId === undefined) throw new Error('KVVI_WORKSPACE_REQUIRED')
        const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
        if (workspace === undefined) throw new Error('KVVI_BAD_REQUEST')
        const id = await ctx.sessions.create({ workspaceId: workspace.workspaceId })
        const reference = ctx.sessions.retain(id, { source: 'kvviBusiness' })
        try {
          const { session } = await reference.ready
          ctx.uiWorkspace.openSession(id)
          const text = `请协助编辑现有表单，资产代号为 ${assetId}。先检查本工作区契约是否属于这个资产，不一致时停止并请我确认。`
            + '只修改草稿，不改员工正在使用的已发布版本；提交前交给我检查，仍由所有者审批发布。'
          const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] })
          const result = await session.prompt([{ type: 'text', text }], 'queue', undefined, submission.requestId)
          if (!result.ok) throw result.error
        } finally { reference.release() }
      },
      back: () => { ctx.layout.selectPanel(null) },
      manage: () => { globalThis.dispatchEvent(new Event(KVVI_OPEN_EVENT)) },
      bindBusiness: async (system, current, workspaceId, signal) => {
        const directory = await loadDirectory({ signal })
        if (!directory.ok) return undefined
        const candidates = await Promise.all(ctx.workspaces.list.getSnapshot().items.map(async (workspace) => {
          const representative = workspace.sessionIds[0]
          const hint = representative === undefined ? { kind: 'unavailable' } as const : await readHint(representative, signal)
          return { ...workspace, hint }
        }))
        signal.throwIfAborted()
        const workspace = businessWorkspace(candidates, directory.value.forms, system.assetId, workspaceId)
        if (workspace === undefined) return undefined
        const known = workspace.sessionIds.find(id => sessionAssets.get(id) === system.assetId)
        const chosen = current !== undefined && workspace.sessionIds.includes(current) ? current
          : known ?? (workspace.hint.kind === 'selected' ? workspace.sessionIds[0] : undefined)
        // An unmarked workspace never adopts an unrelated conversation or its unsent draft.
        const reuse = chosen !== undefined && (sessionAssets.get(chosen) === system.assetId
          || workspace.hint.kind === 'selected' && !sessionAssets.has(chosen))
        const id = reuse ? chosen : await ctx.sessions.create({ workspaceId: workspace.workspaceId })
        signal.throwIfAborted()
        sessionAssets.set(id, system.assetId)
        const reference = ctx.sessions.retain(id, { source: 'kvviBusiness', signal })
        try { await reference.ready; signal.throwIfAborted(); return reference } catch (error) { reference.release(); throw error }
      },
    }),
  }, BusinessPage))

  if (resumeBuild) {
    ctx.effect(function* () {
      ctx.layout.selectPanel(panelId)
      const url = new URL(globalThis.location.href)
      url.searchParams.delete('kvvi-new-form')
      globalThis.history.replaceState(globalThis.history.state, '', url)
    }, 'kvvi-panel: resume new form')
  }

  ctx.slots.inject('kvvi.business.session', () => ctx.slots.register({
    name: 'kvvi.business.session', locale: NS, store,
    inject: (sessionId): BusinessSessionInjected => ({
      hooks: { businessComposerBlock: ctx.conversation.blocks.storeFor(sessionId) },
      insertContext: (text, revision) => {
        const scope = ctx.sessions.scope(sessionId)
        if (scope === undefined || ctx.conversation.blocks.storeFor(sessionId).getSnapshot() !== undefined) return
        const input = ctx.conversation.input.for(scope).state.getSnapshot()
        if (input.phase !== 'plain' || input.draftRev !== revision) return
        scope.bail('slash/input-insert-text', { text, span: { start: 0, end: 0, draftRev: revision } })
      },
    }),
  }, BusinessSession))

  ctx.effect(
    () => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: KVVI_PANEL_ID, locale: NS },
      createKvviOverlay(),
    )),
    'kvvi-panel: business panel',
  )
}

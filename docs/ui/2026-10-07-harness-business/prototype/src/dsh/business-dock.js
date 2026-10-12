import { SidebarRightTabRegistry } from '@dsh-right/tab-registry.ts';
import { createSidebarRightStore } from '@dsh-right/stores.ts';
import { createSidebarRightController } from '@dsh-right/service.ts';
import { defaultSeed } from '@dsh-right/contract/seed.ts';
import { guideDefinition } from '@dsh-right/tabs/guide/definition.ts';
import { zh } from '@dsh-right/locales.ts';

export const translate = (key) => zh[key] ?? key;

/** Frontend-only lifetime adapter. No Cordis/plugin boot, backend, or tool runner
 * is installed here. The original registry only needs an effect owner; its
 * definitions, routing, store, controller and tab lifetimes remain upstream. */
function effectOwner() {
  const effects = new Set();
  return {
    effect(setup) {
      const cleanup = setup(); let active = true;
      const dispose = () => { if (!active) return; active = false; effects.delete(dispose); cleanup?.(); };
      effects.add(dispose); return dispose;
    },
    dispose() { for (const dispose of [...effects]) dispose(); },
  };
}

export function createBusinessDock(sessionId, business, builder = false) {
  const owner = effectOwner();
  let currentBusiness = business;
  const registry = new SidebarRightTabRegistry(owner);
  registry.register(guideDefinition(translate));
  registry.register({ id: 'kvvi-prototype/assistant', kind: 'kvvi-assistant', title: () => 'AI协助' });
  registry.register({
    id: 'kvvi-prototype/form', kind: 'kvvi-form', title: () => currentBusiness.formName,
    guide: [{ id: 'form', order: 10, title: () => currentBusiness.formName, description: () => '填写当前业务表单' }],
  });
  registry.register({
    id: 'kvvi-prototype/records', kind: 'kvvi-records', title: () => '业务记录',
    guide: [{ id: 'records', order: 20, title: () => '业务记录', description: () => '查看已提交的示例记录' }],
  });
  registry.register({
    id: 'kvvi-prototype/record', kind: 'kvvi-record',
    patterns: ['dsh-resource://kvvi-prototype/record/*'],
    canOpen: (address) => recordIdFromAddress(address) !== null,
    title: () => '记录详情',
  });
  if (builder) registry.register({
    id: 'kvvi-prototype/config', kind: 'kvvi-config', title: () => '业务配置',
    guide: [{ id: 'config', order: 30, title: () => '业务配置', description: () => '查看字段与发布设置' }],
  });
  const store = createSidebarRightStore(() => defaultSeed(registry)).create(sessionId);
  store.actions.open(sessionId);
  // Records already live in React memory; there is no external resource lease.
  const service = createSidebarRightController(registry, () => {});
  const release = service.adopt(sessionId, store);
  const { controller } = service;
  return {
    sessionId, registry, actions: store.actions, getSnapshot: store.getSnapshot, subscribe: store.subscribe,
    updateBusiness(next) { currentBusiness = next; },
    bindService: controller.bind.bind(controller),
    occurrence: (tab) => controller.tabDomain.occurrence(sessionId, tab),
    openTab: (kind, options) => controller.openTabIn(sessionId, kind, options),
    openAssistant: (options) => controller.openTabIn(sessionId, 'kvvi-assistant', options),
    openForm: (options) => controller.openTabIn(sessionId, 'kvvi-form', options),
    openRecords: (options) => controller.openTabIn(sessionId, 'kvvi-records', options),
    openRecord: (id, options) => controller.openResourceIn(sessionId, recordAddress(id), options),
    close: (id) => controller.closeIn(sessionId, id),
    toggle: () => store.actions.toggleExpanded(sessionId),
    collapse: () => store.actions.setExpanded(sessionId, false),
    dispose() { release(); controller.tabDomain.dispose(); owner.dispose(); },
  };
}
export function recordAddress(id) { return `dsh-resource://kvvi-prototype/record/${encodeURIComponent(id)}`; }
export function recordIdFromAddress(address) {
  const match = /^dsh-resource:\/\/kvvi-prototype\/record\/([^/?#]+)$/.exec(address);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

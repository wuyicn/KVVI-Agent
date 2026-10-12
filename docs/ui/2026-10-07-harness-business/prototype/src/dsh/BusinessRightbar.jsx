import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { RightbarSeat } from '@dsh-right/shell/SidebarRight.tsx';
import { tabInfoFactory } from '@dsh-right/tab-info.ts';
import { GuideBody } from '@dsh-right/tabs/guide/GuideBody.tsx';
import { GuideTitle } from '@dsh-right/tabs/guide/GuideTitle.tsx';
import { createBusinessDock, recordIdFromAddress, translate } from './business-dock.js';
import '@dsh-theme/base.css';
import '@dsh-theme/design-platform.css';
import '@dsh-theme/gradient-shadow-text.css';

// Frontend session host. Switching the visible session keeps its adopted store
// alive, like the DSH runtime. A view hot-update must not abort occurrences
// still mounted by React Refresh; this frontend host lives with the window.
// Full reload reconstructs it from upstream's validated layout persistence.
const sessions = import.meta.hot?.data.sessions ?? new Map();
if (import.meta.hot) import.meta.hot.dispose(data => { data.sessions = sessions; });
const Model = createContext(null);
const fallback = (_seat, _props, options) => options.fallback;

export function useBusinessDock(scope, business, builder) {
  const dock = useMemo(() => {
    if (!sessions.has(scope)) sessions.set(scope, createBusinessDock(scope, business, builder));
    return sessions.get(scope);
  }, [scope]);
  dock.updateBusiness(business);
  const snapshot = useSyncExternalStore(dock.subscribe, dock.getSnapshot, dock.getSnapshot);
  return { dock, layout: snapshot.bySession[scope].layout };
}

export function useViewportWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  return width;
}

/** Stage two: bodies/titles registered under the definitions' identities.
 * This small slot bridge supplies the original slot-owned useTabInfo hook.
 * Layout/drag/lifetime/navigation are not reimplemented here. */
function TabContent({ dock, context, entryKey, title }) {
  const model = useContext(Model);
  const useTabInfo = useMemo(() => tabInfoFactory({ sessionId: dock.sessionId }, context), [dock, context]);
  const { tab, panel } = useTabInfo();
  const activePane = model.hooks.useStore(state => state.bySession[dock.sessionId].layout.activePaneId);
  const row = model.records.find(r => r.id === recordIdFromAddress(tab.navigation.address));
  // Business conversation context follows the focused detail, not the last
  // list row clicked. Other visible panes and title slots must not compete.
  useEffect(() => {
    if (!title && tab.kind === 'kvvi-record' && tab.visible && activePane === panel.id && row) model.selectRecord(row.id);
  }, [title, tab.kind, tab.visible, activePane, panel.id, row?.id, model.selectRecord]);
  if (entryKey === '@deepseek-ai/dsh-client-ui-sidebar-right/guide') {
    return title ? <GuideTitle useTabInfo={useTabInfo}/> : <GuideBody useTabInfo={useTabInfo}
      useGuideEntries={model.hooks.useGuideEntries} renderSlot={fallback} renderSlotChain={fallback}/>;
  }
  if (title) return entryKey === 'kvvi-prototype/form' ? model.business.formName
    : entryKey === 'kvvi-prototype/records' ? model.recordsTitle
    : entryKey === 'kvvi-prototype/record' ? row?.values[model.business.fields[0]?.id] || '记录详情' : tab.title;
  const Body = model.bodies[entryKey];
  return Body ? <div className="dock-business-content"><Body {...model} tab={tab} row={row}/></div>
    : <p className="muted">这类内容还没有可用的查看方式。</p>;
}

function hooksFor(dock) {
  const typesSnapshot = () => dock.registry.entries();
  const guideSnapshot = () => dock.registry.guide();
  const subscribeTypes = dock.registry.subscribe.bind(dock.registry);
  return {
    useStore: (select) => select(useSyncExternalStore(dock.subscribe, dock.getSnapshot, dock.getSnapshot)),
    useTabTypes: (select) => select(useSyncExternalStore(subscribeTypes, typesSnapshot, typesSnapshot)),
    useGuideEntries: (select) => select(useSyncExternalStore(subscribeTypes, guideSnapshot, guideSnapshot)),
    useTabNavigation: (id) => {
      const navigation = dock.occurrence({ id }).navigation;
      return useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
    },
  };
}

export function BusinessRightbar({ dock, width, viewportWidth, syncPresentation, model, side = 'right' }) {
  const seat = useRef(null);
  const hooks = useMemo(() => hooksFor(dock), [dock]);
  // Upstream brings an active chip into view when tabs change, but not when
  // its frame becomes narrower. Complete the host's resize seam without
  // remounting tab bodies, changing the layout, or overriding docking styles.
  useEffect(() => {
    for (const strip of seat.current?.querySelectorAll('[data-dockkit-strip-tabs]') ?? []) {
      const active = strip.querySelector('[data-dockkit-tab][aria-selected="true"]');
      if (!active) continue;
      const bounds = strip.getBoundingClientRect(), rect = active.getBoundingClientRect();
      if (rect.left < bounds.left) strip.scrollLeft += rect.left - bounds.left - 24;
      else if (rect.right > bounds.right) strip.scrollLeft += rect.right - bounds.right + 24;
    }
  }, [width, viewportWidth]);
  const renderSlot = useMemo(() => (seat, _props, options) => {
    if (seat === 'sidebar.right.tab.menu.item') return null;
    return <TabContent dock={dock} context={options.hookContext} entryKey={options.entryKey}
      title={seat === 'sidebar.right.pane.tab.title'}/>;
  }, [dock]);
  return <Model.Provider value={{ ...model, hooks }}><div ref={seat} className="dock-seat-host"><RightbarSeat
    sessionId={dock.sessionId} width={width} viewportWidth={viewportWidth} canShow={true}
    {...hooks} actions={dock.actions} t={side === 'left' ? translateLeft : translate} renderSlot={renderSlot}
    syncPresentation={syncPresentation} bindService={dock.bindService}
    openTab={dock.openTab} closeTab={dock.close} occurrence={dock.occurrence}/></div></Model.Provider>;
}

/** Frame-owned resize seam, matching DSH's pointer capture + rAF convention.
 * The sidebar package itself owns no outer column width or resize handle. */
const translateLeft = key => ['chrome.collapse', 'chrome.collapseAria'].includes(key) ? '收起辅助栏' : translate(key);

export function BusinessColumnResize({ width, maxWidth, onResize, side = 'right' }) {
  const direction = side === 'left' ? 1 : -1;
  const drag = useRef(null), frame = useRef(null);
  const finish = (event) => {
    if (!drag.current || (event && event.pointerId !== drag.current.id)) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const { element, id } = drag.current; drag.current = null;
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
  };
  useEffect(() => () => finish(), []);
  return <div className="dock-column-resize" role="separator" aria-label="调整辅助栏宽度" aria-orientation="vertical"
    aria-valuemin={280} aria-valuemax={Math.round(maxWidth)} aria-valuenow={Math.round(width)} tabIndex={0}
    onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); onResize(width + direction * (e.key === 'ArrowRight' ? 40 : -40)); } }}
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { id: e.pointerId, x: e.clientX, width, element: e.currentTarget }; }}
    onPointerMove={e => { if (drag.current?.id !== e.pointerId) return;
      const next = drag.current.width + direction * (e.clientX - drag.current.x);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => { frame.current = null; onResize(next); }); }}
    onPointerUp={e => { if (drag.current?.id === e.pointerId) onResize(drag.current.width + direction * (e.clientX - drag.current.x)); finish(e); }}
    onPointerCancel={finish} onLostPointerCapture={finish}/>;
}

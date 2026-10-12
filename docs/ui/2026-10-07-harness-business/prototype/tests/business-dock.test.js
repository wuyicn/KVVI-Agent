import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockPaneIds } from '@deepseek-ai/dsh-client-ui-dockkit';
import { createBusinessDock, recordAddress, recordIdFromAddress } from '../src/dsh/business-dock.js';

const business = { id: 'customer', formName: '客户登记', fields: [] };
let docks;
beforeEach(() => {
  docks = [];
  const values = new Map();
  vi.stubGlobal('localStorage', {
    get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key),
  });
});
afterEach(() => { docks.forEach(d => d.dispose()); vi.unstubAllGlobals(); });
const make = (scope = 'kvvi-prototype:employee:customer:intro') => {
  const dock = createBusinessDock(scope, business); docks.push(dock); return dock;
};
const layout = (dock) => dock.getSnapshot().bySession[dock.sessionId].layout;
const tabs = (dock) => Object.values(layout(dock).tabs);

describe('business registration against the actual DSH sidebar store and controller', () => {
  it('opens contextual AI and record detail as tabs in one pane without duplicating AI', () => {
    const dock = make('business-hub:builder:gad:orders');
    dock.openAssistant(); dock.openRecord('order-1'); dock.openAssistant();
    expect(tabs(dock).filter(t => t.kind === 'kvvi-assistant')).toHaveLength(1);
    expect(tabs(dock).filter(t => t.kind === 'kvvi-record')).toHaveLength(1);
    expect(dockPaneIds(layout(dock))).toHaveLength(1);
    dock.collapse(); expect(layout(dock).expanded).toBe(false);
    dock.openAssistant(); expect(layout(dock).expanded).toBe(true);
  });
  it('reopens a form without duplicate tabs and protects the sole start tab', () => {
    const dock = make(); dock.toggle();
    const guide = tabs(dock)[0]; dock.close(guide.id);
    expect(tabs(dock)).toHaveLength(1);
    dock.openForm(); dock.openForm();
    expect(tabs(dock).filter(t => t.kind === 'kvvi-form')).toHaveLength(1);
  });
  it('reveals the same record, keeps other record addresses independent, and ends closed lifetimes', () => {
    const dock = make(); dock.openRecord('customer-1'); dock.openRecord('customer-2');
    const first = tabs(dock).find(t => t.contentId === recordAddress('customer-1'));
    const second = tabs(dock).find(t => t.contentId === recordAddress('customer-2'));
    const lifetime = dock.occurrence(first).signal;
    dock.openRecord('customer-1');
    expect(tabs(dock)).toHaveLength(2);
    expect(dock.occurrence(second).navigation.getSnapshot().address).toBe(recordAddress('customer-2'));
    dock.close(first.id); expect(lifetime.aborted).toBe(true);
    dock.close(second.id); expect(layout(dock).expanded).toBe(false);
  });
  it('returns to the session layout without sharing role, business, or conversation state', () => {
    const dock = make(); dock.openForm();
    for (const scope of ['kvvi-prototype:owner:customer:intro', 'kvvi-prototype:employee:leave:intro', 'kvvi-prototype:employee:customer:new']) {
      const other = make(scope); expect(layout(other).expanded).toBe(false); expect(tabs(other)).toHaveLength(0);
    }
    expect(tabs(dock)[0].kind).toBe('kvvi-form');
  });
  it('replaces a submitted form with its record and uses the product two-pane limit', () => {
    const dock = make(); dock.openForm();
    const form = tabs(dock)[0]; dock.openRecord('saved', { replaceTab: form.id });
    expect(tabs(dock).map(t => t.kind)).toEqual(['kvvi-record']);
    // The seat normally supplies the measured room rule. Here the host has
    // room, while the store/controller must still enforce the product cap.
    dock.bindService({ sessionId: dock.sessionId, actions: dock.actions,
      surfaces: dock.getSnapshot().bySession, canSplitPane: () => true });
    dock.openRecords({ preferNewPane: true });
    dock.openForm({ preferNewPane: true });
    expect(dockPaneIds(layout(dock))).toHaveLength(2);
  });
  it('restores validated layout, fullscreen and floating panes, and rejects damaged snapshots', () => {
    const dock = make(); dock.openForm(); const tab = tabs(dock)[0];
    dock.actions.setMode(dock.sessionId, 'fullscreen');
    dock.actions.floatTab(dock.sessionId, tab.id, { x: 50, y: 60, width: 420, height: 500 });
    const restored = make();
    expect(layout(restored).mode).toBe('fullscreen'); expect(layout(restored).floats).toHaveLength(1);
    expect(tabs(restored).some(t => t.id === tab.id)).toBe(true);
    localStorage.setItem(`dsh.sidebar-right.v1.${dock.sessionId}`, '{broken');
    const clean = make(); expect(tabs(clean)).toHaveLength(0); expect(layout(clean).expanded).toBe(false);
  });
  it('accepts only the registered in-memory record address family', () => {
    expect(recordIdFromAddress(recordAddress('客户 1'))).toBe('客户 1');
    expect(recordIdFromAddress('dsh-resource://other/record/1')).toBeNull();
    expect(recordIdFromAddress('dsh-resource://kvvi-prototype/record/%ZZ')).toBeNull();
    expect(recordIdFromAddress('dsh-resource://kvvi-prototype/record/1?other=2')).toBeNull();
  });
});

import { it, expect } from 'vitest';
import * as model from '../src/business-hub-data.js';

it('shows published forms in a newly created group without exposing drafts to employees', () => {
  expect(model.visibleBusinessResources).toBeTypeOf('function');
  const resources = [{id:'g',kind:'group',published:false}, {id:'a',kind:'form',group:'g',published:true}, {id:'b',kind:'form',group:'g',published:false}];
  expect(model.visibleBusinessResources(resources, false).map(r => r.id)).toEqual(['g','a']);
  expect(model.visibleBusinessResources(resources, true)).toEqual(resources);
});

it('unifies all existing forms under a single business with flat groups and preserves records', () => {
  expect(model.initialGroupedHubData).toBeTypeOf('function');
  const old = model.initialHubData(), data = model.initialGroupedHubData();
  expect(data.systems).toHaveLength(1);
  expect(data.systems[0].name).toBe('业务');
  const resources = data.systems[0].resources;
  expect(resources.filter(r => r.kind !== 'group')).toHaveLength(old.systems.flatMap(s => s.resources).filter(r => r.kind !== 'group').length);
  expect(new Set(resources.map(r => r.id)).size).toBe(resources.length);
  expect(resources.filter(r => r.kind === 'group').every(r => !r.group)).toBe(true);
  expect(resources.filter(r => r.kind !== 'group').every(r => resources.some(g => g.id === r.group && g.kind === 'group'))).toBe(true);
  expect(data.records['business/gad:orders']).toEqual(old.records['gad/orders']);
  expect(resources.find(r => r.id === 'visitor:visitors').published).toBe(false);
});

it('removing a group keeps its forms and records available under ungrouped', () => {
  expect(model.removeBusinessGroup).toBeTypeOf('function');
  const data = model.initialGroupedHubData(), before = structuredClone(data);
  const group = data.systems[0].resources.find(r => r.id === 'gad:orders').group;
  const after = model.removeBusinessGroup(data, group);
  expect(after.systems[0].resources.some(r => r.id === group)).toBe(false);
  expect(after.systems[0].resources.find(r => r.id === 'gad:orders').group).toBe(null);
  expect(after.records).toEqual(before.records);
  expect(data).toEqual(before);
});

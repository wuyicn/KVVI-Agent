import { describe, it, expect } from 'vitest';
import * as dataModule from '../src/business-hub-data.js';

describe('direct business navigation', () => {
  it('opens the order workbench without an intermediate list', () => {
    expect(dataModule.businessDestination).toBeTypeOf('function');
    expect(dataModule.businessDestination(dataModule.initialHubData().systems, 'builder')).toEqual({ systemId: 'gad', pageId: 'orders' });
  });
  it('keeps the current business and form when returning from chat', () => {
    expect(dataModule.businessDestination(dataModule.initialHubData().systems, 'builder', 'customer', 'register')).toEqual({systemId:'customer', pageId:'register'});
  });
  it('does not take employees into draft businesses or draft pages', () => {
    const systems = dataModule.initialHubData().systems;
    expect(dataModule.businessDestination(systems, 'employee', 'visitor').systemId).toBe('gad');
    systems[0].resources.find(r => r.id === 'orders').published = false;
    expect(dataModule.businessDestination(systems, 'employee', 'gad', 'orders').pageId).not.toBe('orders');
  });
  it('handles an empty business or no available businesses', () => {
    expect(dataModule.businessDestination([{id:'empty',resources:[]}], 'builder')).toEqual({systemId:'empty',pageId:null});
    expect(dataModule.businessDestination([], 'employee')).toEqual({systemId:null,pageId:null});
  });
});

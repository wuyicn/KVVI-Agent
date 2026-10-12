import { describe, it, expect } from 'vitest';
import { initialHubData, prototypeReply } from '../src/business-hub-data.js';

describe('fusion prototype customer flow', () => {
  it('offers the actual customer fields instead of a generic name and note form', () => {
    const fields = initialHubData().systems.find(s => s.id === 'customer').resources[0].fields;
    expect(fields.map(f => f.id)).toEqual(['name', 'contact', 'phone', 'status', 'owner', 'note']);
    expect(fields.find(f => f.id === 'contact').required).toBe(true);
    expect(fields.find(f => f.id === 'status').options).toContain('初次接洽');
  });
  it('does not invent a monetary total when counting customer records', () => {
    expect(prototypeReply('多少条记录', null, [{values:{name:'示例客户'}}], '客户登记表')).toBe('客户登记表有 1 条记录。');
  });
  it('retains order totals when amounts exist', () => {
    expect(prototypeReply('总金额', null, [{values:{amount:'100'}}], '报货单')).toContain('100 元');
  });
});

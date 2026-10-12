import { describe, expect, it } from 'vitest';
import { initialFields, changePreview, checkTrial } from '../src/builder-preview-state.js';

describe('builder preview interactions (local demonstration only)', () => {
  it('updates only the named field without mutating the original preview', () => {
    const result = changePreview(initialFields, '把联系电话改为选填');
    expect(result.changed).toEqual(['phone']);
    expect(result.fields.find(f => f.id === 'phone').required).toBe(false);
    expect(initialFields.find(f => f.id === 'phone').required).toBe(true);
    expect(result.fields.find(f => f.id === 'account').required).toBe(true);
  });
  it('does not claim an unknown instruction was implemented', () => {
    const result = changePreview(initialFields, '自动扣款');
    expect(result.changed).toEqual([]);
    expect(result.supported).toBe(false);
    expect(result.fields).toEqual(initialFields);
  });
  it('checks required fields and duplicate example accounts without persistent writes', () => {
    expect(checkTrial(initialFields, {}).name).toBe('请填写店铺名称');
    expect(checkTrial(initialFields, { name: '示例店', platform: '淘宝', account: 'demo-shop', contact: '陈晓', phone: '13800000000', status: '在营' }).account).toBe('这个示例账号已登记，请换一个试试');
    expect(checkTrial(initialFields, { name: '示例店', platform: '淘宝', account: 'new-shop', contact: '陈晓', phone: '13800000000', status: '在营' })).toEqual({});
  });
});

import { expect, it } from 'vitest'
import { businessFromHint, parseBusinessHint } from '../src/client/business-binding.ts'
const customer = { assetId: 'customer', systemId: 's1', name: 'customer', schemaCode: 'customer', publishedAt: '' }
it('uses only a complete bounded explicit marker that resolves uniquely in the published catalogue', () => {
  expect(businessFromHint([customer], '客户登记系统', parseBusinessHint('{"assetId":"customer"}', true))).toEqual(customer)
  expect(businessFromHint([customer], 'customer', parseBusinessHint('{"assetId":"deleted"}', true))).toBeUndefined()
  expect(businessFromHint([customer, { ...customer, systemId: 's2' }], 'customer', parseBusinessHint('{"assetId":"customer"}', true))).toBeUndefined()
  for (const text of ['{', '{}', 'null', '{"assetId":1}', '{"assetId":""}', ' '.repeat(4097)]) {
    expect(businessFromHint([customer], 'customer', parseBusinessHint(text, true))).toBeUndefined()
  }
  expect(businessFromHint([customer], 'customer', parseBusinessHint('{"assetId":"customer"}', false))).toBeUndefined()
})
it('falls back to exact unique names only when the marker is absent', () => {
  expect(businessFromHint([customer], 'customer', { kind: 'absent' })).toEqual(customer)
  expect(businessFromHint([customer], 'customer', { kind: 'unavailable' })).toBeUndefined()
  expect(businessFromHint([customer, { ...customer, assetId: 'other' }], 'customer', { kind: 'absent' })).toBeUndefined()
  expect(businessFromHint([customer], 'customers', { kind: 'absent' })).toBeUndefined()
})

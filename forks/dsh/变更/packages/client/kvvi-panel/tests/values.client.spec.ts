import { describe,it,expect } from 'vitest'
import { coerceValue,displayString } from '../src/client/values.ts'

describe('typed editor wire values',()=>{
  it('keeps false/zero/arrays/null in their native JSON types',()=>{
    expect(coerceValue('boolean','false')).toBe(false)
    expect(coerceValue('integer','0')).toBe(0)
    expect(coerceValue('multi_select','a,b',{options:[{code:'a'},{code:'b'}]})).toEqual(['a','b'])
    expect(coerceValue('multi_select','',{options:[{code:'a'}]})).toEqual([])
    expect(coerceValue('integer','')).toBeNull()
  })
  it('never converts exact decimals or money amounts to a float',()=>{
    expect(coerceValue('decimal','12345678901234567890.123456789012',{precision:38,scale:12})).toBe('12345678901234567890.123456789012')
    expect(coerceValue('money','9007199254740993.01',{currency_mode:'FIXED',currency:'CNY'}))
      .toEqual({amount:'9007199254740993.01',currency:'CNY'})
    expect(displayString({amount:'12.30',currency:'CNY'})).toBe('12.30')
  })
  it('rejects invalid, truncated and unknown input instead of manufacturing null or text',()=>{
    for(const [type,input] of [['integer','7.5'],['integer','7x'],['integer','9007199254740993'],
      ['decimal','1e3'],['decimal','2.3x'],['boolean','maybe'],['guess','x']] as const) {
      expect(()=>coerceValue(type,input)).toThrow()
    }
    expect(()=>coerceValue('money','1.00')).toThrow()
  })
})

it('rejects excessive scale, malformed configuration and normalized calendar times',()=>{
  for(const [type,input,config] of [
    ['decimal','1.234',{precision:18,scale:2}],['decimal','10000000000000000',{}],
    ['decimal','1',{precision:2,scale:3}],['money','1.001',{currency_mode:'FIXED',currency:'CNY'}],
    ['money','1.0',{currency_mode:'FIXED',currency:'JPY'}], ['money','1',{currency_mode:'FIXED',currency:'XYZ'}],
    ['datetime','2026-10-19T24:00:00Z',{}],['datetime','2026-02-30T12:00:00Z',{}],
    ['datetime','0000-01-01T00:00:00Z',{}],['date','2026-10-19\n',{}],
    ['single_select','disabled',{options:[{code:'disabled',enabled:false}]}],
    ['multi_select','a,unknown',{options:[{code:'a'}]}],
  ] as const) expect(()=>coerceValue(type,input,config)).toThrow()
})

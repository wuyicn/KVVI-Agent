import { describe,it,expect } from 'vitest'
import { coerceValue,displayString,coerceCreateData } from '../src/client/values.ts'

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

it('coerces only authorized create fields and reports invalid values without an HTTP write',()=>{
  const fields=[{field_code:'title',type:'short_text'},{field_code:'flag',type:'boolean'},
    {field_code:'count',type:'integer',nullable:true},{field_code:'rate',type:'decimal',type_config:{precision:38,scale:12}},
    {field_code:'fee',type:'money',type_config:{currency_mode:'FIXED',currency:'CNY'}},
    {field_code:'tags',type:'multi_select',type_config:{options:[{code:'a'},{code:'b'}]}},
    {field_code:'locked',type:'short_text'},{field_code:'secret',type:'short_text'},
    {field_code:'system',type:'short_text',write_policy:'SYSTEM'}]
  const modes=Object.fromEntries(fields.map(f=>[f.field_code,f.field_code==='locked'?'READONLY':f.field_code==='secret'?'HIDDEN':'VISIBLE']))
  expect(coerceCreateData(fields,{title:'x',flag:'false',count:'',rate:'12345678901234567890.123456789012',fee:'9007199254740993.01',tags:'a,b',locked:'no',secret:'no',system:'no'},modes))
    .toEqual({data:{title:'x',flag:false,count:null,rate:'12345678901234567890.123456789012',fee:{amount:'9007199254740993.01',currency:'CNY'},tags:['a','b']},invalidFields:[]})
  expect(coerceCreateData(fields,{count:'7.5'},modes).invalidFields).toEqual(['count'])
  expect(coerceCreateData(fields,{flag:''},modes).data).toEqual({flag:false})
  expect(coerceCreateData(fields,{title:'x'},{}).data).toEqual({})
})

it('omits an empty optional nonnullable typed field instead of making it required',()=>{
  for(const type of ['integer','decimal','money','date','datetime','single_select']) {
    const field={field_code:'optional',type,required:false,nullable:false}
    expect(coerceCreateData([field],{optional:''},{optional:'VISIBLE'}))
      .toEqual({data:{},invalidFields:[]})
    expect(coerceCreateData([{...field,required:true}],{optional:''},{optional:'VISIBLE'}).invalidFields)
      .toEqual(['optional'])
  }
})

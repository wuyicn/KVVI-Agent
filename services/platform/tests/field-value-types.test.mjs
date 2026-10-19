import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,copyFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,dirname } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { checkFieldValues } from '../src/field-rules.mjs'

const check=(type,value,extra={})=>checkFieldValues({operation:'update',
  model:{fields:[{field_code:'value',type,nullable:true,...extra}]},data:{value}})
const options={options:[{code:'a'},{code:'b'},{code:'disabled',enabled:false}]}
const cases=[
  ['short_text','text',{},[true,7,{},[]]],
  ['long_text','long\ntext',{},[false,0,{},[]]],
  ['boolean',false,{},['false','true',0,1,{}]],
  ['integer',0,{},['0','7',1.5,Number.MAX_SAFE_INTEGER+1,true]],
  ['decimal','0.000000000001',{type_config:{precision:38,scale:12}},[0.1,'1e2','1.2x','01.2','NaN',{}]],
  ['money',{amount:'9007199254740993.01',currency:'CNY'},
    {type_config:{currency_mode:'FIXED',currency:'CNY'}},
    [12.34,'12.34',{amount:12.34,currency:'CNY'},{amount:'1.001',currency:'CNY'},
      {amount:'1.00',currency:'USD'},{amount:'1.00',currency:'CNY',extra:true}]],
  ['date','2024-02-29',{},['0000-01-01','2026-02-29','2026-02-30','2026-1-1',20261019]],
  ['datetime','2026-10-19T12:30:00+08:00',{},['0000-01-01T00:00:00Z','2026-02-30T12:30:00Z','2026-10-19T25:00:00Z','tomorrow',7]],
  ['single_select','a',{type_config:options},[['a'],'unknown','disabled',7]],
  ['multi_select',['a','b'],{type_config:options},['a,b',['a','a'],['unknown'],['disabled'],[7]]],
]

for(const [type,valid,extra,invalid] of cases) {
  test(`${type}: native valid value and null survive; coercions and invalid values are rejected`,()=>{
    assert.deepEqual(check(type,valid,extra),[])
    assert.deepEqual(check(type,null,extra),[])
    for(const value of invalid) assert.ok(check(type,value,extra).length>0,`${type} unexpectedly accepted ${JSON.stringify(value)}`)
    assert.equal(check(type,null,{...extra,nullable:false})[0]?.reason,'KVVI_FIELD_NOT_NULL')
  })
}

test('unknown and absent field types fail closed even for null',()=>{
  for(const type of ['person','json','guess',undefined]) {
    for(const value of ['x',null]) assert.equal(check(type,value)[0]?.reason,'KVVI_FIELD_TYPE_UNSUPPORTED')
  }
})

test('decimal scale/precision and fixed currency rules are enforced without rounding',()=>{
  for(const value of ['1234.56','1.234']) assert.ok(check('decimal',value,{type_config:{precision:5,scale:2}}).length>0)
  assert.deepEqual(check('decimal','123.45',{type_config:{precision:5,scale:2}}),[])
  assert.ok(check('money',{amount:'1.0',currency:'JPY'},{type_config:{currency_mode:'FIXED',currency:'JPY'}}).length>0)
  assert.ok(check('money',{amount:'1',currency:'ZZZ'},{type_config:{currency_mode:'FIXED',currency:'ZZZ'}}).length>0)
})

test('decimal defaults and partial configurations agree with the frozen validator',()=>{
  for(const config of [{},{precision:5},{scale:2}]) {
    assert.ok(check('decimal','1.234',{type_config:config}).length>0)
  }
  for(const config of [{},{scale:2}]) {
    assert.ok(check('decimal','12345678901234567',{type_config:config}).length>0)
  }
})

test('staged release/container layout loads the shared pure helpers without the repository',()=>{
  const root=mkdtempSync(join(tmpdir(),'kvvi-value-consumer-'))
  try {
    for(const rel of ['services/platform/src/field-value-types.mjs','services/platform/src/ledger.mjs',
      'tools/meta-schema/node/values.mjs','tools/meta-schema/node/safe_pattern.mjs']) {
      const target=join(root,'app',rel)
      mkdirSync(dirname(target),{recursive:true})
      copyFileSync(fileURLToPath(new URL('../../../'+rel,import.meta.url)),target)
    }
    execFileSync(process.execPath,['--input-type=module','-e',
      "import assert from 'node:assert/strict'; const {fieldValueProblem:f}=await import(process.argv[1]); assert.equal(f({type:'decimal'},'1.23'),undefined); assert.equal(f({type:'date'},'0000-01-01'),'KVVI_FIELD_TYPE_INVALID');",
      pathToFileURL(join(root,'app/services/platform/src/field-value-types.mjs')).href],{stdio:'pipe',cwd:root})
  } finally { rmSync(root,{recursive:true,force:true}) }
})

import { money } from './ledger.mjs'
import { decimalParts, fitsDecimal, validDate, validDatetime } from '../../../tools/meta-schema/node/values.mjs'

// Closed type list and decimal wire format from business-schema.v1; never coerce API input.
const TYPES=new Set(['short_text','long_text','boolean','integer','decimal','money','date','datetime','single_select','multi_select'])
const invalid='KVVI_FIELD_TYPE_INVALID'
const configInvalid='KVVI_FIELD_TYPE_CONFIG_INVALID'

/** Returns a reason only, so invalid values cannot leak through error details. */
export function fieldValueProblem(field,value) {
  if (!TYPES.has(field.type)) return 'KVVI_FIELD_TYPE_UNSUPPORTED'
  if (value===null) return field.nullable===false?'KVVI_FIELD_NOT_NULL':undefined
  const config=field.type_config??{}
  switch(field.type) {
    case 'short_text': case 'long_text': return typeof value==='string'?undefined:invalid
    case 'boolean': return typeof value==='boolean'?undefined:invalid
    case 'integer': return Number.isSafeInteger(value)?undefined:invalid
    case 'decimal': {
      const precision=config.precision??18, scale=config.scale??2
      if (!Number.isInteger(precision)||precision<1||precision>38
        ||!Number.isInteger(scale)||scale<0||scale>12||scale>precision) return configInvalid
      return fitsDecimal(value,precision,scale)?undefined:invalid
    }
    case 'money': {
      if (config.currency_mode!=='FIXED'||typeof config.currency!=='string') return configInvalid
      if (!value||typeof value!=='object'||Array.isArray(value)
        ||Object.keys(value).length!==2||!Object.hasOwn(value,'amount')||!Object.hasOwn(value,'currency')
        ||value.currency!==config.currency||!decimalParts(value.amount)) return invalid
      try { money(value.amount,value.currency) } catch { return invalid }
      return undefined
    }
    case 'date': return validDate(value)?undefined:invalid
    case 'datetime': return validDatetime(value)?undefined:invalid
    case 'single_select': case 'multi_select': {
      if (!Array.isArray(config.options)||!config.options.length
        ||config.options.some(option=>typeof option?.code!=='string')
        ||new Set(config.options.map(option=>option.code)).size!==config.options.length) return configInvalid
      const allowed=new Set(config.options.filter(option=>option.enabled!==false).map(option=>option.code))
      if (field.type==='single_select') return typeof value==='string'&&allowed.has(value)?undefined:invalid
      return Array.isArray(value)&&new Set(value).size===value.length
        &&value.every(code=>typeof code==='string'&&allowed.has(code))?undefined:invalid
    }
  }
}

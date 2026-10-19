/** Typed editor values. Decimal/money input never passes through IEEE-754. */
import type { ModelField } from './api.ts'

const TYPES = new Set(['short_text', 'long_text', 'boolean', 'integer', 'decimal', 'money', 'date', 'datetime', 'single_select', 'multi_select'])
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$(?![\s\S])/u
// Matches the current platform ledger. Production registry binding is separate.
const CURRENCY_SCALE: Readonly<Record<string, number>> = { CNY: 2, JPY: 0, USD: 2, EUR: 2 }
export const knownFieldType = (type: string | undefined): boolean => type !== undefined && TYPES.has(type)
const invalid = (): never => { throw new Error('KVVI_FIELD_TYPE_INVALID') }
const pad = (n: number): string => String(n).padStart(2, '0')

export function displayString(value: unknown, type?: string): string {
  if (value === null || value === undefined) return ''
  if (type === 'datetime' && typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${d.getMilliseconds() ? '.' + String(d.getMilliseconds()).padStart(3, '0') : ''}`
  }
  if (Array.isArray(value)) return value.join(',')
  if (typeof value === 'object') {
    if ('amount' in value && typeof value.amount === 'string') return value.amount
    return JSON.stringify(value)
  }
  return String(value)
}

function validOptions(config: ModelField['type_config']): Set<string> {
  const options = config?.options
  if (!options?.length || options.some(o => typeof o.code !== 'string') || new Set(options.map(o => o.code)).size !== options.length) {
    throw new Error('KVVI_FIELD_TYPE_CONFIG_INVALID')
  }
  return new Set(options.filter(o => o.enabled !== false).map(o => o.code))
}

export function coerceValue(type: string | undefined, str: string, config?: ModelField['type_config']): unknown {
  if (!knownFieldType(type)) throw new Error('KVVI_FIELD_TYPE_UNSUPPORTED')
  switch (type) {
    case 'short_text': case 'long_text': return str
    case 'boolean':
      if (str === 'true') return true
      if (str === 'false') return false
      if (str === '') return null
      return invalid()
    case 'integer': {
      if (str === '') return null
      const n = Number(str)
      if (!/^-?[0-9]+$(?![\s\S])/u.test(str) || !Number.isSafeInteger(n)) return invalid()
      return n
    }
    case 'decimal': {
      if (str === '') return null
      const precision = config?.precision ?? 18, scale = config?.scale ?? 2
      if (!Number.isInteger(precision) || precision < 1 || precision > 38 || !Number.isInteger(scale) || scale < 0 || scale > 12 || scale > precision) {
        throw new Error('KVVI_FIELD_TYPE_CONFIG_INVALID')
      }
      if (!DECIMAL.test(str)) return invalid()
      const [whole = '', fraction = ''] = str.replace(/^-/, '').split('.')
      if (fraction.length > scale || whole.replace(/^0+/u, '').length > precision - scale) return invalid()
      return str
    }
    case 'money': {
      if (str === '') return null
      if (config?.currency_mode !== 'FIXED' || typeof config.currency !== 'string' || !Object.hasOwn(CURRENCY_SCALE, config.currency)) {
        throw new Error('KVVI_FIELD_TYPE_CONFIG_INVALID')
      }
      if (!DECIMAL.test(str) || (str.split('.')[1]?.length ?? 0) > CURRENCY_SCALE[config.currency]!) return invalid()
      return { amount: str, currency: config.currency }
    }
    case 'single_select': {
      if (str === '') return null
      if (!validOptions(config).has(str)) return invalid()
      return str
    }
    case 'multi_select': {
      const values = str === '' ? [] : str.split(',').map(part => part.trim())
      const options = validOptions(config)
      if (values.some(part => !options.has(part)) || new Set(values).size !== values.length) return invalid()
      return values
    }
    case 'date': {
      if (str === '') return null
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$(?![\s\S])/u.test(str) || Number(str.slice(0, 4)) < 1) return invalid()
      const d = new Date(str + 'T00:00:00Z')
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== str) return invalid()
      return str
    }
    case 'datetime': {
      if (str === '') return null
      coerceValue('date', str.slice(0, 10))
      const local = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?$(?![\s\S])/u.exec(str)
      if (local) {
        const d = new Date(str)
        if (Number.isNaN(d.getTime())) return invalid()
        // Reject local calendar/DST normalization rather than moving the chosen time.
        const expected = `${local[1]}T${local[2]}:${local[3]}:${local[4] ?? '00'}${Number(local[5] ?? 0) ? '.' + (local[5] ?? '').padEnd(3, '0') : ''}`
        if (displayString(d.toISOString(), 'datetime') !== expected) return invalid()
        return d.toISOString()
      }
      const zoned = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$(?![\s\S])/u.exec(str)
      if (!zoned || Number(zoned[1]) > 23 || Number(zoned[2]) > 59 || Number(zoned[3]) > 59
        || (zoned[4] !== 'Z' && (Number(zoned[4]?.slice(1, 3)) > 23 || Number(zoned[4]?.slice(4, 6)) > 59))) return invalid()
      return str
    }
  }
  return invalid()
}

/**
 * Typed field-value handling for the panel's write payloads.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * Inputs render as strings, but a business field's value is typed (`boolean`,
 * `integer`, `money`, `null`, arrays). Round-tripping a value through an input
 * and posting the string back stores `"true"` where `true` lived, `"7"` where
 * `7` lived and `""` where `null` lived (acceptance U2). Two rules fix it:
 *
 *   1. An unchanged field keeps its original value — its type is whatever the
 *      platform returned, never re-derived from the input.
 *   2. A changed field is coerced from the input string back to the field's
 *      declared type before it is posted.
 */

/** The string an input shows for one stored value; matches how the panel seeds it. */
export function displayString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/**
 * Coerce one input string to the type a field declares.
 *
 * Text, date, datetime and single-select pass through as strings. `boolean`
 * reads the checkbox's two strings. Numeric fields read `''` as `null` and
 * parse otherwise; an unparseable input is `null` rather than `NaN` (NaN is not
 * valid JSON and the platform would refuse it). `multi_select` has no editor
 * today, so a non-empty string is treated as one element.
 * @param type - the field's declared `type`.
 * @param str - the input's current string.
 * @returns the typed value to post.
 */
export function coerceValue(type: string | undefined, str: string): unknown {
  switch (type) {
    case 'boolean':
      if (str === 'true') return true
      if (str === 'false') return false
      return null
    case 'integer': {
      if (str === '') return null
      const n = Number.parseInt(str, 10)
      return Number.isNaN(n) ? null : n
    }
    case 'decimal':
    case 'money': {
      if (str === '') return null
      const n = Number.parseFloat(str)
      return Number.isNaN(n) ? null : n
    }
    case 'multi_select':
      return str === '' ? [] : str.split(',').map(part => part.trim()).filter(part => part !== '')
    default:
      return str
  }
}

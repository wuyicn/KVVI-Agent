/**
 * One record, opened for reading and editing.
 *
 * ── The version is what makes an edit safe ──────────────────────────────────
 *
 * Every save sends the `rowVersion` this page was rendered from. The platform
 * compares it and answers `KVVI_ROW_VERSION_CONFLICT` when someone else moved
 * the record in between, instead of overwriting their change. That conflict is
 * reported as its own state — not folded into "save failed" — because the fix
 * is different: a failure is retried, a conflict requires reloading first.
 *
 * ── Hidden fields are absent, readonly fields are shown disabled ─────────────
 *
 * `data` arrives already filtered by the platform, so a `HIDDEN` field is not
 * in this record at all and never reaches an input. `READONLY` fields are drawn
 * disabled: the employee sees the value and cannot post a change to it.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelField, RecordView } from './api.ts'
import type { Copy } from './FormView.tsx'
import { coerceValue, displayString, knownFieldType } from './values.ts'

/** Props the record detail accepts. */
export interface KvviRecordDetailProps {
  readonly copy: Copy
  readonly record: RecordView
  readonly fields: readonly ModelField[] | undefined
  /** Workflow states, so the state value shows its label rather than its code. */
  readonly stateLabel?: string
  readonly onSave: (data: Record<string, unknown>, rowVersion: number) => void
  readonly onBack: () => void
  readonly busy?: boolean
  readonly saved?: boolean
  /**
   * The platform's current version after a conflict, when it told us. Shown so
   * the employee knows how far behind their copy is.
   */
  readonly conflictRowVersion?: number
  readonly error?: string
}

/** The single-line editor for one field. */
function editorFor(
  field: ModelField,
  value: string,
  mode: string,
  set: (next: string) => void,
): ReactNode {
  const locked = mode !== 'VISIBLE'
  const code = field.type ?? 'short_text'
  if (code === 'boolean') {
    return (
      <input
        type="checkbox"
        aria-label={field.field_code}
        checked={value === 'true'}
        disabled={locked}
        onChange={(e) => { set(e.target.checked ? 'true' : 'false') }}
      />
    )
  }
  if (code === 'single_select') {
    const options = field.type_config?.options ?? []
    return (
      <select
        aria-label={field.field_code}
        value={value}
        disabled={locked}
        onChange={(e) => { set(e.target.value) }}
        style={{ width: '100%', padding: '6px 8px' }}
      >
        <option value="" />
        {options.map(o => <option key={o.code} value={o.code} disabled={o.enabled === false}>{o.label ?? o.code}</option>)}
      </select>
    )
  }
  if (code === 'multi_select') {
    return <select multiple aria-label={field.field_code} value={value === '' ? [] : value.split(',')}
      disabled={locked} onChange={e => { set(Array.from(e.target.selectedOptions, option => option.value).join(',')) }}>
      {(field.type_config?.options ?? []).map(o => <option key={o.code} value={o.code} disabled={o.enabled === false}>{o.label ?? o.code}</option>)}
    </select>
  }
  if (code === 'long_text') {
    return (
      <textarea
        aria-label={field.field_code}
        value={value}
        readOnly={locked}
        disabled={locked}
        onChange={(e) => { set(e.target.value) }}
        style={{ width: '100%', padding: '6px 8px' }}
      />
    )
  }
  return (
    <input
      aria-label={field.field_code}
      {...(code === 'integer' ? { type: 'number', step: '1' } : {})}
      {...(code === 'decimal' || code === 'money' ? { type: 'text', inputMode: 'decimal' } as const : {})}
      {...(code === 'date' ? { type: 'date' } : {})}
      {...(code === 'datetime' ? { type: 'datetime-local', step: 'any' } : {})}
      value={value}
      readOnly={locked}
      disabled={locked}
      onChange={(e) => { set(e.target.value) }}
      style={{ width: '100%', padding: '6px 8px' }}
    />
  )
}

/**
 * Render one record.
 * @param props - copy, the record, the model fields and the callbacks.
 * @returns the detail form.
 */
export function KvviRecordDetail({
  copy, record, fields, stateLabel, onSave, onBack, busy, saved, conflictRowVersion, error,
}: KvviRecordDetailProps): ReactNode {
  const [edit, setEdit] = useState<{ recordId: string; values: Record<string, string> }>(() => ({ recordId: record.recordId, values: {} }))
  // Discard the old draft on a switch, including A -> B (view only) -> A.
  // Reset during render so children never commit with the previous identity.
  if (edit.recordId !== record.recordId) setEdit({ recordId: record.recordId, values: {} })
  const values = edit.recordId === record.recordId ? edit.values : {}

  // Only fields the platform actually returned are shown. A field missing from
  // `data` was hidden for this session, and adding an empty input for it would
  // both display its existence and invite a write the platform would refuse.
  const shown = (fields ?? []).filter(f => record.data[f.field_code] !== undefined
    && ['VISIBLE','READONLY','MASKED'].includes(record.fieldVisibility[f.field_code] ?? 'HIDDEN'))
  const writable = (field: ModelField): boolean => record.fieldVisibility[field.field_code] === 'VISIBLE'
    && (field.write_policy ?? 'MUTABLE') === 'MUTABLE'
    && knownFieldType(field.type)
  const patch: Record<string, unknown> = {}
  const invalidFields = shown.filter(field => !knownFieldType(field.type)).map(field => field.label ?? field.field_code)
  for (const field of shown) {
    if (!writable(field)) continue
    const original = record.data[field.field_code]
    const str = values[field.field_code] ?? displayString(original, field.type)
    if (str === displayString(original, field.type)) continue
    try {
      const next = coerceValue(field.type, str, field.type_config)
      if (next === null && field.nullable === false) throw new Error('KVVI_FIELD_NULL_NOT_ALLOWED')
      if (JSON.stringify(next) !== JSON.stringify(original)) patch[field.field_code] = next
    } catch {
      invalidFields.push(field.label ?? field.field_code)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 13 }}>{copy('detail.title')}</strong>
        {record.recordNo === undefined ? null : (
          <span style={{ fontSize: 12, opacity: .6 }}>{record.recordNo}</span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onBack} style={{ fontSize: 12 }}>{copy('detail.back')}</button>
      </div>

      {error === undefined ? null : (
        <p role="alert" style={{ fontSize: 12.5, marginBottom: 8 }}>
          {conflictRowVersion === undefined
            ? copy(error === 'KVVI_FIELD_DUPLICATE' ? 'form.duplicate' : error === 'KVVI_UNIQUE_PUBLICATION_PENDING' ? 'form.rulesUpdating' : 'detail.failed', { detail: error })
            : copy('detail.conflict', { currentRowVersion: String(conflictRowVersion) })}
        </p>
      )}
      {invalidFields.length > 0 ? <p role="alert">{copy('field.invalidValue', { fields: invalidFields.join('、') })}</p> : null}
      {saved === true ? (
        <p style={{ fontSize: 12.5, marginBottom: 8 }} data-kvvi-saved="1">{copy('detail.saved')}</p>
      ) : null}

      <div style={{ fontSize: 12, opacity: .6, marginBottom: 10 }}>
        {copy('detail.state')}：{stateLabel ?? record.state ?? ''}
        <span style={{ marginLeft: 10 }}>{copy('detail.version', { rowVersion: String(record.rowVersion) })}</span>
      </div>

      <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        {shown.map(field => (
          <label key={field.field_code} style={{ display: 'block', marginBottom: 10 }}>
            <span style={{ display: 'block', fontSize: 12, opacity: .7 }}>{field.label ?? field.field_code}</span>
            {editorFor(field, values[field.field_code] ?? displayString(record.data[field.field_code], field.type), writable(field) ? 'VISIBLE' : 'READONLY',
              (next) => { if (busy !== true) setEdit(v => ({ recordId: record.recordId, values: { ...(v.recordId === record.recordId ? v.values : {}), [field.field_code]: next } })) })}
          </label>
        ))}
      </fieldset>

      <button
        type="button"
        disabled={busy === true || invalidFields.length > 0 || Object.keys(patch).length === 0}
        onClick={() => {
          if (busy === true || invalidFields.length > 0 || Object.keys(patch).length === 0) return
          onSave(patch, record.rowVersion)
        }}
        style={{ marginTop: 8 }}
      >
        {copy('detail.save')}
      </button>
    </div>
  )
}

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

/** Props the record detail accepts. */
export interface KvviRecordDetailProps {
  readonly copy: Copy
  readonly record: RecordView
  readonly fields: readonly ModelField[] | undefined
  /** Workflow states, so the state value shows its label rather than its code. */
  readonly stateLabel?: string
  readonly onSave: (data: Record<string, string>, rowVersion: number) => void
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
  const locked = mode === 'READONLY' || mode === 'MASKED'
  const code = field.type ?? 'short_text'
  const numeric = code === 'integer' || code === 'decimal' || code === 'money'
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
        {options.map(o => <option key={o.code} value={o.code}>{o.label ?? o.code}</option>)}
      </select>
    )
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
      {...(numeric ? { type: 'number', step: 'any' } : {})}
      {...(code === 'date' ? { type: 'date' } : {})}
      {...(code === 'datetime' ? { type: 'datetime-local' } : {})}
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
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(record.data)) {
      out[key] = value === null || value === undefined
        ? ''
        : typeof value === 'string' ? value : String(value)
    }
    return out
  })

  // Only fields the platform actually returned are shown. A field missing from
  // `data` was hidden for this session, and adding an empty input for it would
  // both display its existence and invite a write the platform would refuse.
  const shown = (fields ?? []).filter(f => record.data[f.field_code] !== undefined)

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
            ? copy('detail.failed', { detail: error })
            : copy('detail.conflict', { currentRowVersion: String(conflictRowVersion) })}
        </p>
      )}
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
            {editorFor(field, values[field.field_code] ?? '', record.fieldVisibility[field.field_code] ?? 'VISIBLE',
              (next) => { if (busy !== true) setValues(v => ({ ...v, [field.field_code]: next })) })}
          </label>
        ))}
      </fieldset>

      <button
        type="button"
        disabled={busy === true}
        onClick={() => {
          if (busy === true) return
          const data: Record<string, string> = {}
          for (const field of shown) {
            // A masked field is displayed as a mask. Posting the mask back would
            // store the mask as the value, so it is left out of the payload.
            if (['MASKED', 'READONLY'].includes(record.fieldVisibility[field.field_code] ?? 'VISIBLE')) continue
            data[field.field_code] = values[field.field_code] ?? ''
          }
          onSave(data, record.rowVersion)
        }}
        style={{ marginTop: 8 }}
      >
        {copy('detail.save')}
      </button>
    </div>
  )
}

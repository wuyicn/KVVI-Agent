/**
 * The record list of one published system.
 *
 * ── Why this is not driven by the view tree ─────────────────────────────────
 *
 * A published LIST view binds its `Table` to a `DataBindingRef`, i.e. to a named
 * query the platform would have to execute. The platform serves systems,
 * runtimes and records — there is no query endpoint yet, so a `Table` node
 * refuses in the renderer (see `registry.tsx`).
 *
 * What the employee actually needs from "我的系统" is nevertheless well defined
 * and fully served: the records of this system that their session may read.
 * This list is built from that endpoint and from the published model, so every
 * column is a real field the platform filtered, not a shape invented here.
 *
 * Columns come from the model rather than from the returned rows: deriving them
 * from the rows would silently drop a column whenever the first fifty records
 * happen to leave it empty, and the employee would read that as "the field does
 * not exist".
 */
import type { ReactNode } from 'react'
import type { ModelField, RecordRow } from './api.ts'
import type { Copy } from './FormView.tsx'

/** Props the record list accepts. */
export interface KvviListViewProps {
  readonly copy: Copy
  readonly fields: readonly ModelField[] | undefined
  readonly rows: readonly RecordRow[]
  readonly fieldVisibility: Readonly<Record<string, string>>
  /** Shown above the table; the published view's own name. */
  readonly title?: string
  readonly onOpen: (recordId: string) => void
  readonly onRefresh: () => void
  /** Present when the last read failed, so the empty table is explained. */
  readonly error?: string
  readonly busy?: boolean
}

/** Render one cell: masked, empty, or the plain value. */
function cell(row: RecordRow, field: string, mode: string | undefined): string {
  if (mode === 'HIDDEN') return ''
  const value = row.data[field]
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // A structured value has no cell rendering in v1; showing `[object Object]`
  // would look like data, so it is shown as JSON and stays visibly unusual.
  return JSON.stringify(value)
}

/**
 * Render the system's records.
 * @param props - copy, model fields, rows, visibility and callbacks.
 * @returns the table.
 */
export function KvviListView({
  copy, fields, rows, fieldVisibility, title, onOpen, onRefresh, error, busy,
}: KvviListViewProps): ReactNode {
  // Columns are the model's business fields, exactly as declared. `record_no`
  // and `state` are record metadata rather than model fields, so they are shown
  // as the row's own leading column and not as a table column.
  const columns = fields ?? []

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>{title ?? copy('list.title')}</strong>
        <span style={{ fontSize: 12, opacity: .6 }}>{rows.length}</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onRefresh} disabled={busy === true} style={{ fontSize: 12 }}>
          {copy('list.refresh')}
        </button>
      </div>

      {error === undefined ? null : (
        <p role="alert" style={{ fontSize: 12.5, marginBottom: 8 }}>
          {copy('list.failed', { detail: error })}
        </p>
      )}

      {rows.length === 0 && error === undefined ? (
        <p style={{ fontSize: 12.5, opacity: .7 }}>{copy('list.empty')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
            <thead>
              <tr>
                {columns.map(f => (
                  <th
                    key={f.field_code}
                    style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-border, #e5e7eb)' }}
                  >
                    {f.label ?? f.field_code}
                  </th>
                ))}
                <th style={{ borderBottom: '1px solid var(--dsw-border, #e5e7eb)' }} />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.recordId}>
                  <td style={{ padding: '6px 8px', opacity: .6 }}>{row.recordNo ?? ''}</td>
                  {columns.map(f => (
                    <td key={f.field_code} style={{ padding: '6px 8px' }}>
                      {cell(row, f.field_code, fieldVisibility[f.field_code])}
                    </td>
                  ))}
                  <td style={{ padding: '6px 8px' }}>
                    <button type="button" onClick={() => { onOpen(row.recordId) }} style={{ fontSize: 12 }}>
                      {copy('list.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

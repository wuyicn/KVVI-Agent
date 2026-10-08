/** The platform-projected rows and published model are the only source of cells. */
import { useState, type ReactNode } from 'react'
import { Button, IconSearchOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelField, RecordRow } from './api.ts'
import type { Copy } from './FormView.tsx'
import css from './business.module.css'

export interface KvviListViewProps {
  readonly copy: Copy
  readonly fields: readonly ModelField[] | undefined
  readonly rows: readonly RecordRow[]
  readonly fieldVisibility: Readonly<Record<string, string>>
  readonly title?: string
  readonly onOpen: (recordId: string) => void
  readonly onRefresh: () => void
  readonly onCreate?: () => void
  readonly error?: string
  readonly busy?: boolean
}
function cell(row: RecordRow, field: string): string {
  const value = row.data[field]
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
/** Search and filtering operate on the already authorized returned page, never hidden fields. */
export function KvviListView({
  copy, fields, rows, fieldVisibility, title, onOpen, onRefresh, onCreate, error, busy,
}: KvviListViewProps): ReactNode {
  const [query, setQuery] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [filter, setFilter] = useState('')
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const columns = (fields ?? []).filter(f => fieldVisibility[f.field_code] !== 'HIDDEN')
  const filterable = columns.filter(f => (f.type_config?.options?.length ?? 0) > 0 && fieldVisibility[f.field_code] !== 'MASKED')
  const filterField = filterable.find(f => f.field_code === filter)
  const visible = rows.filter(row => (!filtering || filterField === undefined || value === '' || cell(row, filterField.field_code) === value)
    && (query.trim() === '' || [row.recordNo ?? '', ...columns.map(f => cell(row, f.field_code))].some(text => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))))
  const selectedCount = rows.filter(row => selected.has(row.recordId)).length
  return <section className={css.records}>
    {title === undefined ? null : <h2 className={css.sectionTitle}>{title}</h2>}
    <div className={css.recordToolbar}>
      {onCreate === undefined ? null : <Button variant="primary" icon={<IconPlusOutline16/>} onClick={onCreate} disabled={busy === true}>{copy('list.create')}</Button>}
      <label className={css.searchBox}><IconSearchOutline16/><input aria-label={copy('list.search')} placeholder={copy('list.search')} value={query} onChange={(e) => { setQuery(e.target.value) }}/></label>
      <Button variant="outline" aria-pressed={filtering} disabled={filterable.length === 0} onClick={() => { setFiltering(!filtering) }}>{copy('list.filter')}</Button>
      <Button variant="ghost" onClick={onRefresh} disabled={busy === true}>{copy('list.refresh')}</Button>
    </div>
    {filtering ? <div className={css.recordToolbar}>
      <select className={css.control} aria-label={copy('list.columns')} value={filter} onChange={(e) => { setFilter(e.target.value); setValue('') }}><option value="">{copy('list.all')}</option>{filterable.map(f => <option key={f.field_code} value={f.field_code}>{f.label ?? f.field_code}</option>)}</select>
      <select className={css.control} aria-label={copy('list.filter')} value={value} onChange={(e) => { setValue(e.target.value) }}><option value="">{copy('list.all')}</option>{filterField?.type_config?.options?.map(option => <option key={option.code} value={option.code}>{option.label ?? option.code}</option>)}</select>
    </div> : null}
    {error === undefined ? null : <p role="alert">{copy('list.failed', { detail: error })}</p>}
    <div className={css.tableScroll}><table className={css.recordTable}><thead><tr>
      <th aria-label={copy('list.selected', { count: selectedCount })}/><th>{copy('list.number')}</th>
      {columns.map(f => <th key={f.field_code}>{f.label ?? f.field_code}</th>)}<th>{copy('business.actions')}</th>
    </tr></thead><tbody>{visible.map(row => <tr key={row.recordId} data-selected={selected.has(row.recordId) || undefined}>
      <td><input type="checkbox" aria-label={copy('list.select', { name: row.recordNo ?? cell(row, columns[0]?.field_code ?? '') })} checked={selected.has(row.recordId)} onChange={(e) => { const next = new Set(selected); if (e.target.checked) next.add(row.recordId); else next.delete(row.recordId); setSelected(next) }}/></td>
      <td>{row.recordNo ?? '—'}</td>{columns.map((f, i) => <td key={f.field_code}>{i === 0 ? <button type="button" className={css.recordLink} onClick={() => { onOpen(row.recordId) }}>{cell(row, f.field_code) || '—'}</button> : cell(row, f.field_code) || '—'}</td>)}
      <td><Button size="sm" onClick={() => { onOpen(row.recordId) }}>{copy('list.open')}</Button></td>
    </tr>)}</tbody></table>
    {visible.length === 0 && error === undefined && busy !== true ? <p className={css.empty}>{copy(rows.length === 0 ? 'list.empty' : 'list.noMatch')}</p> : null}</div>
    <footer className={css.recordFooter}><span>{copy('list.loaded', { count: rows.length, shown: visible.length })}{rows.length >= 50 ? ` · ${copy('list.limit')}` : ''}</span>{selectedCount > 0 ? <span>{copy('list.selected', { count: selectedCount })}</span> : null}</footer>
  </section>
}

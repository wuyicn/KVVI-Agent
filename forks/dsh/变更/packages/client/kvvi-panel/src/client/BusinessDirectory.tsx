/** Single-level directory: groups organize forms, never grant access. */
import { Button, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Copy } from './FormView.tsx'
import type { BusinessForm, BusinessGroup, DirectoryAction } from './business-directory-api.ts'
import css from './business.module.css'
/** @param props - server entries and presentation callbacks. @returns searchable group navigation. */
export function BusinessDirectory({ groups, forms, selectedAssetId, query, builder, collapsed,
  copy, onQuery, onSelect, onManage, onCollapse }: {
  groups: readonly BusinessGroup[]
  forms: readonly BusinessForm[]
  selectedAssetId?: string
  query: string
  builder: boolean
  collapsed: readonly string[]
  copy: Copy
  onQuery: (query: string) => void
  onSelect: (form: BusinessForm) => void
  onManage: (action: DirectoryAction, group: BusinessGroup) => void
  onCollapse: (groupId: string) => void
}) {
  const visible = forms.filter(f => f.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const sections = [...groups, { groupId: '', name: copy('directory.ungrouped'), version: 0, position: 0 }]
  return <aside className={css.resourceDirectory} aria-label={copy('business.pages')}>
    <label className={css.searchBox}><IconSearchOutline16/><input aria-label={copy('business.searchPages')} placeholder={copy('business.searchPages')} value={query} onChange={(e) => { onQuery(e.target.value) }}/></label>
    {sections.map((group) => {
      const children = visible.filter(f => (f.groupId ?? '') === group.groupId)
      if (!children.length && (!builder || query.trim() || !group.groupId)) return null
      const closed = !query.trim() && collapsed.includes(group.groupId)
      return <section key={group.groupId} className={css.groupSection}>
        <div className={css.groupHeading}><Button variant="ghost" aria-expanded={!closed} onClick={() => { onCollapse(group.groupId) }}>{group.name}</Button>
          {builder && group.groupId ? <details className={css.groupMenu}><summary aria-label={copy('directory.manageGroup') + ': ' + group.name}>⋯</summary><div>
            <Button variant="ghost" onClick={() => { onManage('group.rename', group) }}>{copy('directory.rename')}</Button>
            <Button variant="ghost" onClick={() => { onManage('group.delete', group) }}>{copy('directory.dissolve')}</Button>
          </div></details> : null}</div>
        {closed ? null : children.map(form => <Button key={form.assetId} variant="ghost" className={form.assetId === selectedAssetId ? css.resourceActive : css.groupForm} aria-current={form.assetId === selectedAssetId ? 'page' : undefined} onClick={() => { onSelect(form) }}>{form.name}</Button>)}
      </section>
    })}
    {!visible.length ? <p className={css.hint}>{copy('directory.empty')}</p> : null}
  </aside>
}

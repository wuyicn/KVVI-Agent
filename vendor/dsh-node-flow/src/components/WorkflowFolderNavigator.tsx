import { useEffect, useMemo, useRef, useState } from 'react'
import { Folder, FolderOpen, FolderPlus, Pencil, Trash2, X } from 'lucide-react'
import type { SavedWorkflow, WorkflowFolder } from '../model.js'

export type WorkflowFolderFilter = 'all' | 'uncategorized' | string

type FolderDialog =
  | { mode: 'create' }
  | { mode: 'rename'; folder: WorkflowFolder }
  | { mode: 'delete'; folder: WorkflowFolder }

function folderCount(workflows: SavedWorkflow[], folderId?: string): number {
  return workflows.filter((workflow) => workflow.folderId === folderId).length
}

export function WorkflowFolderNavigator({
  folders,
  workflows,
  selected,
  onSelect,
  onCreateWorkflow,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}: {
  folders: WorkflowFolder[]
  workflows: SavedWorkflow[]
  selected: WorkflowFolderFilter
  onSelect: (filter: WorkflowFolderFilter) => void
  onCreateWorkflow: (folderId?: string) => void
  onCreateFolder: (name: string) => Promise<WorkflowFolder>
  onRenameFolder: (folder: WorkflowFolder, name: string) => Promise<WorkflowFolder>
  onDeleteFolder: (folder: WorkflowFolder, targetFolderId?: string) => Promise<number>
}) {
  const [dialog, setDialog] = useState<FolderDialog | null>(null)
  const [name, setName] = useState('')
  const [targetFolderId, setTargetFolderId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const actionRef = useRef(false)
  const counts = useMemo(() => new Map(folders.map((folder) => [folder.id, folderCount(workflows, folder.id)])), [folders, workflows])
  const uncategorizedCount = useMemo(() => folderCount(workflows), [workflows])

  useEffect(() => {
    if (selected === 'all' || selected === 'uncategorized' || folders.some((folder) => folder.id === selected)) return
    onSelect('all')
  }, [folders, onSelect, selected])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !actionRef.current) setDialog(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [])

  const openDialog = (next: FolderDialog): void => {
    setDialog(next)
    setName(next.mode === 'rename' ? next.folder.name : '')
    setTargetFolderId('')
    setError('')
  }

  const currentFolderId = selected === 'all' || selected === 'uncategorized' ? undefined : selected
  const selectedTitle = selected === 'all' ? '全部工作流' : selected === 'uncategorized' ? '未分类' : folders.find((folder) => folder.id === selected)?.name || '全部工作流'

  return (
    <aside className="wf-folder-navigator" aria-label="工作流文件夹">
      <div className="wf-folder-navigator__header">
        <span>文件夹</span>
        <button type="button" onClick={() => openDialog({ mode: 'create' })} title="新建文件夹" aria-label="新建文件夹"><FolderPlus size={15} /></button>
      </div>
      <div className="wf-folder-mobile-select">
        <span>文件夹</span>
        <div><select aria-label="按文件夹筛选工作流" value={selected} onChange={(event) => onSelect(event.target.value)}>
          <option value="all">全部工作流 ({workflows.length})</option>
          <option value="uncategorized">未分类 ({uncategorizedCount})</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name} ({counts.get(folder.id) ?? 0})</option>)}
        </select><button type="button" onClick={() => openDialog({ mode: 'create' })} title="新建文件夹" aria-label="新建文件夹"><FolderPlus size={15} /></button>{currentFolderId && <><button type="button" onClick={() => { const folder = folders.find((candidate) => candidate.id === currentFolderId); if (folder) openDialog({ mode: 'rename', folder }) }} title="重命名当前文件夹" aria-label="重命名当前文件夹"><Pencil size={14} /></button><button type="button" onClick={() => { const folder = folders.find((candidate) => candidate.id === currentFolderId); if (folder) openDialog({ mode: 'delete', folder }) }} title="删除当前文件夹" aria-label="删除当前文件夹"><Trash2 size={14} /></button></>}</div>
      </div>
      <div className="wf-folder-navigator__list">
        <button type="button" className={selected === 'all' ? 'is-active' : ''} onClick={() => onSelect('all')}>
          <GridIcon active={selected === 'all'} />
          <span>全部工作流</span>
          <small>{workflows.length}</small>
        </button>
        <button type="button" className={selected === 'uncategorized' ? 'is-active' : ''} onClick={() => onSelect('uncategorized')}>
          <FolderOpen size={15} />
          <span>未分类</span>
          <small>{uncategorizedCount}</small>
        </button>
        {folders.map((folder) => {
          const active = selected === folder.id
          return <div key={folder.id} className={`wf-folder-navigator__item${active ? ' is-active' : ''}`}>
            <button type="button" className="wf-folder-navigator__select" onClick={() => onSelect(folder.id)} aria-pressed={active}>
              <Folder size={15} /><span>{folder.name}</span><small>{counts.get(folder.id) ?? 0}</small>
            </button>
            <span className="wf-folder-navigator__actions">
              <button type="button" onClick={() => openDialog({ mode: 'rename', folder })} title={`重命名 ${folder.name}`} aria-label={`重命名 ${folder.name}`}><Pencil size={13} /></button>
              <button type="button" onClick={() => openDialog({ mode: 'delete', folder })} title={`删除 ${folder.name}`} aria-label={`删除 ${folder.name}`}><Trash2 size={13} /></button>
            </span>
          </div>
        })}
      </div>
      <button type="button" className="wf-folder-navigator__create" onClick={() => onCreateWorkflow(currentFolderId)}><FolderPlus size={15} />{selected === 'all' ? '新建工作流' : `新建到${selectedTitle}`}</button>

      {dialog && <div className="wf-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) setDialog(null)
      }}>
        <section className="wf-credential-dialog wf-folder-dialog" role="dialog" aria-modal="true" aria-label={dialog.mode === 'create' ? '新建文件夹' : dialog.mode === 'rename' ? '重命名文件夹' : '删除文件夹'}>
          <header><div><Folder size={17} /><strong>{dialog.mode === 'create' ? '新建文件夹' : dialog.mode === 'rename' ? '重命名文件夹' : '删除文件夹'}</strong></div><button className="wf-icon-button" disabled={busy} onClick={() => setDialog(null)} aria-label="关闭"><X size={17} /></button></header>
          <div className="wf-credential-dialog__body">
            {dialog.mode !== 'delete' ? <label><span>名称</span><input aria-label="名称" autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label> : <>
              <strong>{dialog.folder.name}</strong>
              <p>{counts.get(dialog.folder.id) ?? 0} 个工作流会移至下方目标。此操作不会改变任何草稿或已发布的执行快照。</p>
              <label><span>移动到</span><select aria-label="移动到" value={targetFolderId} onChange={(event) => setTargetFolderId(event.target.value)}><option value="">未分类</option>{folders.filter((folder) => folder.id !== dialog.folder.id).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
            </>}
            {error && <p className="wf-wait-dialog__error" role="alert">{error}</p>}
          </div>
          <footer><button type="button" disabled={busy} onClick={() => setDialog(null)}>取消</button><button type="button" className={dialog.mode === 'delete' ? 'wf-dialog-btn wf-dialog-btn--danger' : 'wf-primary-command'} disabled={busy || (dialog.mode !== 'delete' && !name.trim())} onClick={async () => {
            if (actionRef.current) return
            actionRef.current = true
            setBusy(true)
            setError('')
            try {
              if (dialog.mode === 'create') {
                const folder = await onCreateFolder(name)
                onSelect(folder.id)
              } else if (dialog.mode === 'rename') {
                const folder = await onRenameFolder(dialog.folder, name)
                if (selected === dialog.folder.id) onSelect(folder.id)
              } else {
                await onDeleteFolder(dialog.folder, targetFolderId || undefined)
                if (selected === dialog.folder.id) onSelect(targetFolderId || 'uncategorized')
              }
              setDialog(null)
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught))
            } finally {
              actionRef.current = false
              setBusy(false)
            }
          }}>{busy ? '正在保存' : dialog.mode === 'create' ? '创建文件夹' : dialog.mode === 'rename' ? '保存名称' : '删除并移动'}</button></footer>
        </section>
      </div>}
    </aside>
  )
}

function GridIcon({ active }: { active: boolean }) {
  return active ? <FolderOpen size={15} /> : <Folder size={15} />
}

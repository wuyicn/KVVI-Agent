import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, FileClock, GitCompareArrows, Loader2, Minus, PencilLine, Plus, Rocket, RotateCcw, X } from 'lucide-react'
import type { SavedWorkflow, WorkflowVersion, WorkflowVersionDiff } from '../model.js'
import { listWorkflowVersions } from '../workflowRepository.js'
import { diffWorkflowDocuments, workflowDiffCount } from '../workflowVersionProtocol.js'

const VERSION_KIND_LABELS: Record<WorkflowVersion['kind'], string> = {
  created: '创建',
  draft: '保存草稿',
  published: '发布',
  disabled: '停用',
  restored: '恢复草稿',
  'restored-published': '恢复并发布',
  imported: '历史基线',
}

function formatVersionTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN')
}

function DiffGroup({ title, tone, items }: { title: string; tone: 'add' | 'remove' | 'change'; items: string[] }) {
  if (items.length === 0) return null
  const Icon = tone === 'add' ? Plus : tone === 'remove' ? Minus : PencilLine
  return (
    <section className={`wf-version-diff-group is-${tone}`}>
      <header><Icon size={14} /><strong>{title}</strong><span>{items.length}</span></header>
      <div>{items.map((item) => <code key={item}>{item}</code>)}</div>
    </section>
  )
}

function diffGroups(diff: WorkflowVersionDiff): Array<{ title: string; tone: 'add' | 'remove' | 'change'; items: string[] }> {
  return [
    { title: '新增节点', tone: 'add', items: diff.addedNodes.map((node) => `${node.label} · ${node.kind}`) },
    { title: '删除节点', tone: 'remove', items: diff.removedNodes.map((node) => `${node.label} · ${node.kind}`) },
    { title: '修改节点', tone: 'change', items: diff.changedNodes.map((node) => `${node.label} · ${node.fields.join('、')}`) },
    { title: '修改工作流设置', tone: 'change', items: [diff.inputsChanged ? '输入契约' : '', diff.outputsChanged ? '输出契约' : '', diff.concurrencyChanged ? '运行并发' : '', diff.executionLimitsChanged ? '执行限制' : ''].filter(Boolean) },
    { title: '新增连接', tone: 'add', items: diff.addedEdges.map((edge) => `${edge.source} → ${edge.target}`) },
    { title: '删除连接', tone: 'remove', items: diff.removedEdges.map((edge) => `${edge.source} → ${edge.target}`) },
    { title: '修改连接', tone: 'change', items: diff.changedEdges.map((edge) => `${edge.source} → ${edge.target}`) },
  ]
}

export function VersionHistoryPanel({
  workflow,
  onClose,
  onRestore,
}: {
  workflow: SavedWorkflow
  onClose: () => void
  onRestore: (workflow: SavedWorkflow, version: WorkflowVersion, publish: boolean) => Promise<SavedWorkflow>
}) {
  const [current, setCurrent] = useState(workflow)
  const [versions, setVersions] = useState<WorkflowVersion[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [compareId, setCompareId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [action, setAction] = useState<'draft' | 'publish' | null>(null)
  const actionRef = useRef(false)

  const load = useCallback(async (nextWorkflow: SavedWorkflow) => {
    setLoading(true)
    setError('')
    try {
      const items = await listWorkflowVersions(nextWorkflow)
      setVersions(items)
      setSelectedId((selected) => selected && items.some((version) => version.id === selected) ? selected : items[0]?.id ?? null)
      setCompareId((selected) => selected && items.some((version) => version.id === selected) ? selected : items[1]?.id ?? items[0]?.id ?? null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '版本历史加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(current)
  }, [current, load])

  const selected = versions.find((version) => version.id === selectedId)
  const compared = versions.find((version) => version.id === compareId)
  const diff = useMemo(() => selected && compared ? diffWorkflowDocuments(selected.doc, compared.doc) : null, [compared, selected])
  const groups = useMemo(() => diff ? diffGroups(diff) : [], [diff])

  const chooseVersion = (version: WorkflowVersion): void => {
    setSelectedId(version.id)
    if (compareId === version.id) {
      setCompareId((versions.find((candidate) => candidate.id !== version.id) ?? version).id)
    }
  }

  const restore = async (publish: boolean): Promise<void> => {
    if (!selected || actionRef.current) return
    const prompt = publish
      ? `确定把 v${selected.revision} 恢复并立即发布吗？当前线上版本会被新的发布快照替换。`
      : `确定把 v${selected.revision} 恢复为新草稿吗？当前线上版本不会改变。`
    if (!window.confirm(prompt)) return
    actionRef.current = true
    setAction(publish ? 'publish' : 'draft')
    setError('')
    try {
      const saved = await onRestore(current, selected, publish)
      setCurrent(saved)
      setSelectedId(null)
      setCompareId(null)
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : '历史版本恢复失败')
    } finally {
      actionRef.current = false
      setAction(null)
    }
  }

  return (
    <div className="wf-version-backdrop" role="presentation">
      <section className="wf-version-panel" role="dialog" aria-modal="true" aria-label={`${current.name} 版本历史`}>
        <header className="wf-version-panel__header">
          <div><span><FileClock size={18} /></span><div><strong>版本历史</strong><small>{current.name} · 当前记录 v{current.revision}</small></div></div>
          <button className="wf-icon-btn" onClick={onClose} aria-label="关闭版本历史"><X size={18} /></button>
        </header>
        <div className="wf-version-panel__body">
          <aside className="wf-version-list">
            {loading && <div className="wf-version-empty"><Loader2 className="wf-spin" size={19} />正在加载版本</div>}
            {!loading && versions.map((version) => (
              <button key={version.id} className={selectedId === version.id ? 'is-active' : ''} onClick={() => chooseVersion(version)}>
                <span className="wf-version-list__dot" />
                <span><strong>v{version.revision}</strong><small>{VERSION_KIND_LABELS[version.kind]} · {formatVersionTime(version.createdAt)}</small></span>
                <span className="wf-version-list__badges">
                  {version.revision === current.revision && <em>当前</em>}
                  {version.publishedRevision === version.draftRevision && version.status === 'enabled' && <em className="is-published">已发布</em>}
                </span>
              </button>
            ))}
            {!loading && versions.length === 0 && <div className="wf-version-empty">暂无版本历史</div>}
          </aside>
          <main className="wf-version-detail">
            {selected ? (
              <>
                <div className="wf-version-summary">
                  <div><strong>v{selected.revision} · {VERSION_KIND_LABELS[selected.kind]}</strong><span>{selected.doc.nodes.length} 个节点 · {selected.doc.edges.length} 条连接</span></div>
                  <div className="wf-version-actions">
                    <button disabled={action !== null || selected.revision === current.revision} onClick={() => void restore(false)}>
                      {action === 'draft' ? <Loader2 className="wf-spin" size={14} /> : <RotateCcw size={14} />}恢复为草稿
                    </button>
                    <button className="is-primary" disabled={action !== null || selected.revision === current.revision} onClick={() => void restore(true)}>
                      {action === 'publish' ? <Loader2 className="wf-spin" size={14} /> : <Rocket size={14} />}恢复并发布
                    </button>
                  </div>
                </div>
                <div className="wf-version-compare">
                  <GitCompareArrows size={16} />
                  <label>从<select value={selectedId ?? ''} onChange={(event) => setSelectedId(event.target.value)}>{versions.map((version) => <option value={version.id} key={version.id}>v{version.revision} · {VERSION_KIND_LABELS[version.kind]}</option>)}</select></label>
                  <span>比较到</span>
                  <label><select value={compareId ?? ''} onChange={(event) => setCompareId(event.target.value)}>{versions.map((version) => <option value={version.id} key={version.id}>v{version.revision} · {VERSION_KIND_LABELS[version.kind]}</option>)}</select></label>
                </div>
                {diff && <div className="wf-version-diff">
                  <div className="wf-version-diff__overview">
                    <span><strong>{workflowDiffCount(diff)}</strong> 项结构变化</span>
                    <span>{diff.nameChanged ? '名称已改变' : '名称未改变'}</span>
                    <span>{diff.descriptionChanged ? '描述已改变' : '描述未改变'}</span>
                    <span>{diff.inputsChanged || diff.outputsChanged ? '输入 / 输出契约已改变' : '契约未改变'}</span>
                  </div>
                  {workflowDiffCount(diff) === 0 ? <div className="wf-version-no-diff"><CheckCircle2 size={18} />两个版本的工作流结构相同</div> : groups.map((group) => <DiffGroup key={`${group.tone}-${group.title}`} {...group} />)}
                </div>}
              </>
            ) : <div className="wf-version-empty">选择一个版本查看详情</div>}
            {error && <div className="wf-version-error">{error}</div>}
          </main>
        </div>
      </section>
    </div>
  )
}

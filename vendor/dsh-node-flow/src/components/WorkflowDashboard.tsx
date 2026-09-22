import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlarmClock,
  Bot,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleOff,
  Clock3,
  Copy,
  FileClock,
  FolderInput,
  GitBranch,
  Grid2X2,
  HardDrive,
  History,
  Hourglass,
  KeyRound,
  LayoutTemplate,
  ListFilter,
  ListTree,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ScrollText,
  Square,
  Trash2,
  Workflow,
  XCircle,
} from 'lucide-react'
import {
  buildBasicIfExample,
  buildDailySwitchExample,
  buildLoopExample,
  buildNewsExample,
  buildQaIfExample,
  buildWeatherExample,
  buildWhileExample,
  type SavedWorkflow,
  type WorkflowDocument,
  type WorkflowFolder,
  type WorkflowRunRecord,
  type WorkflowRunSummary,
  type WorkflowStatus,
  type WorkflowVersion,
} from '../model.js'
import { createWaitpointCallbackToken, getWorkflowRunDetail, listWorkflowRunSummaries, listWorkflowRuns, replayWorkflowRun, resolveWorkflowApproval } from '../workflowRepository.js'
import { executionDocument, hasUnpublishedChanges } from '../workflowProtocol.js'
import { CredentialsPanel } from './CredentialsPanel.js'
import { ProjectVariablesPanel } from './ProjectVariablesPanel.js'
import { AuditLogPanel } from './AuditLogPanel.js'
import { VersionHistoryPanel } from './VersionHistoryPanel.js'
import { WorkflowRunInputDialog } from './WorkflowRunInputDialog.js'
import { WorkflowFolderNavigator, type WorkflowFolderFilter } from './WorkflowFolderNavigator.js'

export type DashboardSection = 'workflows' | 'runs' | 'schedules' | 'templates' | 'credentials' | 'variables' | 'audit'

type ScheduleRecord = {
  id: string
  name: string
  cron: string
  timezone?: string
  timezoneLabel?: string
  lastFired?: string
  nextFire?: string
  configurationError?: string
  doc?: WorkflowDocument
}

const NAV_ITEMS = [
  { id: 'workflows' as const, label: '工作流', icon: Workflow },
  { id: 'runs' as const, label: '运行记录', icon: Activity },
  { id: 'schedules' as const, label: '定时任务', icon: AlarmClock },
  { id: 'templates' as const, label: '模板', icon: LayoutTemplate },
  { id: 'credentials' as const, label: '连接', icon: KeyRound },
  { id: 'variables' as const, label: '变量', icon: Braces },
  { id: 'audit' as const, label: '审计日志', icon: ScrollText },
]

const TEMPLATES = [
  { name: 'AI 天气播报', description: '抓取实时天气，由 Agent 生成自然语言播报。', icon: Bot, build: buildWeatherExample },
  { name: '定时新闻摘要', description: '按 Cron 计划收集新闻并生成精简摘要。', icon: FileClock, build: buildNewsExample },
  { name: '基础条件分流', description: '根据输入结果分别执行不同的处理路径。', icon: GitBranch, build: buildBasicIfExample },
  { name: 'AI 问答分流', description: '先让 Agent 分类，再路由到对应输出。', icon: Bot, build: buildQaIfExample },
  { name: '时段 Switch', description: '根据当前时段匹配多个业务分支。', icon: Clock3, build: buildDailySwitchExample },
  { name: '数组循环处理', description: '遍历一组数据并收集每次执行结果。', icon: RefreshCw, build: buildLoopExample },
  { name: '条件循环', description: '条件成立时持续运行流程体。', icon: RefreshCw, build: buildWhileExample },
]

function formatDate(value?: string): string {
  if (!value) return '从未'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatRunValue(value: unknown): string {
  if (value === undefined || value === null) return '无'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function SectionHeader({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <header className="wf-page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="wf-page-header__actions">{children}</div>}
    </header>
  )
}

export function WorkflowDashboard({
  workflows,
  folders,
  loading,
  section,
  onSectionChange,
  onCreate,
  onOpen,
  onRun,
  onCancelRun,
  onResumeRun,
  onDuplicate,
  onDelete,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveToFolder,
  onRestoreVersion,
  onStatusChange,
  onUseTemplate,
  onExit,
}: {
  workflows: SavedWorkflow[]
  folders: WorkflowFolder[]
  loading: boolean
  section: DashboardSection
  onSectionChange: (section: DashboardSection) => void
  onCreate: (folderId?: string) => void
  onOpen: (workflow: SavedWorkflow) => void
  onRun: (workflow: SavedWorkflow, runId: string, signal: AbortSignal, input?: unknown) => Promise<void>
  onCancelRun: (runId: string) => Promise<void>
  onResumeRun: (run: Pick<WorkflowRunRecord, 'id'>, runId: string, signal: AbortSignal) => Promise<WorkflowRunRecord>
  onDuplicate: (workflow: SavedWorkflow) => Promise<void>
  onDelete: (workflow: SavedWorkflow) => Promise<void>
  onCreateFolder: (name: string) => Promise<WorkflowFolder>
  onRenameFolder: (folder: WorkflowFolder, name: string) => Promise<WorkflowFolder>
  onDeleteFolder: (folder: WorkflowFolder, targetFolderId?: string) => Promise<number>
  onMoveToFolder: (workflow: SavedWorkflow, folderId?: string) => Promise<void>
  onRestoreVersion: (workflow: SavedWorkflow, version: WorkflowVersion, publish: boolean) => Promise<SavedWorkflow>
  onStatusChange: (workflow: SavedWorkflow, status: WorkflowStatus) => Promise<void>
  onUseTemplate: (name: string, document: WorkflowDocument, folderId?: string) => Promise<void>
  onExit: () => void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | WorkflowStatus>('all')
  const [folderFilter, setFolderFilter] = useState<WorkflowFolderFilter>('all')
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([])
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([])
  const [auxLoading, setAuxLoading] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null)
  const [rowAction, setRowAction] = useState<{ id: string; kind: 'duplicate' | 'delete' | 'move' } | null>(null)
  const [creatingTemplate, setCreatingTemplate] = useState<string | null>(null)
  const [recoveringRunId, setRecoveringRunId] = useState<string | null>(null)
  const [historyWorkflow, setHistoryWorkflow] = useState<SavedWorkflow | null>(null)
  const [waitDialog, setWaitDialog] = useState<{ run: WorkflowRunRecord; mode: 'callback' | 'approval'; callbackUrl?: string; token?: string; error?: string } | null>(null)
  const [waitNote, setWaitNote] = useState('')
  const [waitBusy, setWaitBusy] = useState(false)
  const [runDetail, setRunDetail] = useState<WorkflowRunRecord | null>(null)
  const [runDetailLoading, setRunDetailLoading] = useState<string | null>(null)
  const [runDetailError, setRunDetailError] = useState<string | null>(null)
  const [replaySource, setReplaySource] = useState<WorkflowRunSummary | null>(null)
  const [replayingRunId, setReplayingRunId] = useState<string | null>(null)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [runInputWorkflow, setRunInputWorkflow] = useState<SavedWorkflow | null>(null)
  const [moveWorkflow, setMoveWorkflow] = useState<SavedWorkflow | null>(null)
  const [moveFolderId, setMoveFolderId] = useState('')
  const [moveError, setMoveError] = useState('')
  const replayControllerRef = useRef<{ sourceId: string; runId: string; controller: AbortController } | null>(null)
  const runningRef = useRef<string | null>(null)
  const activeRunRef = useRef<{ workflowId: string; runId: string; controller: AbortController } | null>(null)
  const statusUpdatingRef = useRef<string | null>(null)
  const rowActionRef = useRef<string | null>(null)
  const creatingTemplateRef = useRef<string | null>(null)
  const recoveringRunRef = useRef<string | null>(null)
  const activeRecoveryRef = useRef<{ sourceId: string; runId: string; controller: AbortController } | null>(null)

  const foldersById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders])
  const filtered = useMemo(() => workflows.filter((workflow) => {
    const folder = workflow.folderId ? foldersById.get(workflow.folderId) : undefined
    const matchesQuery = !query.trim() || `${workflow.name} ${workflow.description ?? ''} ${folder?.name ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    const matchesFolder = folderFilter === 'all'
      || (folderFilter === 'uncategorized' ? !folder : workflow.folderId === folderFilter)
    return matchesQuery && matchesFolder && (status === 'all' || workflow.status === status)
  }), [folderFilter, foldersById, query, status, workflows])

  const beginDashboardRun = async (workflow: SavedWorkflow, input?: unknown): Promise<void> => {
    if (runningRef.current) throw new Error('已有工作流正在运行')
    const runId = `dashboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const controller = new AbortController()
    runningRef.current = workflow.id
    activeRunRef.current = { workflowId: workflow.id, runId, controller }
    setRunningId(workflow.id)
    try {
      await onRun(workflow, runId, controller.signal, input)
    } finally {
      runningRef.current = null
      activeRunRef.current = null
      setRunningId(null)
    }
  }

  const requestDashboardRun = async (workflow: SavedWorkflow): Promise<void> => {
    if (runningRef.current === workflow.id && activeRunRef.current) {
      activeRunRef.current.controller.abort(new Error('运行已取消'))
      await onCancelRun(activeRunRef.current.runId).catch(() => undefined)
      return
    }
    if (runningRef.current) return
    if (executionDocument(workflow).inputs?.length) {
      setRunInputWorkflow(workflow)
      return
    }
    try {
      await beginDashboardRun(workflow)
    } catch {
      // The application-level callback already displays a concise failure notice.
    }
  }

  useEffect(() => {
    if (section !== 'runs' && section !== 'schedules') return
    let cancelled = false
    setAuxLoading(true)
    const request = section === 'runs'
      ? listWorkflowRunSummaries().then((items) => ({ runs: items }))
      : fetch('/dsh-node-flow/schedules', { cache: 'no-store' }).then((response) => response.json())
    void request
      .then((data: { runs?: WorkflowRunSummary[]; schedules?: ScheduleRecord[] }) => {
        if (cancelled) return
        if (section === 'runs') setRuns(Array.isArray(data.runs) ? data.runs : [])
        else setSchedules(Array.isArray(data.schedules) ? data.schedules : [])
      })
      .catch(() => {
        if (!cancelled) {
          if (section === 'runs') setRuns([])
          else setSchedules([])
        }
      })
      .finally(() => {
        if (!cancelled) setAuxLoading(false)
      })
    return () => { cancelled = true }
  }, [section])

  return (
    <div className="wf-app-shell">
      <aside className="wf-app-sidebar">
        <div className="wf-app-brand">
          <span><Workflow size={19} /></span>
          <div><strong>DSH Flow</strong><small>Automation</small></div>
        </div>
        <div
          className="wf-workspace-context"
          aria-label="当前空间：本地工作区"
          title="当前版本的工作流统一保存在本机 DSH 数据目录"
        >
          <span><HardDrive size={15} /></span>
          <div><small>当前空间</small><strong>本地工作区</strong></div>
        </div>
        <nav aria-label="流程应用导航">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} className={section === item.id ? 'is-active' : ''} onClick={() => onSectionChange(item.id)} aria-label={item.label} title={item.label}>
                <Icon size={17} /><span>{item.label}</span>
                {item.id === 'workflows' && workflows.length > 0 && <small>{workflows.length}</small>}
              </button>
            )
          })}
        </nav>
        <div className="wf-app-sidebar__footer">
          <button onClick={onExit} aria-label="退出节点模式" title="退出节点模式"><XCircle size={17} /><span>退出节点模式</span></button>
        </div>
      </aside>

      <main className="wf-dashboard">
        {section === 'workflows' && (
          <>
            <SectionHeader title="工作流" description="创建、管理并运行你的自动化流程。">
              <button className="wf-primary-command" onClick={() => onCreate(folderFilter === 'all' || folderFilter === 'uncategorized' ? undefined : folderFilter)}><Plus size={16} />新建工作流</button>
            </SectionHeader>
            <div className="wf-workflow-library">
              <WorkflowFolderNavigator
                folders={folders}
                workflows={workflows}
                selected={folderFilter}
                onSelect={setFolderFilter}
                onCreateWorkflow={onCreate}
                onCreateFolder={onCreateFolder}
                onRenameFolder={onRenameFolder}
                onDeleteFolder={onDeleteFolder}
              />
              <div className="wf-workflow-library__content">
                <div className="wf-list-toolbar">
                  <label className="wf-dashboard-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索工作流" /></label>
                  <div className="wf-segmented" role="group" aria-label="状态筛选">
                    <button className={status === 'all' ? 'is-active' : ''} onClick={() => setStatus('all')}>全部</button>
                    <button className={status === 'enabled' ? 'is-active' : ''} onClick={() => setStatus('enabled')}>已启用</button>
                    <button className={status === 'disabled' ? 'is-active' : ''} onClick={() => setStatus('disabled')}>草稿</button>
                  </div>
                  <span className="wf-list-count"><ListFilter size={14} />{filtered.length} 个流程</span>
                </div>
                <div className="wf-workflow-table">
              <div className="wf-workflow-table__head"><span>名称</span><span>状态</span><span>节点</span><span>最后更新</span><span>最近运行</span><span /></div>
              {loading && <div className="wf-dashboard-empty"><RefreshCw className="wf-spin" size={22} /><strong>正在加载工作流</strong></div>}
              {!loading && filtered.length === 0 && (
                <div className="wf-dashboard-empty">
                  <span><Workflow size={24} /></span>
                  <strong>{workflows.length === 0 ? '还没有工作流' : '没有匹配的工作流'}</strong>
                  <p>{workflows.length === 0 ? '创建第一个流程，或者从模板开始。' : '调整搜索词或状态筛选后再试。'}</p>
                  {workflows.length === 0 && <button className="wf-primary-command" onClick={() => onCreate()}><Plus size={16} />新建工作流</button>}
                </div>
              )}
              {!loading && filtered.map((workflow) => {
                const rowBusy = runningId === workflow.id || statusUpdatingId === workflow.id || rowAction?.id === workflow.id
                const unpublished = hasUnpublishedChanges(workflow)
                return (
                <div key={workflow.id} className="wf-workflow-row" aria-busy={rowBusy}>
                  <button className="wf-workflow-name" onClick={() => onOpen(workflow)} disabled={rowBusy}>
                    <span><Workflow size={17} /></span>
                    <span><strong>{workflow.name}</strong><small>{workflow.description || 'DSH 自动化工作流'}{workflow.folderId && foldersById.get(workflow.folderId) ? ` · ${foldersById.get(workflow.folderId)!.name}` : ''}</small></span>
                  </button>
                  <div className="wf-row-status">
                    <button
                      onClick={() => setHistoryWorkflow(workflow)}
                      disabled={rowAction !== null || statusUpdatingId === workflow.id || runningId === workflow.id}
                      title="版本历史"
                      aria-label={`查看 ${workflow.name} 的版本历史`}
                    ><History size={15} /></button>
                    <button
                      className={`wf-status-toggle ${workflow.status === 'enabled' ? 'is-enabled' : ''}${unpublished ? ' is-stale' : ''}`}
                      onClick={async () => {
                        if (statusUpdatingRef.current) return
                        statusUpdatingRef.current = workflow.id
                        setStatusUpdatingId(workflow.id)
                        try {
                          await onStatusChange(workflow, workflow.status === 'enabled' && !unpublished ? 'disabled' : 'enabled')
                        } finally {
                          statusUpdatingRef.current = null
                          setStatusUpdatingId(null)
                        }
                      }}
                      disabled={statusUpdatingId !== null || runningId === workflow.id || rowAction?.id === workflow.id}
                      role={unpublished ? undefined : 'switch'}
                      aria-checked={unpublished ? undefined : workflow.status === 'enabled'}
                      aria-label={unpublished ? `发布 ${workflow.name} 的更新` : workflow.status === 'enabled' ? `停用 ${workflow.name}` : `发布 ${workflow.name}`}
                    ><span />{statusUpdatingId === workflow.id ? '更新中' : unpublished ? '待发布' : workflow.status === 'enabled' ? '已启用' : '草稿'}</button>
                  </div>
                  <div className="wf-workflow-meta">
                    <span className="wf-table-muted" data-label="节点">{workflow.doc.nodes.length}</span>
                    <span className="wf-table-muted" data-label="最后更新">{formatDate(workflow.updatedAt)}</span>
                    <span className="wf-table-muted" data-label="最近运行">{formatDate(workflow.lastRunAt)}</span>
                  </div>
                  <div className="wf-row-actions">
                    <button
                      onClick={() => { void requestDashboardRun(workflow) }}
                      disabled={(runningId !== null && runningId !== workflow.id) || statusUpdatingId === workflow.id || rowAction?.id === workflow.id}
                      title={runningId === workflow.id ? '停止' : '运行'}
                      aria-label={`${runningId === workflow.id ? '停止' : '运行'} ${workflow.name}`}
                    >
                      {runningId === workflow.id ? <Square size={14} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
                    </button>
                    <button
                      onClick={() => {
                        setMoveWorkflow(workflow)
                        setMoveFolderId(workflow.folderId ?? '')
                        setMoveError('')
                      }}
                      disabled={rowAction !== null || statusUpdatingId === workflow.id || runningId === workflow.id}
                      title="移动到文件夹"
                      aria-label={`移动 ${workflow.name} 到文件夹`}
                    ><FolderInput size={15} /></button>
                    <button
                      onClick={async () => {
                        if (rowActionRef.current) return
                        rowActionRef.current = workflow.id
                        setRowAction({ id: workflow.id, kind: 'duplicate' })
                        try {
                          await onDuplicate(workflow)
                        } finally {
                          rowActionRef.current = null
                          setRowAction(null)
                        }
                      }}
                      disabled={rowAction !== null || statusUpdatingId === workflow.id || runningId === workflow.id}
                      title="复制"
                      aria-label={`复制 ${workflow.name}`}
                    >
                      {rowAction?.id === workflow.id && rowAction.kind === 'duplicate' ? <RefreshCw className="wf-spin" size={15} /> : <Copy size={15} />}
                    </button>
                    <button
                      onClick={async () => {
                        if (rowActionRef.current) return
                        rowActionRef.current = workflow.id
                        setRowAction({ id: workflow.id, kind: 'delete' })
                        try {
                          await onDelete(workflow)
                        } finally {
                          rowActionRef.current = null
                          setRowAction(null)
                        }
                      }}
                      disabled={rowAction !== null || statusUpdatingId === workflow.id || runningId === workflow.id}
                      title="删除"
                      aria-label={`删除 ${workflow.name}`}
                    >
                      {rowAction?.id === workflow.id && rowAction.kind === 'delete' ? <RefreshCw className="wf-spin" size={15} /> : <Trash2 size={15} />}
                    </button>
                    <button onClick={() => onOpen(workflow)} disabled={rowBusy} title="打开" aria-label={`打开 ${workflow.name}`}><ChevronRight size={16} /></button>
                  </div>
                </div>
              )})}
                </div>
              </div>
            </div>
          </>
        )}

        {section === 'runs' && (
          <>
            <SectionHeader title="运行记录" description="查看手动运行与定时运行的执行结果。" />
            <div className="wf-simple-table wf-simple-table--runs">
              <div className="wf-simple-table__head"><span>工作流</span><span>状态</span><span>开始时间</span><span>节点数</span><span>失败节点</span><span>操作</span></div>
              {auxLoading && <div className="wf-dashboard-empty"><RefreshCw className="wf-spin" size={22} /><strong>正在加载运行记录</strong></div>}
              {!auxLoading && runs.length === 0 && <div className="wf-dashboard-empty"><Activity size={25} /><strong>暂无运行记录</strong><p>运行工作流后，结果会显示在这里。</p></div>}
              {runs.map((run) => {
                const running = run.status === 'running'
                const queued = run.status === 'queued'
                const continued = run.status === 'waiting' && Boolean(run.resumedByRunId)
                const waiting = run.status === 'waiting' && !continued
                const interrupted = run.status === 'interrupted'
                const cancelled = run.status === 'cancelled'
                 const skipped = run.status === 'skipped'
                 const handled = run.status === 'handled'
                 const limited = run.timedOut === true
                 const statusLabel = limited ? '已超限' : run.status === 'ok' ? '成功' : handled ? '错误已处理' : queued ? '排队中' : running ? '运行中' : waiting ? '等待中' : continued ? '已继续' : interrupted ? '已中断' : cancelled ? '已取消' : skipped ? '已跳过' : '失败'
                 const limitDetail = limited ? run.limitReason === 'steps' ? '超过最大执行步数' : '超过最长运行时间' : undefined
                 const StatusIcon = limited ? Clock3 : run.status === 'ok' || handled || continued ? CheckCircle2 : queued ? Clock3 : running ? RefreshCw : waiting ? Hourglass : interrupted ? XCircle : CircleOff
                const waitDetail = waiting && run.waitpoint
                  ? run.waitpoint.mode === 'delay'
                    ? `延迟至 ${formatDate(run.waitpoint.resumeAt)}`
                    : run.waitpoint.mode === 'callback'
                      ? `等待外部回调${run.waitpoint.expiresAt ? ` · 截止 ${formatDate(run.waitpoint.expiresAt)}` : ''}`
                    : run.waitpoint.mode === 'approval'
                        ? `等待人工审批${run.waitpoint.expiresAt ? ` · 截止 ${formatDate(run.waitpoint.expiresAt)}` : ''}`
                        : run.waitpoint.mode === 'debug'
                          ? `断点暂停${run.waitpoint.debugReason ? ` · ${run.waitpoint.debugReason}` : ''}`
                        : `等待子工作流${run.waitpoint.childRunId ? ` · ${run.waitpoint.childRunId}` : ''}`
                  : undefined
                return <div className="wf-simple-row" key={run.id}>
                   <strong>{run.name}{limitDetail ? <small>{limitDetail}</small> : waitDetail ? <small>{waitDetail}</small> : queued ? <small>等待并发槽位{run.queuedAt ? ` · 自 ${formatDate(run.queuedAt)} 起` : ''}</small> : skipped ? <small>{run.skipReason || '当前并发策略已跳过本次触发'}</small> : run.parentRunId ? <small>子工作流 · 深度 {run.depth ?? 1}</small> : run.resumedFromRunId && <small>恢复运行</small>}</strong>
                  <span data-label="状态" className={`wf-run-badge is-${run.status}`}><StatusIcon className={running ? 'wf-spin' : undefined} size={13} />{statusLabel}</span>
                  <span data-label="开始时间">{formatDate(run.startedAt)}</span>
                  <span data-label="节点数">{run.nodeCount}</span>
                  <span data-label="失败节点">{run.failed}{run.handledErrors ? ` · ${run.handledErrors} 已处理` : ''}</span>
                  <span data-label="操作" className="wf-run-actions">
                    <button
                      type="button"
                      title="查看运行详情"
                      aria-label={`查看 ${run.name} 的运行详情`}
                      disabled={runDetailLoading === run.id}
                      onClick={async () => {
                        setRunDetailLoading(run.id)
                        setRunDetailError(null)
                        try {
                          setRunDetail(await getWorkflowRunDetail(run.id))
                        } catch (error) {
                          setRunDetailError(error instanceof Error ? error.message : String(error))
                        } finally {
                          setRunDetailLoading(null)
                        }
                      }}
                    >{runDetailLoading === run.id ? <RefreshCw className="wf-spin" size={12} /> : <ListTree size={13} />}详情</button>
                    {queued ? <button type="button" onClick={async () => { await onCancelRun(run.id).catch(() => undefined); setRuns(await listWorkflowRunSummaries()) }}><Square size={12} />取消排队</button> : waiting ? <>{run.waitpoint?.mode === 'callback' && <button type="button" disabled={waitBusy} onClick={async () => {
                      setWaitBusy(true)
                      setWaitDialog({ run: run as WorkflowRunRecord, mode: 'callback' })
                      try {
                        const result = await createWaitpointCallbackToken(run.id)
                        setWaitDialog({ run: run as WorkflowRunRecord, mode: 'callback', callbackUrl: `${window.location.origin}${result.callbackUrl}`, token: result.token })
                      } catch (error) {
                        setWaitDialog({ run: run as WorkflowRunRecord, mode: 'callback', error: error instanceof Error ? error.message : String(error) })
                      } finally { setWaitBusy(false) }
                    }}><KeyRound size={12} />回调凭证</button>}{run.waitpoint?.mode === 'approval' && <button type="button" onClick={() => { setWaitNote(''); setWaitDialog({ run: run as WorkflowRunRecord, mode: 'approval' }) }}><CheckCircle2 size={12} />处理审批</button>}<button type="button" onClick={async () => { await onCancelRun(run.id).catch(() => undefined); setRuns(await listWorkflowRunSummaries()) }}><Square size={12} />取消</button></> : running ? <button
                      type="button"
                      onClick={async () => {
                        await onCancelRun(run.id).catch(() => undefined)
                        setRuns(await listWorkflowRunSummaries())
                      }}
                    ><Square size={12} fill="currentColor" />停止运行</button> : run.resumable && !run.resumedByRunId ? <button
                      type="button"
                      disabled={recoveringRunId !== null && recoveringRunId !== run.id}
                      onClick={async () => {
                        if (activeRecoveryRef.current?.sourceId === run.id) {
                          activeRecoveryRef.current.controller.abort(new Error('恢复运行已取消'))
                          await onCancelRun(activeRecoveryRef.current.runId).catch(() => undefined)
                          return
                        }
                        if (recoveringRunRef.current) return
                        recoveringRunRef.current = run.id
                        setRecoveringRunId(run.id)
                        const runId = `resume-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
                        const controller = new AbortController()
                        activeRecoveryRef.current = { sourceId: run.id, runId, controller }
                        try {
                          await onResumeRun(run, runId, controller.signal)
                        } catch {
                          /* Parent surface already reports the recovery error. */
                        } finally {
                          setRuns(await listWorkflowRunSummaries())
                          activeRecoveryRef.current = null
                          recoveringRunRef.current = null
                          setRecoveringRunId(null)
                        }
                      }}
                    >{recoveringRunId === run.id ? <Square size={12} fill="currentColor" /> : <RotateCcw size={13} />}{recoveringRunId === run.id ? '停止恢复' : '从失败处恢复'}</button> : run.replayable ? <button type="button" onClick={() => { setReplayError(null); setReplaySource(run) }}><RotateCcw size={13} />重放</button> : run.resumedByRunId ? <span>已恢复</span> : <span>—</span>}
                  </span>
                </div>
              })}
            </div>
          </>
        )}

        {section === 'schedules' && (
          <>
            <SectionHeader title="定时任务" description="集中查看工作流中的 Cron 调度、时区与下一次触发。" />
            <div className="wf-simple-table wf-simple-table--schedules">
              <div className="wf-simple-table__head"><span>任务</span><span>Cron</span><span>时区</span><span>下次触发</span><span>上次触发</span><span>工作流快照</span></div>
              {auxLoading && <div className="wf-dashboard-empty"><RefreshCw className="wf-spin" size={22} /><strong>正在加载定时任务</strong></div>}
              {!auxLoading && schedules.length === 0 && <div className="wf-dashboard-empty"><AlarmClock size={25} /><strong>暂无定时任务</strong><p>在编辑器中添加 Schedule 节点并保存计划。</p></div>}
              {schedules.map((schedule) => <div className="wf-simple-row" key={schedule.id}><strong>{schedule.name}{schedule.configurationError && <small>{schedule.configurationError}</small>}</strong><code data-label="Cron">{schedule.cron}</code><span data-label="时区">{schedule.timezoneLabel ?? schedule.timezone ?? '系统时区'}</span><span data-label="下次触发">{schedule.nextFire || '—'}</span><span data-label="上次触发">{schedule.lastFired || '从未'}</span><span data-label="工作流快照">{schedule.doc ? `${schedule.doc.nodes.length} 个节点` : '无快照'}</span></div>)}
            </div>
          </>
        )}

        {section === 'templates' && (
          <>
            <SectionHeader title="模板" description="从经过验证的 DSH 工作流结构开始。" />
            <div className="wf-template-list">
              {TEMPLATES.map((template) => {
                const Icon = template.icon
                return (
                  <article key={template.name}>
                    <span><Icon size={20} /></span>
                    <div><strong>{template.name}</strong><p>{template.description}</p></div>
                    <button
                      disabled={creatingTemplate !== null}
                      onClick={async () => {
                        if (creatingTemplateRef.current) return
                        creatingTemplateRef.current = template.name
                        setCreatingTemplate(template.name)
                        try {
                          await onUseTemplate(template.name, template.build(), folderFilter === 'all' || folderFilter === 'uncategorized' ? undefined : folderFilter)
                        } finally {
                          creatingTemplateRef.current = null
                          setCreatingTemplate(null)
                        }
                      }}
                    >
                      {creatingTemplate === template.name ? '正在创建' : '使用模板'}
                    </button>
                  </article>
                )
              })}
            </div>
          </>
        )}
        {section === 'credentials' && <CredentialsPanel />}
        {section === 'variables' && <ProjectVariablesPanel />}
        {section === 'audit' && <AuditLogPanel />}
      </main>
      {historyWorkflow && (
        <VersionHistoryPanel
          workflow={historyWorkflow}
          onClose={() => setHistoryWorkflow(null)}
          onRestore={async (workflow, version, publish) => {
            const saved = await onRestoreVersion(workflow, version, publish)
            setHistoryWorkflow(saved)
            return saved
          }}
        />
      )}
      {moveWorkflow && <div className="wf-dialog-backdrop" role="presentation" onMouseDown={(event) => {
        if (rowAction !== null || event.target !== event.currentTarget) return
        setMoveWorkflow(null)
      }}><section className="wf-credential-dialog wf-folder-dialog" role="dialog" aria-modal="true" aria-label="移动工作流">
        <header><div><FolderInput size={17} /><strong>移动工作流</strong></div><button className="wf-icon-button" disabled={rowAction !== null} onClick={() => setMoveWorkflow(null)} aria-label="关闭"><XCircle size={17} /></button></header>
        <div className="wf-credential-dialog__body"><strong>{moveWorkflow.name}</strong><p>移动只更新组织归属，不会修改草稿、发布版本或执行快照。</p><label><span>文件夹</span><select aria-label="移动工作流的目标文件夹" value={moveFolderId} onChange={(event) => setMoveFolderId(event.target.value)}><option value="">未分类</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>{moveError && <p className="wf-wait-dialog__error" role="alert">{moveError}</p>}</div>
        <footer><button type="button" disabled={rowAction !== null} onClick={() => setMoveWorkflow(null)}>取消</button><button type="button" className="wf-primary-command" disabled={rowAction !== null || moveFolderId === (moveWorkflow.folderId ?? '')} onClick={async () => {
          if (rowActionRef.current) return
          rowActionRef.current = moveWorkflow.id
          setRowAction({ id: moveWorkflow.id, kind: 'move' })
          setMoveError('')
          try {
            await onMoveToFolder(moveWorkflow, moveFolderId || undefined)
            setMoveWorkflow(null)
          } catch (error) {
            setMoveError(error instanceof Error ? error.message : String(error))
          } finally {
            rowActionRef.current = null
            setRowAction(null)
          }
        }}>{rowAction?.id === moveWorkflow.id && rowAction.kind === 'move' ? <RefreshCw className="wf-spin" size={14} /> : <FolderInput size={14} />}{rowAction?.id === moveWorkflow.id && rowAction.kind === 'move' ? '正在移动' : '确认移动'}</button></footer>
      </section></div>}
      {runDetailError && <div className="wf-dialog-backdrop" role="presentation"><section className="wf-credential-dialog wf-run-detail-dialog" role="dialog" aria-modal="true" aria-label="运行详情错误">
        <header><div><CircleOff size={17} /><strong>无法加载运行详情</strong></div><button className="wf-icon-button" onClick={() => setRunDetailError(null)} aria-label="关闭"><XCircle size={17} /></button></header>
        <div className="wf-credential-dialog__body"><p className="wf-wait-dialog__error">{runDetailError}</p></div>
        <footer><button type="button" onClick={() => setRunDetailError(null)}>关闭</button></footer>
      </section></div>}
      {runDetail && <div className="wf-dialog-backdrop" role="presentation"><section className="wf-credential-dialog wf-run-detail-dialog" role="dialog" aria-modal="true" aria-label="运行详情">
        <header><div><ListTree size={17} /><strong>运行详情</strong></div><button className="wf-icon-button" onClick={() => setRunDetail(null)} aria-label="关闭"><XCircle size={17} /></button></header>
        <div className="wf-credential-dialog__body wf-run-detail-dialog__body">
           <div className="wf-run-detail-summary"><strong>{runDetail.name}</strong><span>{formatDate(runDetail.startedAt)} · {runDetail.timedOut ? runDetail.limitReason === 'steps' ? '超过执行步数' : '超过运行时限' : runDetail.status === 'ok' ? '成功' : runDetail.status === 'handled' ? '错误已处理' : runDetail.status}</span><span>{runDetail.nodeCount} 个节点 · {runDetail.failed} 个失败{runDetail.handledErrors ? ` · ${runDetail.handledErrors} 个已处理` : ''}</span>{runDetail.replayedFromRunId && <span>重放自 {runDetail.replayedFromRunId}</span>}</div>
          <div className="wf-run-detail-nodes">{runDetail.nodes.map((node, index) => <article key={`${node.id}-${index}`} className={`is-${node.status}`}>
            <header><strong>{index + 1}. {node.kind}</strong><span>{node.status === 'ok' ? '成功' : node.status === 'error' ? node.errorHandled ? '错误已路由' : '失败' : node.status} · {node.ms} ms{node.attempts && node.attempts > 1 ? ` · ${node.attempts} 次` : ''}</span></header>
            {node.input !== undefined && <label><span>输入</span><pre>{formatRunValue(node.input)}</pre></label>}
            {(node.output !== undefined || node.error) && <label><span>{node.error ? '错误' : '输出'}</span><pre className={node.error ? 'is-error' : undefined}>{node.error || formatRunValue(node.output)}</pre></label>}
            {node.logs && node.logs.length > 0 && <label><span>日志</span><pre>{node.logs.join('\n')}</pre></label>}
          </article>)}</div>
        </div>
        <footer><button type="button" onClick={() => setRunDetail(null)}>关闭</button></footer>
      </section></div>}
      {runInputWorkflow && <WorkflowRunInputDialog
        workflowName={runInputWorkflow.name}
        fields={executionDocument(runInputWorkflow).inputs ?? []}
        published={runInputWorkflow.status === 'enabled'}
        onClose={() => setRunInputWorkflow(null)}
        onSubmit={async (input) => { await beginDashboardRun(runInputWorkflow, input) }}
      />}
      {replaySource && <div className="wf-dialog-backdrop" role="presentation"><section className="wf-credential-dialog wf-replay-dialog" role="dialog" aria-modal="true" aria-label="确认重放运行">
        <header><div><RotateCcw size={17} /><strong>确认重放运行</strong></div><button className="wf-icon-button" disabled={replayingRunId !== null} onClick={() => setReplaySource(null)} aria-label="关闭"><XCircle size={17} /></button></header>
        <div className="wf-credential-dialog__body"><strong>{replaySource.name}</strong><p>将使用这次运行保存的不可变工作流快照和原始安全输入，重新执行全部步骤。任何写入外部系统的节点都会再次执行。</p>{replayError && <p className="wf-wait-dialog__error">{replayError}</p>}</div>
        <footer><button type="button" disabled={replayingRunId !== null} onClick={() => setReplaySource(null)}>取消</button><button type="button" className="wf-primary-command" disabled={replayingRunId !== null} onClick={async () => {
          if (replayControllerRef.current) return
          const runId = `replay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const controller = new AbortController()
          replayControllerRef.current = { sourceId: replaySource.id, runId, controller }
          setReplayingRunId(replaySource.id)
          setReplayError(null)
          try {
            await replayWorkflowRun(replaySource, runId, controller.signal)
            setRuns(await listWorkflowRunSummaries())
            setReplaySource(null)
          } catch (error) {
            if (controller.signal.aborted) setReplaySource(null)
            else setReplayError(error instanceof Error ? error.message : String(error))
          } finally {
            replayControllerRef.current = null
            setReplayingRunId(null)
          }
        }}>{replayingRunId === replaySource.id ? <RefreshCw className="wf-spin" size={14} /> : <RotateCcw size={14} />}{replayingRunId === replaySource.id ? '正在重放' : '确认重放'}</button>{replayingRunId === replaySource.id && <button type="button" className="wf-dialog-btn" onClick={() => { const active = replayControllerRef.current; if (!active) return; active.controller.abort(new Error('重放已取消')); void onCancelRun(active.runId).catch(() => undefined) }}><Square size={14} />停止重放</button>}</footer>
      </section></div>}
      {waitDialog && <div className="wf-dialog-backdrop" role="presentation"><section className="wf-credential-dialog wf-wait-dialog" role="dialog" aria-modal="true" aria-label={waitDialog.mode === 'callback' ? '外部回调凭证' : '处理审批'}>
        <header><div><Hourglass size={17} /><strong>{waitDialog.mode === 'callback' ? '外部回调凭证' : '处理审批'}</strong></div><button className="wf-icon-button" onClick={() => setWaitDialog(null)} aria-label="关闭"><XCircle size={17} /></button></header>
        <div className="wf-credential-dialog__body">
          <strong>{waitDialog.run.name}</strong>
          {waitDialog.error && <p className="wf-wait-dialog__error">{waitDialog.error}</p>}
          {waitDialog.mode === 'callback' ? <>
            <label><span>回调地址</span><div className="wf-credential-copy"><input readOnly value={waitDialog.callbackUrl ?? '正在生成'} /><button type="button" disabled={!waitDialog.callbackUrl} onClick={() => void navigator.clipboard.writeText(waitDialog.callbackUrl ?? '')}><Copy size={14} />复制</button></div></label>
            <label><span>一次性 Token</span><div className="wf-credential-copy"><input readOnly type="password" value={waitDialog.token ?? '正在生成'} /><button type="button" disabled={!waitDialog.token} onClick={() => void navigator.clipboard.writeText(waitDialog.token ?? '')}><Copy size={14} />复制</button></div></label>
            <code className="wf-wait-dialog__code">x-dsh-wait-token: {waitDialog.token ?? '...'}</code>
          </> : <label><span>审批备注</span><textarea rows={5} value={waitNote} onChange={(event) => setWaitNote(event.target.value)} placeholder="可选" /></label>}
        </div>
        <footer><button type="button" onClick={() => setWaitDialog(null)}>关闭</button>{waitDialog.mode === 'approval' && <><button type="button" className="wf-dialog-btn" disabled={waitBusy} onClick={async () => { setWaitBusy(true); try { await resolveWorkflowApproval(waitDialog.run.id, 'rejected', waitNote); setRuns(await listWorkflowRuns()); setWaitDialog(null) } catch (error) { setWaitDialog((current) => current ? { ...current, error: error instanceof Error ? error.message : String(error) } : null) } finally { setWaitBusy(false) } }}>拒绝</button><button type="button" className="wf-primary-command" disabled={waitBusy} onClick={async () => { setWaitBusy(true); try { await resolveWorkflowApproval(waitDialog.run.id, 'approved', waitNote); setRuns(await listWorkflowRuns()); setWaitDialog(null) } catch (error) { setWaitDialog((current) => current ? { ...current, error: error instanceof Error ? error.message : String(error) } : null) } finally { setWaitBusy(false) } }}>通过</button></>}</footer>
      </section></div>}
    </div>
  )
}

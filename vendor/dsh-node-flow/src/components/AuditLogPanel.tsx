import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Braces, Clock3, FolderTree, KeyRound, Loader2, RefreshCw, Search, ShieldCheck, Workflow } from 'lucide-react'
import type { WorkflowAuditAction, WorkflowAuditEvent, WorkflowAuditTargetType } from '../model.js'
import { listWorkflowAuditEvents } from '../workflowRepository.js'

type TargetFilter = 'all' | WorkflowAuditTargetType

const TARGET_OPTIONS: Array<{ value: TargetFilter; label: string }> = [
  { value: 'all', label: '全部对象' },
  { value: 'workflow', label: '工作流' },
  { value: 'credential', label: '连接' },
  { value: 'variable', label: '变量' },
  { value: 'folder', label: '文件夹' },
  { value: 'run', label: '运行' },
  { value: 'waitpoint', label: '等待点' },
]

const ACTION_LABELS: Record<WorkflowAuditAction, string> = {
  'workflow.created': '创建工作流',
  'workflow.moved': '移动工作流',
  'workflow.published': '发布工作流',
  'workflow.disabled': '停用工作流',
  'workflow.deleted': '删除工作流',
  'workflow.restored': '恢复工作流版本',
  'credential.created': '创建连接',
  'credential.updated': '更新连接',
  'credential.tested': '测试连接',
  'credential.authorization-started': '开始 OAuth2 授权',
  'credential.authorized': '完成 OAuth2 授权',
  'credential.authorization-cancelled': '取消 OAuth2 授权',
  'credential.deleted': '删除连接',
  'variable.created': '创建变量',
  'variable.updated': '更新变量',
  'variable.deleted': '删除变量',
  'folder.created': '创建文件夹',
  'folder.renamed': '重命名文件夹',
  'folder.deleted': '删除文件夹',
  'run.manual-started': '启动手动运行',
  'run.debug-started': '启动断点调试',
  'run.debug-stepped': '执行下一步调试',
  'run.debug-continued': '继续断点调试',
  'run.debug-cancelled': '取消断点调试',
  'run.cancelled': '取消运行',
  'run.resumed': '恢复运行',
  'run.replayed': '重放运行',
  'waitpoint.approved': '通过审批',
  'waitpoint.rejected': '拒绝审批',
}

function targetLabel(type: WorkflowAuditTargetType): string {
  return TARGET_OPTIONS.find((option) => option.value === type)?.label || type
}

function targetIcon(type: WorkflowAuditTargetType) {
  if (type === 'workflow') return <Workflow size={16} />
  if (type === 'credential') return <KeyRound size={16} />
  if (type === 'variable') return <Braces size={16} />
  if (type === 'folder') return <FolderTree size={16} />
  if (type === 'run') return <Activity size={16} />
  return <Clock3 size={16} />
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function eventMatches(event: WorkflowAuditEvent, query: string): boolean {
  if (!query) return true
  const source = [
    ACTION_LABELS[event.action],
    event.action,
    event.target.name,
    event.target.id,
    targetLabel(event.target.type),
    event.actor === 'system' ? '系统' : '本地用户',
    ...Object.entries(event.details ?? {}).flatMap(([key, value]) => [key, String(value)]),
  ].filter(Boolean).join(' ').toLocaleLowerCase()
  return source.includes(query.toLocaleLowerCase())
}

export function AuditLogPanel() {
  const [events, setEvents] = useState<WorkflowAuditEvent[]>([])
  const [targetType, setTargetType] = useState<TargetFilter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const requestVersion = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const version = ++requestVersion.current
    setLoading(true)
    setError('')
    try {
      const next = await listWorkflowAuditEvents({
        limit: 200,
        targetType: targetType === 'all' ? undefined : targetType,
      })
      if (version === requestVersion.current) setEvents(next)
    } catch (caught) {
      if (version === requestVersion.current) setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [targetType])

  useEffect(() => {
    void load()
    return () => { requestVersion.current += 1 }
  }, [load])

  const visible = useMemo(() => events.filter((event) => eventMatches(event, query.trim())), [events, query])

  return (
    <>
      <header className="wf-page-header">
        <div><h1>审计日志</h1><p>记录本机控制面操作。敏感输入、连接密钥、运行输出与审批备注不会写入。</p></div>
        <div className="wf-page-header__actions">
          <button className="wf-icon-button" onClick={() => void load()} disabled={loading} aria-label="刷新审计日志" title="刷新审计日志">
            {loading ? <Loader2 className="wf-spin" size={17} /> : <RefreshCw size={17} />}
          </button>
        </div>
      </header>
      <div className="wf-audit-toolbar">
        <label className="wf-audit-filter"><span>对象</span><select aria-label="审计对象筛选" value={targetType} onChange={(event) => setTargetType(event.target.value as TargetFilter)}>{TARGET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="wf-dashboard-search"><Search size={16} /><input aria-label="筛选审计日志" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选操作、名称或 ID" /></label>
        <span className="wf-list-count">{visible.length} 条</span>
      </div>
      {error && <div className="wf-credential-error" role="alert">{error}</div>}
      {loading && <div className="wf-dashboard-empty"><Loader2 className="wf-spin" size={22} /><strong>正在读取审计日志</strong></div>}
      {!loading && visible.length === 0 && <div className="wf-dashboard-empty"><span><ShieldCheck size={23} /></span><strong>没有匹配的审计记录</strong><p>调整筛选条件或在完成一次管理操作后刷新。</p></div>}
      {!loading && visible.length > 0 && <div className="wf-audit-list" aria-live="polite">
        {visible.map((event) => {
          const details = Object.entries(event.details ?? {})
          return <article key={event.id} className={`wf-audit-row is-${event.target.type}`}>
            <span className="wf-audit-row__icon">{targetIcon(event.target.type)}</span>
            <div className="wf-audit-row__main"><strong>{ACTION_LABELS[event.action]}</strong><small>{event.target.name || event.target.id}</small></div>
            <span className="wf-audit-row__target">{targetLabel(event.target.type)}</span>
            <div className="wf-audit-row__details">{details.length > 0 ? details.map(([key, value]) => <code key={key}>{key}: {String(value)}</code>) : <span>无附加信息</span>}</div>
            <span className="wf-audit-row__actor">{event.actor === 'system' ? '系统' : '本地用户'}</span>
            <time dateTime={event.at} title={event.at}>{formatDate(event.at)}</time>
          </article>
        })}
      </div>}
    </>
  )
}

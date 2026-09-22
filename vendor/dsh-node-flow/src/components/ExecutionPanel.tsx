import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Bug, CheckCircle2, CircleDashed, Clock3, ExternalLink, Hourglass, Loader2, Play, SkipForward, X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.js'
import { NodeGlyph } from './nodeCatalog.js'
import type { WorkflowRunRecord } from '../model.js'

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function ExecutionPanel({ onClose, debugRun, debugBusy, onDebugAction, onCancelDebug }: {
  onClose: () => void
  debugRun: WorkflowRunRecord | null
  debugBusy: boolean
  onDebugAction: (action: 'continue' | 'step') => Promise<void> | void
  onCancelDebug: () => void
}) {
  const nodes = useCanvasStore((state) => state.nodes)
  const executed = useMemo(() => nodes.filter((node) => node.data.lastRun), [nodes])
  const [activeId, setActiveId] = useState<string | null>(executed[0]?.id ?? null)
  const active = executed.find((node) => node.id === activeId) ?? executed[0]
  const running = executed.some((node) => node.data.lastRun?.running)
  const waiting = executed.some((node) => node.data.lastRun?.waiting)
  const failed = executed.some((node) => node.data.lastRun?.error && !node.data.lastRun?.errorHandled)
  const handled = executed.some((node) => node.data.lastRun?.errorHandled)
  const debugWaiting = debugRun?.status === 'waiting' && debugRun.waitpoint?.mode === 'debug'

  useEffect(() => {
    if (!activeId && executed[0]) setActiveId(executed[0].id)
  }, [activeId, executed])

  return (
    <section className="wf-execution" aria-label="运行详情">
      <header className="wf-execution__header">
        <div className="wf-execution__title">
          {running ? <Loader2 className="wf-spin" size={17} /> : waiting ? <Hourglass size={17} /> : failed ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
          <strong>{debugRun ? '调试运行' : '本次运行'}</strong>
          <span>{debugWaiting ? `已暂停 · ${debugRun.waitpoint?.debugReason === 'step' ? '单步' : '断点'}` : running ? '执行中' : waiting ? '等待外部条件' : failed ? '部分节点失败' : handled ? '错误已路由处理' : executed.length ? '执行完成' : '暂无运行结果'}</span>
        </div>
        <button className="wf-icon-btn" onClick={onClose} title="关闭运行详情" aria-label="关闭运行详情">
          <X size={17} />
        </button>
      </header>
      {debugWaiting && (
        <div className="wf-execution__debugbar" role="group" aria-label="调试控制">
          <div><Bug size={15} /><span>暂停于「{debugRun.waitpoint?.nodeId}」</span></div>
          <div className="wf-execution__debug-actions">
            <button type="button" className="wf-btn wf-btn--primary" disabled={debugBusy} onClick={() => void onDebugAction('continue')}><Play size={14} fill="currentColor" />继续</button>
            <button type="button" className="wf-btn" disabled={debugBusy} onClick={() => void onDebugAction('step')}><SkipForward size={14} />单步</button>
            <button type="button" className="wf-btn wf-btn--danger" disabled={debugBusy} onClick={onCancelDebug}><X size={14} />结束调试</button>
          </div>
        </div>
      )}
      <div className="wf-execution__body">
        <div className="wf-execution__steps" role="list">
          {executed.length === 0 && (
            <div className="wf-execution__empty"><CircleDashed size={20} />运行工作流后，这里会显示每个节点的输入、输出和耗时。</div>
          )}
          {executed.map((node, index) => {
            const run = node.data.lastRun!
            return (
              <button
                key={node.id}
                type="button"
                className={`wf-execution-step${active?.id === node.id ? ' is-active' : ''}`}
                onClick={() => setActiveId(node.id)}
              >
                <span className="wf-execution-step__index">{index + 1}</span>
                <NodeGlyph kind={node.data.kind} size={30} iconSize={14} />
                <span className="wf-execution-step__copy">
                  <strong>{node.data.label}</strong>
                  <span><Clock3 size={11} /> {run.duration ?? 0} ms{(run.attempts ?? 1) > 1 ? ` · ${run.attempts} 次` : ''}</span>
                </span>
                {run.running ? <Loader2 className="wf-spin" size={15} /> : run.waiting ? <Hourglass className="is-waiting" size={15} /> : run.error && !run.errorHandled ? <AlertCircle className="is-error" size={15} /> : <CheckCircle2 className="is-success" size={15} />}
              </button>
            )
          })}
        </div>
        {active && (
          <div className="wf-execution__detail">
            <div className="wf-execution__detail-head">
              <strong>{active.data.label}</strong>
              <span>{active.data.lastRun?.at}</span>
            </div>
            <div className="wf-execution__io">
              {active.data.kind !== 'connector-trigger' && <div>
                <span>输入</span>
                <pre>{active.data.lastRun?.input || '无输入'}</pre>
              </div>}
              <div>
                <span>{active.data.lastRun?.error ? active.data.lastRun?.errorHandled ? '已路由错误' : '错误' : '输出'}</span>
                <pre className={active.data.lastRun?.error && !active.data.lastRun?.errorHandled ? 'is-error' : ''}>
                  {active.data.lastRun?.error || formatValue(active.data.lastRun?.value) || '无输出'}
                </pre>
              </div>
              {active.data.lastRun?.logs && active.data.lastRun.logs.length > 0 && (
                <div>
                  <span>日志</span>
                  <pre>{active.data.lastRun.logs.join('\n')}</pre>
                </div>
              )}
              {active.data.lastRun?.childRunId && <div className="wf-execution__child"><span>子运行</span><code><ExternalLink size={12} />{active.data.lastRun.childRunId}</code></div>}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

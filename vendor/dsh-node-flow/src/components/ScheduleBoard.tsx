/**
 * Scheduled-task board — lists every saved schedule (cron workflow). Lets the
 * user view the latest run result for the current workflow, run once
 * immediately, or cancel a schedule.
 *
 * @module components/ScheduleBoard
 */

import { useEffect, useState } from 'react'
import { useCanvasStore } from '../store/canvas.js'
import type { WorkflowDocument } from '../model.js'

type Schedule = {
  id: string
  name: string
  cron: string
  timezone?: string
  timezoneLabel?: string
  input?: unknown
  lastFired?: string
  nextFire?: string
  configurationError?: string
  doc?: WorkflowDocument
}

type RunNode = { id: string; kind: string; status: string; output?: unknown; logs?: string[]; error?: string; errorHandled?: boolean; ms: number }
type Run = { id: string; scheduleId?: string; name: string; status: string; failed: number; handledErrors?: number; value?: unknown; nodes: RunNode[] }

export function ScheduleBoard({
  workflowId,
  onClose,
  onViewRun,
}: {
  workflowId?: string
  onClose: () => void
  onViewRun?: () => void
}) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setErr('')
    try {
      const [sRes, rRes] = await Promise.all([
        fetch('/dsh-node-flow/schedules').then((r) => r.json().catch(() => ({}))),
        fetch('/dsh-node-flow/runs').then((r) => r.json().catch(() => ({}))),
      ])
      setSchedules((sRes as { schedules?: Schedule[] }).schedules ?? [])
      setRuns((rRes as { runs?: Run[] }).runs ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !loading) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [loading, onClose])

  const latestRun = (id: string): Run | undefined => runs.find((r) => r.scheduleId === id)
  const visibleSchedules = workflowId
    ? schedules.filter((schedule) => schedule.id.startsWith(`workflow:${workflowId}:`))
    : schedules

  const view = (s: Schedule): void => {
    const store = useCanvasStore.getState()
    const run = latestRun(s.id)
    if (!run) {
      setErr('该定时任务还没有运行结果。')
      return
    }
    const belongsToCurrent = workflowId
      ? s.id.startsWith(`workflow:${workflowId}:`)
      : s.doc?.name === store.workflowName
    if (!belongsToCurrent) {
      setErr('该定时任务属于其他工作流，请先从主页打开对应工作流。')
      return
    }
    const currentNodeIds = new Set(store.nodes.map((node) => node.id))
    const at = new Date().toLocaleTimeString()
    let applied = 0
    for (const node of store.nodes) store.updateNodeData(node.id, { lastRun: undefined })
    for (const n of run.nodes) {
      if (!currentNodeIds.has(n.id)) continue
      store.updateNodeData(n.id, {
        lastRun: { input: '', logs: n.logs ?? [], value: n.output, error: n.error, errorHandled: n.errorHandled, at, duration: n.ms },
      })
      applied += 1
    }
    if (applied === 0) {
      setErr('运行记录与当前工作流版本不匹配。')
      return
    }
    onClose()
    onViewRun?.()
  }

  const runOnce = async (s: Schedule): Promise<void> => {
    setLoading(true)
    setErr('')
    try {
      const res = await fetch('/dsh-node-flow/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'run', id: s.id }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) setErr(data.error ?? '运行失败')
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const cancel = async (s: Schedule): Promise<void> => {
    if (!window.confirm(`确定取消定时任务“${s.name}”吗？`)) return
    setLoading(true)
    setErr('')
    try {
      const res = await fetch('/dsh-node-flow/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'clear', id: s.id }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) setErr(data.error ?? '取消失败')
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="wf-schedule-board" role="dialog" aria-modal="true" aria-label="定时任务">
      <div className="wf-schedule-board__head">
        <div className="wf-schedule-board__title">定时任务</div>
        <button className="wf-schedule-board__close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      <div className="wf-schedule-board__body">
        <button className="wf-btn" onClick={() => void refresh()} disabled={loading}>
          ↻ 刷新
        </button>
        {err && <div className="wf-schedule-board__err">{err}</div>}
        {visibleSchedules.length === 0 && !loading && <div className="wf-schedule-board__empty">当前工作流还没有定时任务。添加 Schedule 节点并启用工作流后会显示在这里。</div>}
        {visibleSchedules.map((s) => {
          const run = latestRun(s.id)
          const completed = run?.status === 'ok' || run?.status === 'handled'
          const statusLabel = run?.status === 'ok'
            ? '成功'
            : run?.status === 'handled'
              ? '错误已处理'
              : run?.status === 'running'
                ? '运行中'
                : run?.status === 'cancelled'
                  ? '已取消'
                  : run?.status === 'interrupted'
                    ? '已中断'
                    : '失败'
          return (
            <div key={s.id} className="wf-schedule-board__item">
              <div className="wf-schedule-board__line">
                <span className="wf-schedule-board__name">{s.name}</span>
                <code className="wf-schedule-board__cron">{s.cron}</code>
              </div>
              <div className="wf-schedule-board__line wf-schedule-board__meta">
                <span>时区：{s.timezoneLabel ?? s.timezone ?? '系统时区'}</span>
                <span>下次触发：{s.nextFire ?? '—'}</span>
                <span>上次触发：{s.lastFired ?? '—'}</span>
                <span className={run && !completed ? 'wf-schedule-board__bad wf-schedule-board__bad--err' : 'wf-schedule-board__bad'}>
                  最近运行：{run ? `${statusLabel}${run.failed ? `（${run.failed} 失败）` : ''}${run.handledErrors ? `（${run.handledErrors} 已处理）` : ''}` : '—'}
                </span>
              </div>
              {s.configurationError && <div className="wf-schedule-board__err">计划配置无效：{s.configurationError}</div>}
              <div className="wf-schedule-board__actions">
                <button className="wf-btn" onClick={() => view(s)} disabled={!run}>
                  查看结果
                </button>
                <button className="wf-btn" onClick={() => void runOnce(s)} disabled={loading}>
                  运行一次
                </button>
                <button className="wf-btn wf-btn--danger" onClick={() => void cancel(s)} disabled={loading}>
                  取消
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

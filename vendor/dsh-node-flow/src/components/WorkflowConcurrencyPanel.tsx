import { useState } from 'react'
import { Gauge, Info, X } from 'lucide-react'
import type { WorkflowConcurrency, WorkflowConcurrencyMode, WorkflowExecutionLimits } from '../model.js'
import { normalizeWorkflowConcurrency, validateWorkflowConcurrency } from '../workflowConcurrencyProtocol.js'
import { MAX_WORKFLOW_DURATION_SECONDS, MAX_WORKFLOW_STEPS, validateWorkflowExecutionLimits } from '../workflowExecutionLimits.js'
import { useCanvasStore } from '../store/canvas.js'

const MODES: Array<{ value: WorkflowConcurrencyMode; label: string; description: string }> = [
  { value: 'parallel', label: '允许并行', description: '保持兼容行为：每次触发立即执行，不限制同时运行数量。' },
  { value: 'skip', label: '超过上限时跳过', description: '已有运行占满槽位时记录一次“已跳过”，不会重复执行外部副作用。' },
  { value: 'queue', label: '超过上限时排队', description: '按先到先服务持久排队；宿主重启后仍会继续，最多保留指定数量。' },
]

function numberText(value: number): string {
  return String(value)
}

export function WorkflowConcurrencyPanel({ onClose }: { onClose: () => void }) {
  const current = useCanvasStore((state) => state.workflowConcurrency)
  const currentLimits = useCanvasStore((state) => state.workflowExecutionLimits)
  const setWorkflowConcurrency = useCanvasStore((state) => state.setWorkflowConcurrency)
  const setWorkflowExecutionLimits = useCanvasStore((state) => state.setWorkflowExecutionLimits)
  const initial = normalizeWorkflowConcurrency(current)
  const [mode, setMode] = useState<WorkflowConcurrencyMode>(initial.mode)
  const [maxConcurrent, setMaxConcurrent] = useState(numberText(initial.maxConcurrent))
  const [maxQueue, setMaxQueue] = useState(numberText(initial.maxQueue))
  const [maxDurationSec, setMaxDurationSec] = useState(currentLimits?.maxDurationSec === undefined ? '' : String(currentLimits.maxDurationSec))
  const [maxSteps, setMaxSteps] = useState(currentLimits?.maxSteps === undefined ? '' : String(currentLimits.maxSteps))
  const [error, setError] = useState('')

  const optionalInteger = (value: string): number | undefined => value.trim() ? Number(value) : undefined

  const save = (): void => {
    const next: WorkflowConcurrency = {
      mode,
      maxConcurrent: Number(maxConcurrent),
      maxQueue: Number(maxQueue),
    }
    const nextLimits: WorkflowExecutionLimits | undefined = maxDurationSec.trim() || maxSteps.trim()
      ? { maxDurationSec: optionalInteger(maxDurationSec), maxSteps: optionalInteger(maxSteps) }
      : undefined
    try {
      validateWorkflowConcurrency(next)
      validateWorkflowExecutionLimits(nextLimits)
      setWorkflowConcurrency(mode === 'parallel' ? { mode: 'parallel' } : next)
      setWorkflowExecutionLimits(nextLimits)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div className="wf-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="wf-contract-panel wf-concurrency-panel" role="dialog" aria-modal="true" aria-label="工作流运行策略设置">
        <header className="wf-contract-panel__head">
          <div><span><Gauge size={18} /></span><div><strong>运行策略</strong><p>控制并发槽位，以及单次运行允许消耗的时间和步骤预算。</p></div></div>
          <button type="button" className="wf-icon-btn" onClick={onClose} aria-label="关闭运行策略设置"><X size={17} /></button>
        </header>
        <div className="wf-concurrency-panel__body">
          <fieldset>
            <legend>达到运行上限时</legend>
            <div className="wf-concurrency-modes">
              {MODES.map((option) => <label key={option.value} className={mode === option.value ? 'is-selected' : ''}>
                <input type="radio" name="workflow-concurrency-mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} />
                <span><strong>{option.label}</strong><small>{option.description}</small></span>
              </label>)}
            </div>
          </fieldset>
          {mode !== 'parallel' && <div className="wf-concurrency-numbers">
            <label><span>最大同时运行</span><input aria-label="最大同时运行" type="number" min="1" max="20" value={maxConcurrent} onChange={(event) => setMaxConcurrent(event.target.value)} /><small>1–20；Waitpoint 等待期间仍占一个槽位。</small></label>
            {mode === 'queue' && <label><span>最多排队运行</span><input aria-label="最多排队运行" type="number" min="0" max="100" value={maxQueue} onChange={(event) => setMaxQueue(event.target.value)} /><small>0–100；超出时记录“已跳过”，不会静默丢弃。</small></label>}
          </div>}
          <fieldset>
            <legend>单次运行预算（可选）</legend>
            <div className="wf-concurrency-numbers">
              <label><span>最长运行时间（秒）</span><input aria-label="最长运行时间" type="number" min="1" max={MAX_WORKFLOW_DURATION_SECONDS} value={maxDurationSec} onChange={(event) => setMaxDurationSec(event.target.value)} placeholder="不限" /><small>最多 {MAX_WORKFLOW_DURATION_SECONDS} 秒；超时会保留恢复点。</small></label>
              <label><span>最大执行步数</span><input aria-label="最大执行步数" type="number" min="1" max={MAX_WORKFLOW_STEPS} value={maxSteps} onChange={(event) => setMaxSteps(event.target.value)} placeholder="默认上限" /><small>最多 {MAX_WORKFLOW_STEPS} 次节点访问；包含循环迭代。</small></label>
            </div>
          </fieldset>
          <p className="wf-concurrency-note"><Info size={14} /> 配置随草稿保存；已启用的外部触发器使用最后一次发布的配置。排队运行保留提交时的流程快照和预算，超限后仍可从安全 checkpoint 恢复。</p>
          {error && <p className="wf-concurrency-error">{error}</p>}
        </div>
        <footer className="wf-contract-panel__foot"><button type="button" className="wf-dialog-btn" onClick={onClose}>取消</button><button type="button" className="wf-dialog-btn wf-dialog-btn--primary" onClick={save}>保存设置</button></footer>
      </section>
    </div>
  )
}

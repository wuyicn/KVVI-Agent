import { useMemo, useRef, useState } from 'react'
import { Brackets, Play, X } from 'lucide-react'
import type { WorkflowContractField } from '../model.js'
import { normalizeWorkflowContract } from '../subworkflowProtocol.js'
import { parseWorkflowContractInput, type WorkflowContractInputValues } from '../workflowInputProtocol.js'

function typeHint(field: WorkflowContractField): string {
  if (field.description) return field.description
  if (field.type === 'number') return '输入数字。'
  if (field.type === 'boolean') return '选择是或否。'
  if (field.type === 'object' || field.type === 'array') return '输入合法 JSON。'
  if (field.type === 'any') return '可输入文本或 JSON。'
  return '输入文本。'
}

export function WorkflowRunInputDialog({
  workflowName,
  fields: sourceFields,
  published = false,
  debug = false,
  onClose,
  onSubmit,
}: {
  workflowName: string
  fields: WorkflowContractField[]
  published?: boolean
  debug?: boolean
  onClose: () => void
  onSubmit: (input: Record<string, unknown>) => Promise<void> | void
}) {
  const fields = useMemo(() => normalizeWorkflowContract(sourceFields), [sourceFields])
  const [values, setValues] = useState<WorkflowContractInputValues>({})
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submitRef = useRef(false)

  const submit = async (): Promise<void> => {
    if (submitRef.current) return
    submitRef.current = true
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(parseWorkflowContractInput(fields, values))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      submitRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="wf-dialog-backdrop" role="presentation">
      <section className="wf-credential-dialog wf-run-input-dialog" role="dialog" aria-modal="true" aria-label={debug ? '调试工作流' : '运行工作流'}>
        <header>
          <div><Brackets size={17} /><strong>{debug ? '调试工作流' : '运行工作流'}</strong></div>
          <button className="wf-icon-button" type="button" disabled={submitting} onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="wf-credential-dialog__body">
          <div className="wf-run-input-dialog__summary"><strong>{workflowName}</strong><span>{debug ? '使用当前草稿，在断点处暂停' : published ? '使用已发布版本的输入契约' : '使用当前草稿的输入契约'}</span></div>
          {fields.map((field) => {
            const label = field.label || field.name
            const value = values[field.name] ?? ''
            const setValue = (next: string): void => setValues((current) => ({ ...current, [field.name]: next }))
            return (
              <label key={field.name} className="wf-run-input-field">
                <span>{label}{field.required && <b>必填</b>}<code>{field.type}</code></span>
                {field.type === 'boolean' ? (
                  <select aria-label={`运行输入 ${label}`} value={value} onChange={(event) => setValue(event.target.value)} disabled={submitting}>
                    <option value="">未设置</option>
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                ) : field.type === 'object' || field.type === 'array' || field.type === 'any' ? (
                  <textarea aria-label={`运行输入 ${label}`} rows={field.type === 'any' ? 3 : 5} value={value} onChange={(event) => setValue(event.target.value)} disabled={submitting} autoComplete="off" spellCheck={false} />
                ) : (
                  <input aria-label={`运行输入 ${label}`} type={field.type === 'number' ? 'number' : 'text'} inputMode={field.type === 'number' ? 'decimal' : undefined} value={value} onChange={(event) => setValue(event.target.value)} disabled={submitting} autoComplete="off" />
                )}
                <small>{typeHint(field)}</small>
              </label>
            )
          })}
          <p className="wf-run-input-dialog__note">输入只用于本次运行。认证信息请使用“连接”或项目 Secret，不要作为运行输入提交。</p>
          {error && <p className="wf-contract-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" disabled={submitting} onClick={onClose}>取消</button>
          <button type="button" className="wf-primary-command" disabled={submitting} onClick={() => { void submit() }}><Play size={14} fill="currentColor" />{submitting ? (debug ? '正在启动调试' : '正在运行') : (debug ? '开始调试' : '开始运行')}</button>
        </footer>
      </section>
    </div>
  )
}

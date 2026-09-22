import { useMemo, useRef, useState } from 'react'
import { Brackets, Plus, Trash2, X } from 'lucide-react'
import type { WorkflowContractField, WorkflowValueType } from '../model.js'
import { normalizeWorkflowContract } from '../subworkflowProtocol.js'
import { useCanvasStore } from '../store/canvas.js'

const VALUE_TYPES: Array<{ value: WorkflowValueType; label: string }> = [
  { value: 'any', label: '任意' },
  { value: 'string', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔值' },
  { value: 'object', label: '对象' },
  { value: 'array', label: '数组' },
]

function emptyField(): WorkflowContractField {
  return { name: '', type: 'string', required: false }
}

function ContractFields({
  title,
  description,
  fields,
  onChange,
}: {
  title: string
  description: string
  fields: WorkflowContractField[]
  onChange: (fields: WorkflowContractField[]) => void
}) {
  const update = (index: number, patch: Partial<WorkflowContractField>): void => {
    onChange(fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...patch } : field))
  }

  return (
    <section className="wf-contract-section">
      <header><div><strong>{title}</strong><p>{description}</p></div><button type="button" onClick={() => onChange([...fields, emptyField()])}><Plus size={14} />添加字段</button></header>
      {fields.length === 0 && <div className="wf-contract-empty">未声明字段时，将接受或返回任意值。</div>}
      <div className="wf-contract-fields">
        {fields.map((field, index) => (
          <article key={index} className="wf-contract-field">
            <div className="wf-contract-field__main">
              <label><span>字段名</span><input aria-label={`${title}字段名 ${index + 1}`} value={field.name} placeholder="例如 customerId" onChange={(event) => update(index, { name: event.target.value })} /></label>
              <label><span>显示名称</span><input aria-label={`${title}显示名称 ${index + 1}`} value={field.label ?? ''} placeholder="可选" onChange={(event) => update(index, { label: event.target.value })} /></label>
              <label><span>类型</span><select aria-label={`${title}字段类型 ${index + 1}`} value={field.type} onChange={(event) => update(index, { type: event.target.value as WorkflowValueType })}>{VALUE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label className="wf-contract-required"><input type="checkbox" checked={Boolean(field.required)} onChange={(event) => update(index, { required: event.target.checked })} /><span>必填</span></label>
              <button type="button" className="wf-contract-remove" onClick={() => onChange(fields.filter((_, fieldIndex) => fieldIndex !== index))} aria-label={`删除${title}字段 ${index + 1}`}><Trash2 size={15} /></button>
            </div>
            <input className="wf-contract-description" aria-label={`${title}字段说明 ${index + 1}`} value={field.description ?? ''} placeholder="字段说明（可选）" onChange={(event) => update(index, { description: event.target.value })} />
          </article>
        ))}
      </div>
    </section>
  )
}

export function WorkflowContractPanel({ onClose }: { onClose: () => void }) {
  const workflowInputs = useCanvasStore((state) => state.workflowInputs)
  const workflowOutputs = useCanvasStore((state) => state.workflowOutputs)
  const setWorkflowContract = useCanvasStore((state) => state.setWorkflowContract)
  const actionRef = useRef(false)
  const [inputs, setInputs] = useState(() => structuredClone(workflowInputs))
  const [outputs, setOutputs] = useState(() => structuredClone(workflowOutputs))
  const [error, setError] = useState('')
  const duplicateNames = useMemo(() => {
    const duplicates = (fields: WorkflowContractField[]): string[] => {
      const names = fields.map((field) => field.name.trim()).filter(Boolean)
      return names.filter((name, index) => names.indexOf(name) !== index)
    }
    return [...duplicates(inputs), ...duplicates(outputs)]
  }, [inputs, outputs])

  const save = (): void => {
    if (actionRef.current) return
    actionRef.current = true
    const invalid = [...inputs, ...outputs].find((field) => field.name.trim() && !/^[A-Za-z_$][\w$]*$/.test(field.name.trim()))
    if (invalid) {
      setError(`字段名“${invalid.name}”无效，只能使用字母、数字、下划线和 $，且不能以数字开头。`)
      actionRef.current = false
      return
    }
    if (duplicateNames.length > 0) {
      setError(`字段名“${duplicateNames[0]}”重复。`)
      actionRef.current = false
      return
    }
    setWorkflowContract(normalizeWorkflowContract(inputs), normalizeWorkflowContract(outputs))
    onClose()
  }

  return (
    <div className="wf-dialog-backdrop" role="presentation">
      <section className="wf-contract-dialog" role="dialog" aria-modal="true" aria-label="工作流输入输出契约">
        <header><span><Brackets size={18} /></span><div><strong>输入 / 输出契约</strong><p>声明供“调用工作流”节点校验和映射的结构化字段。</p></div><button className="wf-icon-btn" onClick={onClose} aria-label="关闭输入输出契约"><X size={17} /></button></header>
        <div className="wf-contract-dialog__body">
          <ContractFields title="输入" description="父工作流调用时传入的 JSON 对象。" fields={inputs} onChange={setInputs} />
          <ContractFields title="输出" description="本工作流最终结果应满足的 JSON 对象。" fields={outputs} onChange={setOutputs} />
          {error && <p className="wf-contract-error" role="alert">{error}</p>}
        </div>
        <footer><button className="wf-dialog-btn" onClick={onClose}>取消</button><button className="wf-dialog-btn wf-dialog-btn--primary" onClick={save}>保存契约</button></footer>
      </section>
    </div>
  )
}

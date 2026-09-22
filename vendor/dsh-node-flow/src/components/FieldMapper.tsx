import { useEffect, useMemo, useState } from 'react'
import { Braces, Search, X } from 'lucide-react'
import { parseResultValue, resultPathExpression } from '../resultExpression.js'

export type FieldMappingMode = 'template' | 'expression'

export type FieldMappingSource = {
  id: string
  label: string
  detail: string
  value: unknown
  namespace?: 'result' | 'vars'
}

type FieldEntry = {
  path: Array<string | number>
  expression: string
  type: string
  preview: string
  depth: number
}

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

function previewValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length > 70 ? `${value.slice(0, 67)}…` : value
  if (typeof value === 'object') {
    const text = JSON.stringify(value)
    return text.length > 70 ? `${text.slice(0, 67)}…` : text
  }
  return String(value)
}

function pathExpression(namespace: 'result' | 'vars', path: Array<string | number>): string {
  let expression = namespace
  for (const key of path) {
    if (typeof key === 'number') expression += `[${key}]`
    else if (/^[A-Za-z_$][\w$]*$/.test(key)) expression += `.${key}`
    else expression += `[${JSON.stringify(key)}]`
  }
  return expression
}

function flattenValue(value: unknown, namespace: 'result' | 'vars'): FieldEntry[] {
  const parsed = parseResultValue(value)
  const entries: FieldEntry[] = []
  const seen = new WeakSet<object>()
  const visit = (current: unknown, path: Array<string | number>, depth: number): void => {
    if (entries.length >= 200 || depth > 6) return
    if (namespace === 'result' || path.length > 0) entries.push({ path, expression: namespace === 'result' ? resultPathExpression(path) : pathExpression(namespace, path), type: valueType(current), preview: previewValue(current), depth })
    if (!current || typeof current !== 'object') return
    if (seen.has(current)) return
    seen.add(current)
    const children = Array.isArray(current)
      ? current.slice(0, 20).map((child, index) => [index, child] as const)
      : Object.entries(current).slice(0, 100)
    for (const [key, child] of children) visit(child, [...path, key], depth + 1)
  }
  visit(parsed, [], 0)
  return entries
}

export function FieldMapper({
  targetLabel,
  mode,
  sources,
  onInsert,
  onClose,
}: {
  targetLabel: string
  mode: FieldMappingMode
  sources: FieldMappingSource[]
  onInsert: (text: string) => void
  onClose: () => void
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!sources.some((source) => source.id === sourceId)) setSourceId(sources[0]?.id ?? '')
  }, [sourceId, sources])

  const source = sources.find((candidate) => candidate.id === sourceId) ?? sources[0]
  const fields = useMemo(() => source ? flattenValue(source.value, source.namespace ?? 'result') : [], [source])
  const normalizedQuery = query.trim().toLowerCase()
  const visibleFields = normalizedQuery
    ? fields.filter((field) => `${field.expression} ${field.type} ${field.preview}`.toLowerCase().includes(normalizedQuery))
    : fields

  return (
    <div className="wf-mapper" aria-label="字段映射器">
      <header className="wf-mapper__head">
        <div><Braces size={17} /><span><strong>字段映射</strong><small>插入到「{targetLabel}」</small></span></div>
        <button type="button" className="wf-icon-btn" onClick={onClose} aria-label="关闭字段映射器"><X size={16} /></button>
      </header>
      <div className="wf-mapper__body">
        <label className="wf-field">
          <span>样本来源</span>
          <select value={source?.id ?? ''} onChange={(event) => setSourceId(event.target.value)} disabled={sources.length === 0}>
            {sources.length === 0 && <option value="">暂无样本</option>}
            {sources.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
          </select>
        </label>
        {source && <p className="wf-mapper__source-note">{source.detail}</p>}
        <label className="wf-mapper__search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索字段名或值" />
        </label>
        <p className="wf-mapper__hint">{source?.namespace === 'vars' ? <>运行时从主机变量库读取 <code>vars</code>；Secret 仅显示占位符，不会发送到浏览器。</> : <>运行时读取当前节点收到的 <code>result</code>；这里的历史输出只用于预览结构。</>}</p>
        {visibleFields.length > 0 ? (
          <div className="wf-mapper__fields">
            {visibleFields.map((field) => {
              const text = mode === 'template' ? `{{${field.expression}}}` : field.expression
              return (
                <button key={field.expression} type="button" className="wf-mapper-field" draggable onDragStart={(event) => { event.dataTransfer.setData('text/plain', text); event.dataTransfer.effectAllowed = 'copy' }} onClick={() => onInsert(text)} title={`点击或拖拽插入 ${text}`}>
                  <span className="wf-mapper-field__path" style={{ paddingLeft: `${field.depth * 12}px` }}>{field.expression}</span>
                  <small>{field.type}</small>
                  <em>{field.preview}</em>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="wf-mapper__empty"><Braces size={22} /><strong>还没有结构化样本</strong><span>先测试上游节点，运行一次工作流，或在“测试输入”中粘贴 JSON。</span></div>
        )}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Braces, Clipboard, Eye, EyeOff, KeyRound, Loader2, LockKeyhole, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { ProjectVariableKind, ProjectVariableReference, ProjectVariableSummary } from '../model.js'

type VariableRecord = ProjectVariableSummary & { references?: ProjectVariableReference[] }

type VariableForm = {
  id?: string
  name: string
  kind: ProjectVariableKind
  description: string
  value: string
  updatedAt?: string
}

const EMPTY_FORM: VariableForm = { name: '', kind: 'plain', description: '', value: '' }

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function referenceLabel(references: ProjectVariableReference[]): string {
  if (references.length === 0) return '未被工作流引用'
  const workflows = new Set(references.map((reference) => reference.workflowId)).size
  return `${workflows} 个工作流 · ${references.length} 处引用`
}

export function ProjectVariablesPanel() {
  const [variables, setVariables] = useState<VariableRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<VariableForm | null>(null)
  const [showSecret, setShowSecret] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const actionLock = useRef(false)

  const load = useCallback(async (showLoading = true): Promise<void> => {
    if (showLoading) setLoading(true)
    try {
      const response = await fetch('/dsh-node-flow/project-variables', { cache: 'no-store' })
      const data = await response.json() as { variables?: VariableRecord[]; error?: string }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      setVariables(Array.isArray(data.variables) ? data.variables : [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!form) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !actionLock.current) setForm(null)
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [form])

  const save = async (): Promise<void> => {
    if (!form || actionLock.current) return
    actionLock.current = true
    setBusy('save')
    setError('')
    try {
      const response = await fetch('/dsh-node-flow/project-variables', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          expectedUpdatedAt: form.updatedAt,
          variable: { id: form.id, name: form.name, kind: form.kind, description: form.description, value: form.value || undefined },
        }),
      })
      const data = await response.json() as { variable?: VariableRecord; error?: string }
      if (!response.ok || !data.variable) throw new Error(data.error || `HTTP ${response.status}`)
      setForm(null)
      setShowSecret(false)
      await load(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      actionLock.current = false
      setBusy('')
    }
  }

  const remove = async (variable: VariableRecord): Promise<void> => {
    if (actionLock.current) return
    const references = variable.references ?? []
    if (references.length > 0) {
      setError(`变量 ${variable.name} 仍被 ${references.length} 个节点引用，先更新草稿和发布版本后再删除。`)
      return
    }
    if (!window.confirm(`删除变量 ${variable.name}？此操作无法撤销。`)) return
    actionLock.current = true
    setBusy(`delete:${variable.id}`)
    setError('')
    try {
      const response = await fetch('/dsh-node-flow/project-variables', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: variable.id, expectedUpdatedAt: variable.updatedAt }),
      })
      const data = await response.json() as { error?: string }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      await load(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      await load(false)
    } finally {
      actionLock.current = false
      setBusy('')
    }
  }

  return (
    <>
      <header className="wf-page-header">
        <div><h1>项目变量</h1><p>集中管理流程配置与 Secret，工作流只保存 <code>{'{{vars.NAME}}'}</code> 引用。</p></div>
        <div className="wf-page-header__actions"><button className="wf-primary-command" onClick={() => { setError(''); setShowSecret(false); setForm({ ...EMPTY_FORM }) }}><Plus size={16} />新建变量</button></div>
      </header>
      {error && <div className="wf-credential-error" role="alert">{error}</div>}
      {loading && <div className="wf-dashboard-empty"><Loader2 className="wf-spin" size={24} /><strong>正在加载项目变量</strong></div>}
      {!loading && variables.length === 0 && <div className="wf-dashboard-empty"><Braces size={27} /><strong>暂无项目变量</strong><p>保存环境地址、开关或 Secret，在节点模板中通过 vars 引用。</p></div>}
      {!loading && variables.length > 0 && <div className="wf-variable-list">
        {variables.map((variable) => {
          const references = variable.references ?? []
          const token = `{{vars.${variable.name}}}`
          return <article key={variable.id}>
            <span className={`wf-variable-list__icon is-${variable.kind}`}>{variable.kind === 'secret' ? <LockKeyhole size={17} /> : <Braces size={17} />}</span>
            <div className="wf-variable-list__main"><strong>{variable.name}</strong><code>{token}</code><small>{variable.description || (variable.kind === 'secret' ? '加密 Secret' : variable.value || '普通变量')}</small></div>
            <span className={`wf-variable-kind is-${variable.kind}`}>{variable.kind === 'secret' ? <KeyRound size={12} /> : <Eye size={12} />}{variable.kind === 'secret' ? 'Secret' : '普通值'}</span>
            <span className="wf-variable-references" title={references.map((reference) => `${reference.workflowName} / ${reference.nodeLabel} / ${reference.scope === 'published' ? '发布版' : '草稿'}`).join('\n')}>{referenceLabel(references)}</span>
            <time>{formatDate(variable.updatedAt)}</time>
            <div className="wf-credential-actions">
              <button className="wf-icon-button" title="复制引用" aria-label={`复制 ${variable.name} 引用`} onClick={() => void navigator.clipboard.writeText(token)}><Clipboard size={14} /></button>
              <button className="wf-icon-button" title="编辑" aria-label={`编辑 ${variable.name}`} onClick={() => { setError(''); setShowSecret(false); setForm({ id: variable.id, name: variable.name, kind: variable.kind, description: variable.description || '', value: variable.kind === 'plain' ? variable.value || '' : '', updatedAt: variable.updatedAt }) }}><Pencil size={14} /></button>
              <button className="wf-icon-button is-danger" disabled={Boolean(busy) || references.length > 0} title={references.length ? '仍被工作流引用' : '删除'} aria-label={`删除 ${variable.name}`} onClick={() => void remove(variable)}>{busy === `delete:${variable.id}` ? <Loader2 className="wf-spin" size={14} /> : <Trash2 size={14} />}</button>
            </div>
          </article>
        })}
      </div>}
      {form && <div className="wf-dialog-backdrop" role="presentation"><section className="wf-credential-dialog" role="dialog" aria-modal="true" aria-label={form.id ? '编辑项目变量' : '新建项目变量'}>
        <header><div><Braces size={17} /><strong>{form.id ? '编辑项目变量' : '新建项目变量'}</strong></div><button className="wf-icon-button" aria-label="关闭" onClick={() => setForm(null)}><X size={17} /></button></header>
        <div className="wf-credential-dialog__body">
          <label><span>变量名</span><input autoFocus={!form.id} readOnly={Boolean(form.id)} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} placeholder="API_HOST" maxLength={64} /><small>大写字母开头，仅允许大写字母、数字和下划线；保存后不可重命名。</small></label>
          <label><span>类型</span><select disabled={Boolean(form.id)} value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as ProjectVariableKind, value: '' })}><option value="plain">普通值</option><option value="secret">Secret</option></select></label>
          <label><span>说明</span><input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="可选，说明变量用途" maxLength={200} /></label>
          <label><span>值</span><div className="wf-variable-secret-input"><input aria-label="变量值" type={form.kind === 'secret' && !showSecret ? 'password' : 'text'} autoComplete="new-password" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} placeholder={form.id ? '留空则保持不变' : form.kind === 'secret' ? '至少 8 个字符' : ''} />{form.kind === 'secret' && <button type="button" aria-label={showSecret ? '隐藏 Secret' : '显示 Secret'} onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeOff size={15} /> : <Eye size={15} />}</button>}</div><small>{form.kind === 'secret' ? '值在 DSH 主机使用 AES-256-GCM 加密，列表和 API 永不回传。' : '普通值会显示在变量列表中。'}</small></label>
          {form.name && <label><span>引用语法</span><div className="wf-credential-copy"><input readOnly value={`{{vars.${form.name}}}`} /><button type="button" onClick={() => void navigator.clipboard.writeText(`{{vars.${form.name}}}`)}>复制</button></div></label>}
        </div>
        <footer><button disabled={Boolean(busy)} onClick={() => setForm(null)}>取消</button><button className="wf-primary-command" disabled={Boolean(busy) || !form.name.trim() || (!form.id && !form.value)} onClick={() => void save()}>{busy === 'save' ? <Loader2 className="wf-spin" size={15} /> : <Braces size={15} />}{busy === 'save' ? '保存中' : '保存变量'}</button></footer>
      </section></div>}
    </>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { Braces, CloudSun, GitBranch, LayoutTemplate, Loader2, Newspaper, Plus, X } from 'lucide-react'
import {
  buildBasicIfExample,
  buildLoopExample,
  buildNewsExample,
  buildWeatherExample,
  createBlankWorkflowDocument,
  type WorkflowDocument,
  type WorkflowFolder,
} from '../model.js'

type Template = {
  id: string
  name: string
  description: string
  icon: typeof Plus
  build: () => WorkflowDocument
}

const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: '空白工作流',
    description: '从手动触发器开始构建',
    icon: Plus,
    build: () => createBlankWorkflowDocument(),
  },
  {
    id: 'weather',
    name: 'AI 天气播报',
    description: '抓取天气并交给 Agent 整理',
    icon: CloudSun,
    build: buildWeatherExample,
  },
  {
    id: 'news',
    name: '定时新闻摘要',
    description: '按计划收集并总结新闻',
    icon: Newspaper,
    build: buildNewsExample,
  },
  {
    id: 'branch',
    name: '条件分流',
    description: '用 If 节点路由不同结果',
    icon: GitBranch,
    build: buildBasicIfExample,
  },
  {
    id: 'loop',
    name: '循环处理',
    description: '遍历数组并收集执行结果',
    icon: Braces,
    build: buildLoopExample,
  },
]

export function CreateWorkflowDialog({
  onClose,
  onCreate,
  folders = [],
  initialFolderId,
}: {
  onClose: () => void
  onCreate: (name: string, document: WorkflowDocument, folderId?: string) => void | Promise<void>
  folders?: WorkflowFolder[]
  initialFolderId?: string
}) {
  const [selectedId, setSelectedId] = useState('blank')
  const [name, setName] = useState('未命名工作流')
  const [folderId, setFolderId] = useState(initialFolderId ?? '')
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const selected = useMemo(() => TEMPLATES.find((template) => template.id === selectedId) ?? TEMPLATES[0], [selectedId])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !creatingRef.current) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  useEffect(() => {
    if (!folderId || folders.some((folder) => folder.id === folderId)) return
    setFolderId('')
  }, [folderId, folders])

  return (
    <div className="wf-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (!creatingRef.current && event.target === event.currentTarget) onClose()
    }}>
      <section className="wf-create-dialog" role="dialog" aria-modal="true" aria-label="创建工作流">
        <header>
          <div>
            <strong>创建工作流</strong>
            <span>选择一个起点，稍后可以自由修改。</span>
          </div>
          <button className="wf-icon-btn" onClick={onClose} disabled={creating} aria-label="关闭创建窗口" title="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="wf-create-dialog__body">
          <label className="wf-create-dialog__name">
            <span>工作流名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="wf-create-dialog__name">
            <span>文件夹</span>
            <select aria-label="新工作流文件夹" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
              <option value="">未分类</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
          <div className="wf-create-dialog__section-title"><LayoutTemplate size={14} /> 选择模板</div>
          <div className="wf-template-grid">
            {TEMPLATES.map((template) => {
              const Icon = template.icon
              return (
                <button
                  type="button"
                  key={template.id}
                  className={selectedId === template.id ? 'is-selected' : ''}
                  onClick={() => {
                    setSelectedId(template.id)
                    if (name === '未命名工作流' || TEMPLATES.some((candidate) => candidate.name === name)) setName(template.name)
                  }}
                >
                  <span><Icon size={19} /></span>
                  <strong>{template.name}</strong>
                  <small>{template.description}</small>
                </button>
              )
            })}
          </div>
        </div>
        <footer>
          <button className="wf-dialog-btn" onClick={onClose} disabled={creating}>取消</button>
          <button
            className="wf-dialog-btn wf-dialog-btn--primary"
            disabled={!name.trim() || creating}
            onClick={async () => {
              if (creatingRef.current) return
              creatingRef.current = true
              setCreating(true)
              const document = selected.build()
              try {
                await onCreate(name.trim(), { ...document, name: name.trim() }, folderId || undefined)
              } finally {
                creatingRef.current = false
                setCreating(false)
              }
            }}
          >
            {creating && <Loader2 className="wf-spin" size={15} />}
            {creating ? '正在创建' : '创建并打开'}
          </button>
        </footer>
      </section>
    </div>
  )
}

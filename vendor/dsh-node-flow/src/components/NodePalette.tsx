/**
 * Left-side node palette drawer. List node types grouped by category; drag an
 * item onto the canvas to place it there (or click to add at a random spot).
 * Also hosts the example workflows.
 *
 * @module components/NodePalette
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { LayoutTemplate, Search, Workflow, X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.js'
import type { WorkflowNodeType } from '../model.js'
import { buildWeatherExample, buildNewsExample, buildBasicIfExample, buildQaIfExample, buildDailySwitchExample, buildLoopExample, buildWhileExample } from '../model.js'
import { NODE_CATALOG, NodeGlyph } from './nodeCatalog.js'

const EXAMPLES = [
  { label: '天气', load: buildWeatherExample },
  { label: '定时新闻', load: buildNewsExample },
  { label: 'If 分流', load: buildBasicIfExample },
  { label: 'AI 问答', load: buildQaIfExample },
  { label: 'Switch 时段', load: buildDailySwitchExample },
  { label: 'Loop 数组', load: buildLoopExample },
  { label: 'While 计数', load: buildWhileExample },
]

type PaletteTab = 'nodes' | 'templates'

export function NodePalette({
  onClose,
  onAdd,
  initialTab = 'nodes',
  insertMode = false,
}: {
  onClose?: () => void
  onAdd?: (kind: WorkflowNodeType, label: string) => void
  initialTab?: PaletteTab
  insertMode?: boolean
}) {
  const addNodeAt = useCanvasStore((s) => s.addNodeAt)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<PaletteTab>(initialTab)
  const searchRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = useMemo(
    () => NODE_CATALOG.filter((item) => (
      (!insertMode || !['trigger', 'webhook', 'schedule', 'connector-trigger', 'note'].includes(item.kind))
      && (!normalizedQuery
        || `${item.label} ${item.description} ${item.keywords}`.toLocaleLowerCase().includes(normalizedQuery))
    )),
    [insertMode, normalizedQuery],
  )
  const groups = useMemo(
    () => ['触发器', '执行', '流程控制', '辅助'].map((group) => ({
      group,
      items: matches.filter((item) => item.group === group),
    })).filter((group) => group.items.length > 0),
    [matches],
  )

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const add = (kind: WorkflowNodeType, label: string): void => {
    if (onAdd) onAdd(kind, label)
    else addNodeAt(kind, label, { x: 160 + Math.random() * 240, y: 120 + Math.random() * 240 })
    onClose?.()
  }

  return (
    <aside className="wf-palette" aria-label="节点库">
      <header className="wf-palette__header">
        <div>
          <strong>添加步骤</strong>
          <span>选择一个节点加入当前工作流</span>
        </div>
        {onClose && (
          <button className="wf-icon-btn" onClick={onClose} title="关闭节点库" aria-label="关闭节点库">
            <X size={17} />
          </button>
        )}
      </header>
      <div className={`wf-palette__tabs${insertMode ? ' is-single' : ''}`} role="tablist" aria-label="节点库视图">
        <button className={tab === 'nodes' ? 'is-active' : ''} onClick={() => setTab('nodes')} role="tab" aria-selected={tab === 'nodes'}>
          <Workflow size={15} /> 节点
        </button>
        {!insertMode && <button className={tab === 'templates' ? 'is-active' : ''} onClick={() => setTab('templates')} role="tab" aria-selected={tab === 'templates'}>
          <LayoutTemplate size={15} /> 模板
        </button>}
      </div>
      {tab === 'nodes' && (
        <label className="wf-palette__search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点或功能"
            aria-label="搜索节点"
          />
          {query && (
            <button onClick={() => setQuery('')} title="清空搜索" aria-label="清空搜索" type="button">
              <X size={14} />
            </button>
          )}
        </label>
      )}
      <div className="wf-palette__body">
        {tab === 'nodes' && groups.map((g) => (
          <div key={g.group} className="wf-palette__group">
            <div className="wf-palette__group-title">{g.group}</div>
            {g.items.map((it) => (
              <button
                type="button"
                key={it.kind}
                className="wf-palette__item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/reactflow', it.kind)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onClick={() => add(it.kind, it.label)}
              >
                <NodeGlyph kind={it.kind} size={34} iconSize={17} />
                <span className="wf-palette__copy">
                  <strong>{it.label}</strong>
                  <span>{it.description}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
        {tab === 'nodes' && groups.length === 0 && (
          <div className="wf-palette__empty">没有匹配的节点</div>
        )}
        {tab === 'templates' && <div className="wf-palette__group wf-palette__templates">
          <div className="wf-palette__group-title">工作流模板</div>
          {EXAMPLES.map((x) => (
            <button
              type="button"
              key={x.label}
              className="wf-palette__item wf-palette__template"
              onClick={() => {
                if (!window.confirm(`载入“${x.label}”将替换当前画布。确定继续吗？`)) return
                useCanvasStore.getState().importDocument(x.load())
                onClose?.()
              }}
            >
              <span className="wf-template-icon"><LayoutTemplate size={16} /></span>
              <span className="wf-palette__copy">
                <strong>{x.label}</strong>
                <span>替换当前画布并载入示例</span>
              </span>
            </button>
          ))}
        </div>}
      </div>
      <div className="wf-palette__hint">点击添加，或拖动到画布中的指定位置</div>
    </aside>
  )
}

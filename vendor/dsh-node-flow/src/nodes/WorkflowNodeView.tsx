/**
 * A single workflow node card rendered on the canvas.
 *
 * Most nodes render as a rounded square (icon on top, label + summary below);
 * the agent node stays a wider rounded rectangle. After a run, the node's
 * outer border turns green (success) or red (failure) — no checkmark — and an
 * amber border shows while running. The node's elapsed time appears in the
 * top-left corner, its run time in the bottom-right.
 *
 * IF and SWITCH nodes render extra source handles so the flow can branch:
 * IF → "true" / "false"; SWITCH → one per configured case, plus "default".
 *
 * @module nodes/WorkflowNodeView
 */

import { Handle, Position, type NodeProps } from '@xyflow/react'
import { AlertCircle, Bug, CheckCircle2, Loader2 } from 'lucide-react'
import type { WorkflowNode, WorkflowNodeType } from '../model.js'
import { NODE_SIZE } from '../model.js'
import { NODE_META, NodeGlyph } from '../components/nodeCatalog.js'

const KIND_TAGS: Record<WorkflowNodeType, string> = {
  trigger: 'TRIGGER',
  webhook: 'WEBHOOK',
  schedule: 'SCHEDULE',
  'connector-trigger': 'APP TRIGGER',
  agent: 'AGENT',
  'call-workflow': 'WORKFLOW',
  connector: 'APP',
  'data-store': 'DATA STORE',
  wait: 'WAIT',
  if: 'IF',
  switch: 'SWITCH',
  loop: 'LOOP',
  while: 'WHILE',
  code: 'CODE',
  http: 'HTTP',
  output: 'OUTPUT',
  note: 'NOTE',
}

const HANDLE = 'wf-handle wf-handle--branch'

function nodeSummary(data: WorkflowNode['data']): string {
  if (data.kind === 'trigger') return data.text || '等待手动输入'
  if (data.kind === 'webhook') return `${data.httpMethod || 'ANY'} · ${data.credentialId ? 'HMAC 验签' : 'token 鉴权'}`
  if (data.kind === 'schedule') return data.cron || '尚未设置 Cron'
  if (data.kind === 'connector-trigger') return data.connectorId ? `${data.connectorId}${data.connectorVersion ? ` v${data.connectorVersion}` : ''} · ${data.connectorTrigger || '选择事件'}` : '选择应用与事件'
  if (data.kind === 'agent') return data.prompt || '配置 Agent 任务'
  if (data.kind === 'call-workflow') return data.workflowId ? '执行已发布工作流' : '尚未选择工作流'
  if (data.kind === 'connector') return data.connectorId ? `${data.connectorId}${data.connectorVersion ? ` v${data.connectorVersion}` : ''} · ${data.connectorAction || '选择动作'}` : '选择应用与动作'
  if (data.kind === 'data-store') return `${data.storeOperation || 'get'} · ${data.storeNamespace || '默认空间'}`
  if (data.kind === 'wait') {
    if (data.waitMode === 'callback') return data.waitTimeout ? `等待回调 · ${data.waitTimeout} 小时` : '等待外部回调'
    if (data.waitMode === 'approval') return data.waitTimeout ? `等待审批 · ${data.waitTimeout} 小时` : '等待人工审批'
    const units = data.waitUnit === 'seconds' ? '秒' : data.waitUnit === 'hours' ? '小时' : data.waitUnit === 'days' ? '天' : '分钟'
    return `延迟 ${data.waitAmount || 0} ${units}`
  }
  if (data.kind === 'code') return data.language === 'python' ? 'Python' : 'TypeScript'
  if (data.kind === 'http') return `${data.httpMethod || 'GET'} ${data.url || '尚未设置 URL'}`
  if (data.kind === 'output') return data.template || '{{result}}'
  if (data.kind === 'if' || data.kind === 'while') return data.condition || '尚未设置条件'
  if (data.kind === 'switch') return data.cases || '尚未设置匹配值'
  if (data.kind === 'loop') return data.mode === 'count' ? `重复 ${data.count || 0} 次` : data.itemsExpr || '遍历输入数组'
  return data.notes || '仅用于画布说明'
}

export function WorkflowNodeView({ data, selected }: NodeProps<WorkflowNode>) {
  const meta = NODE_META[data.kind]
  const runState = data.lastRun
    ? data.lastRun.running
      ? 'running'
      : data.lastRun.debugPaused
        ? 'debug'
      : data.lastRun.waiting
        ? 'waiting'
      : data.lastRun.error
        ? 'error'
        : 'ok'
    : ''

  // Branch source handles for IF / SWITCH (stacked on the right edge).
  const branches: Array<{ id: string; label: string; top: string }> = []
  // Loop / While re-entry targets (stacked on the left edge).
  const targets: Array<{ id: string; label: string; top: string }> = []
  if (data.kind === 'if') {
    branches.push(
      { id: 'true', label: 'true', top: '32%' },
      { id: 'false', label: 'false', top: '68%' },
    )
  } else if (data.kind === 'switch') {
    const cases = (data.cases ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const n = Math.max(cases.length, 1)
    cases.forEach((c, i) => branches.push({ id: c, label: c, top: `${28 + i * ((58 - 10) / n)}%` }))
    branches.push({ id: 'default', label: 'default', top: '88%' })
  } else if (data.kind === 'loop' || data.kind === 'while') {
    branches.push(
      { id: 'iterate', label: 'iterate', top: '32%' },
      { id: 'done', label: 'done', top: '68%' },
    )
    targets.push(
      { id: 'in', label: 'in', top: '32%' },
      { id: 'back', label: 'back', top: '68%' },
    )
  }
  const isBranch = data.kind === 'if' || data.kind === 'switch' || data.kind === 'loop' || data.kind === 'while'
  const isLoop = data.kind === 'loop' || data.kind === 'while'
  const canRouteError = ['agent', 'code', 'http', 'connector', 'data-store', 'call-workflow'].includes(data.kind)
  const hasErrorRoute = canRouteError && data.onError === 'route'

  const cls = [
    'wf-node',
    `wf-node--${data.kind}`,
    selected ? 'wf-node--selected' : '',
    runState ? `wf-node--${runState}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  const size = NODE_SIZE[data.kind]

  return (
    <div
      className={cls}
      style={{
        ['--kind' as string]: meta.color,
        width: size.width,
        height: size.height,
      }}
    >
      {data.kind === 'note' ? (
        <div className="wf-node__note">
          <NodeGlyph kind="note" size={30} iconSize={15} />
          <div>
            <strong>{data.label}</strong>
            <div className="wf-node__note-text">{data.text || '点选编辑这个备注'}</div>
          </div>
        </div>
      ) : (
        <>
          <div className="wf-node__main">
            <NodeGlyph kind={data.kind} size={36} iconSize={18} />
            <div className="wf-node__content">
              <span className="wf-node__tag">{KIND_TAGS[data.kind]}</span>
              <div className="wf-node__label">{data.label}</div>
              <div className="wf-node__summary">{nodeSummary(data)}</div>
            </div>
            {runState && (
              <span className={`wf-node__status wf-node__status--${runState}`} title={data.lastRun?.error || `${data.lastRun?.duration ?? 0} ms`}>
                {runState === 'running' ? <Loader2 className="wf-spin" size={15} /> : runState === 'debug' ? <Bug size={15} /> : runState === 'error' ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}
              </span>
            )}
            {data.breakpoint && <span className="wf-node__breakpoint" title="调试断点"><Bug size={12} /></span>}
          </div>
          {isLoop ? (
            targets.map((t) => (
              <Handle key={`h-${t.id}`} type="target" position={Position.Left} id={t.id} style={{ top: t.top }} className="wf-handle" />
            ))
          ) : data.kind !== 'connector-trigger' ? (
            <Handle type="target" position={Position.Left} className="wf-handle" />
          ) : null}
          {!isBranch && <Handle type="source" position={Position.Right} id="success" style={hasErrorRoute ? { top: '32%' } : undefined} className="wf-handle" />}
          {hasErrorRoute && <Handle type="source" position={Position.Right} id="error" style={{ top: '72%' }} className="wf-handle wf-handle--error" />}
          {branches.map((b) => (
            <Handle key={`h-${b.id}`} type="source" position={Position.Right} id={b.id} style={{ top: b.top }} className={HANDLE} />
          ))}
          {branches.map((b) => (
            <span key={`l-${b.id}`} className="wf-node__branch-label" style={{ top: b.top }}>
              {b.label}
            </span>
          ))}
          {targets.map((t) => (
            <span key={`tl-${t.id}`} className="wf-node__branch-label wf-node__branch-label--left" style={{ top: t.top }}>
              {t.label}
            </span>
          ))}
          {hasErrorRoute && <span className="wf-node__branch-label wf-node__branch-label--error" style={{ top: '72%' }}>error</span>}
        </>
      )}
    </div>
  )
}

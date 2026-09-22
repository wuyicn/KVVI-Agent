/**
 * Inspector panel for the selected node — edits kind-specific fields.
 *
 * @module components/Inspector
 */

import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { Activity, Braces, Check, Copy, Loader2, Play, RotateCw, Settings2, Trash2, X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.js'
import { CodeEditor } from './CodeEditor.js'
import { CodeEditorModal } from './CodeEditorModal.js'
import expandArrowsIcon from '../assets/icons/expand-arrows-alt.svg'
import { createWebhookToken, type CredentialSummary, type ProjectVariableSummary, type SavedWorkflow, type WorkflowNodeData, type WorkflowRunNode, type WorkflowRunRecord } from '../model.js'
import { NodeGlyph } from './nodeCatalog.js'
import { FieldMapper, type FieldMappingMode, type FieldMappingSource } from './FieldMapper.js'
import { readWorkflowSamples, saveWorkflowNodeSample } from '../sampleStore.js'
import { listSavedWorkflows, listWorkflowRuns } from '../workflowRepository.js'
import type { ConnectorCatalogFieldDefinition, ConnectorCatalogItem } from '../connectorSdk.js'

type AgentModel = { provider: string; id: string; name: string }
type PollingTriggerSummary = { id: string; initialized: boolean; nextPollAt: string; lastPolledAt?: string; lastEventAt?: string; lastError?: string; active: boolean }

function formatPollingTime(value?: string): string {
  if (!value) return '暂无'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '暂无' : date.toLocaleString()
}

/** Short deterministic hash so one schedule node can host several cron times. */
function hashCron(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

const KIND_LABELS: Record<WorkflowNodeData['kind'], string> = {
  trigger: 'Trigger',
  webhook: 'Webhook',
  schedule: 'Schedule',
  'connector-trigger': 'App Trigger',
  agent: 'Sub-agent',
  'call-workflow': 'Call Workflow',
  connector: 'App Connector',
  'data-store': 'Data Store',
  wait: 'Wait',
  if: 'If',
  switch: 'Switch',
  loop: 'Loop',
  while: 'While',
  code: 'Code',
  http: 'HTTP Request',
  output: 'Output',
  note: 'Note',
}

function RetryFields({ data, onChange }: { data: WorkflowNodeData; onChange: (patch: Partial<WorkflowNodeData>) => void }) {
  return (
    <fieldset className="wf-retry-fields">
      <legend>失败重试</legend>
      <div className="wf-field-row">
        <label className="wf-field"><span>重试次数</span><input type="number" min="0" max="10" value={data.retryCount ?? '0'} onChange={(event) => onChange({ retryCount: event.target.value })} /></label>
        <label className="wf-field"><span>间隔（秒）</span><input type="number" min="0" step="0.5" value={data.retryDelay ?? '1'} onChange={(event) => onChange({ retryDelay: event.target.value })} /></label>
      </div>
      <label className="wf-field"><span>退避策略</span><select value={data.retryBackoff ?? 'fixed'} onChange={(event) => onChange({ retryBackoff: event.target.value })}><option value="fixed">固定间隔</option><option value="exponential">指数退避</option></select></label>
      <p className="wf-field-note">重试次数不含首次执行；指数退避会按 1×、2×、4× 增加等待时间。</p>
    </fieldset>
  )
}

function FailureBehaviorField({ data, inactiveErrorEdges = false, missingErrorRoute = false, onChange }: { data: WorkflowNodeData; inactiveErrorEdges?: boolean; missingErrorRoute?: boolean; onChange: (patch: Partial<WorkflowNodeData>) => void }) {
  return (
    <label className="wf-field">
      <span>失败时行为</span>
      <select value={data.onError ?? 'stop'} onChange={(event) => onChange({ onError: event.target.value as WorkflowNodeData['onError'] })}>
        <option value="stop">停止分支</option>
        <option value="continue">继续用空值</option>
        <option value="route">路由到错误分支</option>
      </select>
      {data.onError === 'route' && <small className="wf-field-hint">从节点右侧红色 <code>error</code> 端口连到处理节点。下游收到脱敏的错误事件，不包含输入、密钥或响应体。</small>}
      {missingErrorRoute && <small className="wf-field-hint is-error">还没有连接红色 <code>error</code> 端口；运行或发布会被拒绝。</small>}
      {inactiveErrorEdges && <small className="wf-field-hint is-error">该节点保留了 error 连线，但当前策略不会执行它；切换回“路由到错误分支”后才会启用。</small>}
    </label>
  )
}

type MappingTarget = {
  label: string
  mode: FieldMappingMode
  insert: (text: string) => void
}

function MappedField({
  label,
  value,
  onChange,
  onOpenMapper,
  mode,
  multiline = false,
  rows = 3,
  placeholder,
  required = false,
  list,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  onOpenMapper: (target: MappingTarget) => void
  mode: FieldMappingMode
  multiline?: boolean
  rows?: number
  placeholder?: string
  required?: boolean
  list?: string
}) {
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const valueRef = useRef(value)
  const selectionRef = useRef({ start: value.length, end: value.length })
  valueRef.current = value

  const rememberSelection = (): void => {
    const field = fieldRef.current
    if (!field || document.activeElement !== field) return
    selectionRef.current = {
      start: field.selectionStart ?? valueRef.current.length,
      end: field.selectionEnd ?? valueRef.current.length,
    }
  }

  const insert = (text: string): void => {
    const current = valueRef.current
    const start = Math.min(selectionRef.current.start, current.length)
    const end = Math.min(selectionRef.current.end, current.length)
    const next = `${current.slice(0, start)}${text}${current.slice(end)}`
    const caret = start + text.length
    valueRef.current = next
    selectionRef.current = { start: caret, end: caret }
    onChange(next)
    window.requestAnimationFrame(() => {
      fieldRef.current?.focus()
      fieldRef.current?.setSelectionRange(caret, caret)
    })
  }

  const shared = {
    'aria-label': label,
    value,
    placeholder,
    required,
    list,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      valueRef.current = event.target.value
      selectionRef.current = {
        start: event.target.selectionStart ?? event.target.value.length,
        end: event.target.selectionEnd ?? event.target.value.length,
      }
      onChange(event.target.value)
    },
    onSelect: rememberSelection,
    onKeyUp: rememberSelection,
    onClick: rememberSelection,
    onDragOver: (event: DragEvent<HTMLInputElement | HTMLTextAreaElement>) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' },
    onDrop: (event: DragEvent<HTMLInputElement | HTMLTextAreaElement>) => { event.preventDefault(); insert(event.dataTransfer.getData('text/plain')) },
  }

  return (
    <div className="wf-field wf-field--mapped">
      <span className="wf-field__mapped-title">
        <span>{label}{required ? ' *' : ''}</span>
        <button type="button" aria-label={`映射${label}字段`} onClick={() => { rememberSelection(); onOpenMapper({ label, mode, insert }) }} title="从样本数据插入字段"><Braces size={13} /> 映射</button>
      </span>
      {multiline ? <textarea ref={(element) => { fieldRef.current = element }} {...shared} rows={rows} /> : <input ref={(element) => { fieldRef.current = element }} {...shared} />}
    </div>
  )
}

type DynamicConnectorOptions = { options: Array<{ value: string; label: string }>; loading?: boolean; error?: string }

function ConnectorParameterField({
  field,
  value,
  mapped,
  dynamic,
  dynamicKey,
  onChange,
  onLoadOptions,
  onOpenMapper,
}: {
  field: ConnectorCatalogFieldDefinition
  value: string
  mapped: boolean
  dynamic?: DynamicConnectorOptions
  dynamicKey: string
  onChange: (value: string) => void
  onLoadOptions: () => void
  onOpenMapper: (target: MappingTarget) => void
}) {
  if (field.type === 'boolean') return <label className="wf-field wf-field--checkbox"><input aria-label={field.label} type="checkbox" checked={['true', '1', 'yes', 'on'].includes(value.toLowerCase())} onChange={(event) => onChange(String(event.target.checked))} /><span>{field.label}</span></label>
  if (field.type === 'select' && !field.dynamicOptions) return <label className="wf-field"><span>{field.label}{field.required ? ' *' : ''}</span><select aria-label={field.label} value={value} onChange={(event) => onChange(event.target.value)}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{field.description && <small className="wf-field-hint">{field.description}</small>}</label>
  const listId = field.dynamicOptions ? `wf-connector-options-${dynamicKey.replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined
  return <div className="wf-connector-parameter">
    {mapped
      ? <MappedField label={field.label} required={field.required} multiline={field.type === 'textarea' || field.type === 'json'} rows={field.type === 'json' ? 5 : 3} mode="template" placeholder={field.placeholder} value={value} list={listId} onChange={onChange} onOpenMapper={onOpenMapper} />
      : <label className="wf-field"><span>{field.label}{field.required ? ' *' : ''}</span>{field.type === 'textarea' || field.type === 'json' ? <textarea aria-label={field.label} rows={field.type === 'json' ? 5 : 3} placeholder={field.placeholder} value={value} onChange={(event) => onChange(event.target.value)} /> : <input aria-label={field.label} list={listId} type={field.type === 'number' ? 'number' : 'text'} min={field.min} max={field.max} placeholder={field.placeholder} value={value} onChange={(event) => onChange(event.target.value)} />}</label>}
    {listId && <datalist id={listId}>{dynamic?.options.map((option) => <option key={option.value} value={option.value} label={option.label} />)}</datalist>}
    {field.dynamicOptions && <div className="wf-connector-options"><button type="button" aria-label={`加载${field.label}选项`} disabled={dynamic?.loading} onClick={onLoadOptions}>{dynamic?.loading ? <Loader2 className="wf-spin" size={12} /> : <RotateCw size={12} />}{dynamic?.loading ? '加载中' : dynamic?.options.length ? '刷新选项' : '加载选项'}</button>{dynamic?.options.length ? <small>{dynamic.options.length} 个可用选项</small> : null}{dynamic?.error && <small className="is-error">{dynamic.error}</small>}</div>}
    {field.description && <small className="wf-field-hint">{field.description}</small>}
  </div>
}

export function Inspector({ workflowId }: { workflowId?: string }) {
  const selectedId = useCanvasStore((s) => s.selectedId)
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === s.selectedId))
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const removeNode = useCanvasStore((s) => s.removeNode)
  const select = useCanvasStore((s) => s.select)
  const [codeExpanded, setCodeExpanded] = useState(false)
  const [agentModels, setAgentModels] = useState<AgentModel[]>([])
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [projectVariables, setProjectVariables] = useState<ProjectVariableSummary[]>([])
  const [connectors, setConnectors] = useState<ConnectorCatalogItem[]>([])
  const [activeTab, setActiveTab] = useState<'config' | 'output'>('config')
  const [testInput, setTestInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunRecord[]>([])
  const [availableWorkflows, setAvailableWorkflows] = useState<SavedWorkflow[]>([])
  const [, setSampleRevision] = useState(0)
  const [mappingTarget, setMappingTarget] = useState<MappingTarget | null>(null)
  const [pollingTrigger, setPollingTrigger] = useState<PollingTriggerSummary | null>(null)
  const [pollingBusy, setPollingBusy] = useState(false)
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, DynamicConnectorOptions>>({})

  // Load the available model routes once (for the agent-node model dropdown).
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/dsh-node-flow/models', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        const data = (await res.json().catch(() => ({}))) as { models?: AgentModel[] }
        if (!cancelled) setAgentModels(Array.isArray(data.models) ? data.models : [])
      } catch {
        if (!cancelled) setAgentModels([])
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetch('/dsh-node-flow/connectors', { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() as Promise<{ connectors?: ConnectorCatalogItem[] }> : { connectors: [] })
      .then((data) => { if (!cancelled) setConnectors(Array.isArray(data.connectors) ? data.connectors : []) })
      .catch(() => { if (!cancelled) setConnectors([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetch('/dsh-node-flow/credentials', { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() as Promise<{ credentials?: CredentialSummary[] }> : { credentials: [] })
      .then((data) => { if (!cancelled) setCredentials(Array.isArray(data.credentials) ? data.credentials : []) })
      .catch(() => { if (!cancelled) setCredentials([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetch('/dsh-node-flow/project-variables', { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() as Promise<{ variables?: ProjectVariableSummary[] }> : { variables: [] })
      .then((data) => { if (!cancelled) setProjectVariables(Array.isArray(data.variables) ? data.variables : []) })
      .catch(() => { if (!cancelled) setProjectVariables([]) })
    return () => { cancelled = true }
  }, [])

  useLayoutEffect(() => {
    setActiveTab('config')
    setTestInput('')
    setCopied(false)
    setMappingTarget(null)
    setDynamicOptions({})
  }, [selectedId])

  useEffect(() => {
    let cancelled = false
    void Promise.all([listWorkflowRuns(), listSavedWorkflows()])
      .then(([runs, workflows]) => {
        if (cancelled) return
        setWorkflowRuns(runs)
        setAvailableWorkflows(workflows)
      })
      .catch(() => {
        if (cancelled) return
        setWorkflowRuns([])
        setAvailableWorkflows([])
      })
    return () => { cancelled = true }
  }, [workflowId])

  const pollingId = workflowId && node?.data.kind === 'connector-trigger' ? `workflow:${workflowId}:${node.id}` : undefined
  useEffect(() => {
    setPollingTrigger(null)
    if (!pollingId) return
    let cancelled = false
    const load = (): void => {
      void fetch('/dsh-node-flow/polling-triggers', { cache: 'no-store' })
        .then(async (response) => response.ok ? response.json() as Promise<{ triggers?: PollingTriggerSummary[] }> : { triggers: [] })
        .then((data) => {
          if (!cancelled) setPollingTrigger((data.triggers ?? []).find((trigger) => trigger.id === pollingId) ?? null)
        })
        .catch(() => { if (!cancelled) setPollingTrigger(null) })
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [pollingId])

  if (!node) {
    return (
      <aside className="wf-inspector wf-inspector--empty">
        <p>Select a node to configure it.</p>
      </aside>
    )
  }
  const d = node.data
  const errorEdges = edges.filter((edge) => edge.source === node.id && edge.sourceHandle === 'error')
  const inactiveErrorEdges = d.onError !== 'route' && errorEdges.length > 0
  const missingErrorRoute = d.onError === 'route' && errorEdges.length === 0
  const connectorVersions = connectors.filter((connector) => connector.id === d.connectorId).sort((left, right) => right.version - left.version)
  const selectedConnector = d.connectorVersion === undefined ? connectorVersions[0] : connectorVersions.find((connector) => connector.version === d.connectorVersion)
  const latestConnector = connectorVersions[0]
  const latestConnectors = connectors.filter((connector, index, values) => !values.some((candidate, candidateIndex) => candidateIndex !== index && candidate.id === connector.id && candidate.version > connector.version))
  const selectedConnectorAction = selectedConnector?.actions.find((action) => action.id === d.connectorAction)
  const selectedConnectorTrigger = selectedConnector?.triggers?.find((trigger) => trigger.id === d.connectorTrigger)
  const connectorCredentialCompatible = (connector: ConnectorCatalogItem, credential: CredentialSummary): boolean => connector.credentialKinds.includes(credential.kind)
    && (credential.kind !== 'api-key' || !connector.credentialHeaderName || credential.headerName?.toLowerCase() === connector.credentialHeaderName.toLowerCase())
  const defaultConnectorParams = (fields: ConnectorCatalogFieldDefinition[]): Record<string, string> => Object.fromEntries(fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.id, field.defaultValue!]))
  const compatibleConnectorParams = (fields: ConnectorCatalogFieldDefinition[]): Record<string, string> => Object.fromEntries(fields.flatMap((field) => Object.prototype.hasOwnProperty.call(d.connectorParams ?? {}, field.id) ? [[field.id, d.connectorParams?.[field.id] ?? '']] : field.defaultValue !== undefined ? [[field.id, field.defaultValue]] : []))
  const setConnectorParam = (fieldId: string, value: string): void => updateNodeData(node.id, { connectorParams: { ...(d.connectorParams ?? {}), [fieldId]: value }, lastRun: undefined })
  const dynamicOptionsKey = (field: ConnectorCatalogFieldDefinition): string => `${node.id}:${d.connectorId ?? ''}@${d.connectorVersion ?? 'latest'}:${d.connectorAction ?? d.connectorTrigger ?? ''}:${d.credentialId ?? ''}:${field.id}:${JSON.stringify((field.dynamicOptions?.dependsOn ?? []).map((id) => d.connectorParams?.[id] ?? ''))}`
  const loadDynamicOptions = async (fieldId: string, stateKey: string): Promise<void> => {
    const current = useCanvasStore.getState().nodes.find((candidate) => candidate.id === node.id)
    if (!current || dynamicOptions[stateKey]?.loading) return
    setDynamicOptions((state) => ({ ...state, [stateKey]: { options: state[stateKey]?.options ?? [], loading: true } }))
    try {
      const response = await fetch('/dsh-node-flow/connectors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node: { ...current, data: { ...current.data, lastRun: undefined } }, fieldId }) })
      const data = await response.json().catch(() => ({})) as { options?: Array<{ value: string; label: string }>; error?: string }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      setDynamicOptions((state) => ({ ...state, [stateKey]: { options: Array.isArray(data.options) ? data.options : [] } }))
    } catch (error) {
      setDynamicOptions((state) => ({ ...state, [stateKey]: { options: state[stateKey]?.options ?? [], error: error instanceof Error ? error.message : String(error) } }))
    }
  }
  const pollNow = async (): Promise<void> => {
    if (!pollingId || pollingBusy) return
    setPollingBusy(true)
    try {
      const response = await fetch('/dsh-node-flow/polling-triggers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'poll', id: pollingId }),
      })
      const data = await response.json().catch(() => ({})) as { trigger?: PollingTriggerSummary; error?: string }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      setPollingTrigger(data.trigger ?? null)
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error))
    } finally {
      setPollingBusy(false)
    }
  }
  const upstreamNodeIds = (() => {
    const ordered: string[] = []
    const seen = new Set<string>([node.id])
    let frontier = edges.filter((edge) => edge.target === node.id).map((edge) => edge.source)
    while (frontier.length > 0) {
      const next: string[] = []
      for (const id of frontier) {
        if (seen.has(id)) continue
        seen.add(id)
        ordered.push(id)
        for (const edge of edges) if (edge.target === id) next.push(edge.source)
      }
      frontier = next
    }
    return ordered
  })()
  const mappingSources = (() : FieldMappingSource[] => {
    const sources: FieldMappingSource[] = []
    if (projectVariables.length > 0) {
      sources.push({
        id: 'project-variables',
        label: '项目变量',
        detail: '普通变量显示当前值；Secret 只显示名称和占位符，实际值仅在 DSH 主机运行时解析。',
        namespace: 'vars',
        value: Object.fromEntries(projectVariables.map((variable) => [variable.name, variable.kind === 'secret' ? '[secret]' : variable.value ?? ''])),
      })
    }
    const samples = readWorkflowSamples(workflowId ?? 'standalone')
    if (testInput.trim()) sources.push({ id: 'test-input', label: '当前测试输入', detail: '正在编辑的测试输入，适合先粘贴一份 JSON 样本再映射。', value: testInput })
    if (d.lastRun?.input !== undefined && d.lastRun.input !== '') {
      sources.push({ id: 'latest-input', label: '当前节点最近输入', detail: `当前节点最近一次执行收到的输入 · ${d.lastRun.at}`, value: d.lastRun.input })
    }
    const currentSample = samples[node.id]
    if (currentSample?.input !== undefined && currentSample.input !== '') {
      sources.push({ id: `sample-input:${node.id}`, label: '当前节点 · 已保存输入', detail: `保存在本机的节点测试输入 · ${new Date(currentSample.at).toLocaleString()}`, value: currentSample.input })
    }
    const currentHistory = workflowRuns
      .filter((run) => !workflowId || run.workflowId === workflowId)
      .flatMap((run) => run.nodes.filter((runNode) => runNode.id === node.id && runNode.input !== undefined).map((runNode) => ({ run, runNode })))
      .slice(0, 3)
    for (const { run, runNode } of currentHistory) {
      sources.push({ id: `run-input:${run.id}:${node.id}`, label: `${d.label} · 历史输入`, detail: `${new Date(run.startedAt).toLocaleString()} · ${run.status}`, value: runNode.input })
    }
    for (const upstreamId of upstreamNodeIds) {
      const upstream = nodes.find((candidate) => candidate.id === upstreamId)
      if (!upstream) continue
      if (upstream.data.lastRun?.value !== undefined) {
        sources.push({ id: `live:${upstreamId}`, label: `${upstream.data.label} · 当前会话`, detail: `画布中最近一次运行输出 · ${upstream.data.lastRun.at}`, value: upstream.data.lastRun.value })
      }
      const cached = samples[upstreamId]
      if (cached?.output !== undefined) {
        sources.push({ id: `sample:${upstreamId}`, label: `${upstream.data.label} · 测试样本`, detail: `保存在本机的节点测试输出 · ${new Date(cached.at).toLocaleString()}`, value: cached.output })
      }
      const historical = workflowRuns
        .filter((run) => !workflowId || run.workflowId === workflowId)
        .flatMap((run) => run.nodes.filter((runNode) => runNode.id === upstreamId && runNode.output !== undefined).map((runNode) => ({ run, runNode })))
        .slice(0, 3)
      for (const { run, runNode } of historical) {
        sources.push({ id: `run:${run.id}:${upstreamId}`, label: `${upstream.data.label} · 历史运行`, detail: `${new Date(run.startedAt).toLocaleString()} · ${run.status}`, value: runNode.output })
      }
    }
    return sources
  })()

  const testNode = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    const startedAt = performance.now()
    updateNodeData(node.id, { lastRun: { input: testInput, logs: [], at: new Date().toLocaleTimeString(), running: true } })
    try {
      const current = useCanvasStore.getState().nodes.find((candidate) => candidate.id === node.id)
      if (!current) throw new Error('节点不存在')
      const response = await fetch('/dsh-node-flow/node-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ node: { ...current, data: { ...current.data, lastRun: undefined } }, input: testInput, workflowId }),
      })
      const data = await response.json() as { node?: WorkflowRunNode; error?: string }
      const result = data.node
      updateNodeData(node.id, {
        lastRun: {
          input: testInput,
          logs: result?.logs ?? [],
          value: result?.output,
          error: result?.error || (!response.ok ? data.error || `HTTP ${response.status}` : undefined),
          attempts: result?.attempts,
          childRunId: result?.childRunId,
          at: new Date().toLocaleTimeString(),
          duration: result?.ms ?? Math.round(performance.now() - startedAt),
        },
      })
      saveWorkflowNodeSample(workflowId ?? 'standalone', node.id, { input: testInput, output: result?.output, at: new Date().toISOString() })
      setSampleRevision((revision) => revision + 1)
    } catch (error) {
      updateNodeData(node.id, { lastRun: { input: testInput, logs: [], error: error instanceof Error ? error.message : String(error), at: new Date().toLocaleTimeString(), duration: Math.round(performance.now() - startedAt) } })
    } finally {
      setTesting(false)
      setActiveTab('output')
    }
  }

  const webhookUrl = d.kind === 'webhook' && d.webhookToken
    ? `${window.location.origin}/dsh-node-flow/webhook?token=${encodeURIComponent(d.webhookToken)}`
    : ''

  const copyWebhookUrl = async (): Promise<void> => {
    let success = false
    try {
      await navigator.clipboard.writeText(webhookUrl)
      success = true
    } catch {
      const field = document.createElement('textarea')
      field.value = webhookUrl
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      success = document.execCommand('copy')
      field.remove()
    }
    if (success) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  const saveSchedule = async (): Promise<void> => {
    if (!d.cron?.trim()) {
      alert('请先填写 Cron 表达式（例如 30 7 * * *）')
      return
    }
    try {
      const store = useCanvasStore.getState()
      const steps = store.toSteps()
      const doc = store.exportDocument()
      const res = await fetch('/dsh-node-flow/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: workflowId ? `workflow:${workflowId}:${node.id}` : `wf-${node.id}-${hashCron(d.cron)}`,
          workflowId,
          name: doc.name || 'scheduled workflow',
          cron: d.cron,
          timezone: d.timezone?.trim() || undefined,
          input: d.text ?? '',
          steps,
          doc,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) alert(data.error ?? '保存计划失败')
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <aside className="wf-inspector">
      <header className="wf-inspector__head">
        <NodeGlyph kind={d.kind} size={34} iconSize={17} />
        <div>
          <strong>{d.label}</strong>
          <span>{KIND_LABELS[d.kind]}</span>
        </div>
        <button className="wf-icon-btn wf-icon-btn--danger" onClick={() => removeNode(node.id)} title="删除节点" aria-label="删除节点">
          <Trash2 size={16} />
        </button>
        <button className="wf-icon-btn" onClick={() => select(null)} title="关闭检查器" aria-label="关闭检查器">
          <X size={17} />
        </button>
      </header>

      <div className="wf-inspector__tabs" role="tablist" aria-label="节点详情">
        <button className={activeTab === 'config' ? 'is-active' : ''} onClick={() => setActiveTab('config')} role="tab" aria-selected={activeTab === 'config'}>
          <Settings2 size={15} /> 配置
        </button>
        <button className={activeTab === 'output' ? 'is-active' : ''} onClick={() => setActiveTab('output')} role="tab" aria-selected={activeTab === 'output'}>
          <Activity size={15} /> 输出
          {d.lastRun && <span className={`wf-tab-dot${d.lastRun.error ? ' is-error' : ''}`} />}
        </button>
      </div>

      {activeTab === 'config' && <div className="wf-inspector__pane">

      <label className="wf-field">
        <span>节点名称</span>
        <input
          value={d.label}
          onChange={(e) => updateNodeData(node.id, { label: e.target.value })}
        />
      </label>

      {['agent', 'call-workflow', 'connector', 'data-store', 'code', 'http', 'output'].includes(d.kind) && (
        <label className="wf-field wf-field--checkbox">
          <input aria-label="调试断点" type="checkbox" checked={Boolean(d.breakpoint)} onChange={(event) => updateNodeData(node.id, { breakpoint: event.target.checked, lastRun: undefined })} />
          <span>调试断点</span>
          <small className="wf-field-hint">手动调试时在此节点执行前暂停。调试 v1 只支持单入口、线性路径。</small>
        </label>
      )}

      {d.kind === 'note' && (
        <label className="wf-field">
          <span>备注</span>
          <textarea
            rows={5}
            placeholder="这个备注不会参与执行，只做说明"
            value={d.text ?? ''}
            onChange={(e) => updateNodeData(node.id, { text: e.target.value })}
          />
        </label>
      )}

      {d.kind === 'trigger' && (
        <label className="wf-field">
          <span>Trigger text</span>
          <textarea
            rows={4}
            placeholder="输入要交给 agent 的任务文字（会传到下游 agent）"
            value={d.text ?? ''}
            onChange={(e) => updateNodeData(node.id, { text: e.target.value })}
          />
        </label>
      )}

      {d.kind === 'webhook' && (
        <>
          <label className="wf-field">
            <span>允许的方法</span>
            <select value={d.httpMethod ?? 'ANY'} onChange={(event) => updateNodeData(node.id, { httpMethod: event.target.value })}>
              {['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => <option key={method}>{method}</option>)}
            </select>
          </label>
          <label className="wf-field">
            <span>生产 URL</span>
            <div className="wf-copy-field wf-copy-field--webhook">
              <input readOnly value={webhookUrl} />
              <button type="button" onClick={() => void copyWebhookUrl()} aria-label="复制 Webhook URL" title="复制 URL">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
              <button type="button" onClick={() => { if (window.confirm('重新生成后，旧 Webhook URL 将在下次发布时失效。确定继续吗？')) updateNodeData(node.id, { webhookToken: createWebhookToken() }) }} aria-label="重新生成 Webhook token" title="重新生成 token"><RotateCw size={15} /></button>
            </div>
          </label>
          <fieldset className="wf-webhook-settings">
            <legend>签名验证</legend>
            <label className="wf-field">
              <span>Webhook Secret</span>
              <select value={d.credentialId ?? ''} onChange={(event) => updateNodeData(node.id, { credentialId: event.target.value || undefined })}>
                <option value="">不校验签名</option>
                {credentials.filter((credential) => credential.kind === 'webhook-secret').map((credential) => <option key={credential.id} value={credential.id}>{credential.name}</option>)}
              </select>
            </label>
            {d.credentialId && <label className="wf-field"><span>签名 Header</span><input value={d.webhookSignatureHeader ?? 'x-dsh-signature-256'} onChange={(event) => updateNodeData(node.id, { webhookSignatureHeader: event.target.value })} /><small className="wf-field-hint">支持 <code>sha256=&lt;hex&gt;</code>、纯 hex 或 base64 签名。</small></label>}
          </fieldset>
          <fieldset className="wf-webhook-settings">
            <legend>成功响应</legend>
            <label className="wf-field"><span>响应模式</span><select value={d.webhookResponseMode ?? 'summary'} onChange={(event) => updateNodeData(node.id, { webhookResponseMode: event.target.value })}><option value="summary">运行摘要 JSON</option><option value="output">直接返回工作流输出</option><option value="custom">自定义响应</option></select></label>
            {d.webhookResponseMode === 'custom' && <>
              <label className="wf-field"><span>状态码</span><input type="number" min="200" max="599" value={d.webhookResponseStatus ?? '200'} onChange={(event) => updateNodeData(node.id, { webhookResponseStatus: event.target.value })} /></label>
              <MappedField label="响应 Headers JSON" multiline rows={3} mode="template" placeholder={'{"content-type":"application/json","x-item-id":"{{result.id}}"}'} value={d.webhookResponseHeaders ?? ''} onChange={(value) => updateNodeData(node.id, { webhookResponseHeaders: value })} onOpenMapper={setMappingTarget} />
              <MappedField label="响应 Body" multiline rows={4} mode="template" placeholder={'{"ok":true,"value":{{result}}}'} value={d.webhookResponseBody ?? '{{result}}'} onChange={(value) => updateNodeData(node.id, { webhookResponseBody: value })} onOpenMapper={setMappingTarget} />
            </>}
          </fieldset>
          <fieldset className="wf-webhook-settings">
            <legend>重复投递</legend>
            <label className="wf-field"><span>幂等键 Header（可选）</span><input aria-label="幂等键 Header" value={d.webhookIdempotencyHeader ?? ''} placeholder="例如 Idempotency-Key" onChange={(event) => updateNodeData(node.id, { webhookIdempotencyHeader: event.target.value || undefined })} /><small className="wf-field-hint">发送方重试时使用同一个值；相同请求会直接复用第一次响应。</small></label>
            {d.webhookIdempotencyHeader && <label className="wf-field"><span>幂等记录保留（秒）</span><input aria-label="幂等记录保留" type="number" min="60" max={7 * 24 * 60 * 60} value={d.webhookIdempotencyTtl ?? '86400'} onChange={(event) => updateNodeData(node.id, { webhookIdempotencyTtl: event.target.value })} /><small className="wf-field-hint">范围 60 秒到 7 天；完成响应会加密保存在主机。</small></label>}
          </fieldset>
          <p className="wf-field-note">仅已启用工作流接收请求；签名和响应配置使用最后一次发布的快照。</p>
        </>
      )}

      {d.kind === 'schedule' && (
        <>
          <label className="wf-field">
            <span>任务文字（可选）</span>
            <textarea
              rows={2}
              placeholder="这条定时任务的触发内容（可选）"
              value={d.text ?? ''}
              onChange={(e) => updateNodeData(node.id, { text: e.target.value })}
            />
          </label>
          <div className="wf-trigger-schedule">
            <label className="wf-field">
              <span>定时 Cron (5段)</span>
              <input
                placeholder="30 7 * * *  (分 时 日 月 周)"
                value={d.cron ?? ''}
                onChange={(e) => updateNodeData(node.id, { cron: e.target.value })}
              />
            </label>
            <label className="wf-field">
              <span>时区</span>
              <input
                placeholder="Asia/Shanghai（留空=系统时区）"
                value={d.timezone ?? ''}
                onChange={(e) => updateNodeData(node.id, { timezone: e.target.value })}
                spellCheck={false}
              />
            </label>
            <p className="wf-field-note">仅接受 5 段 Cron 和 IANA 时区。夏令时回拨时，同一个本地分钟只会触发一次。</p>
            <div className="wf-trigger-schedule__actions">
              <button className="wf-btn wf-btn--primary" onClick={() => void saveSchedule()}>
                保存定时
              </button>
            </div>
          </div>
        </>
      )}

      {d.kind === 'wait' && (
        <>
          <label className="wf-field">
            <span>等待方式</span>
            <select value={d.waitMode ?? 'delay'} onChange={(event) => updateNodeData(node.id, { waitMode: event.target.value, lastRun: undefined })}>
              <option value="delay">延迟一段时间</option>
              <option value="callback">等待外部回调</option>
              <option value="approval">等待人工审批</option>
            </select>
          </label>
          {(d.waitMode ?? 'delay') === 'delay' ? (
            <div className="wf-field-row">
              <label className="wf-field"><span>等待时长</span><input type="number" min="0.001" step="0.1" value={d.waitAmount ?? '5'} onChange={(event) => updateNodeData(node.id, { waitAmount: event.target.value, lastRun: undefined })} /></label>
              <label className="wf-field"><span>单位</span><select value={d.waitUnit ?? 'minutes'} onChange={(event) => updateNodeData(node.id, { waitUnit: event.target.value, lastRun: undefined })}><option value="seconds">秒</option><option value="minutes">分钟</option><option value="hours">小时</option><option value="days">天</option></select></label>
            </div>
          ) : (
            <>
              <label className="wf-field"><span>超时（小时，可选）</span><input type="number" min="0.001" max="8760" step="0.1" value={d.waitTimeout ?? ''} onChange={(event) => updateNodeData(node.id, { waitTimeout: event.target.value, lastRun: undefined })} /></label>
              {d.waitTimeout?.trim() && <MappedField label="超时输出" multiline rows={3} mode="template" placeholder={'{"timedOut":true}'} value={d.waitTimeoutValue ?? '{"timedOut":true}'} onChange={(value) => updateNodeData(node.id, { waitTimeoutValue: value, lastRun: undefined })} onOpenMapper={setMappingTarget} />}
            </>
          )}
          <p className="wf-field-note">等待会持久保存运行快照并释放执行资源；恢复后从此节点的下游继续。</p>
        </>
      )}

      {d.kind === 'agent' && (
        <>
          <label className="wf-field">
            <span>模型</span>
            <select value={d.model ?? ''} onChange={(e) => updateNodeData(node.id, { model: e.target.value })}>
              <option value="">官方默认（继承）</option>
              {agentModels.map((m) => (
                <option key={`${m.provider}|${m.id}`} value={`${m.provider}|${m.id}`}>
                  {m.name}（{m.provider}）
                </option>
              ))}
            </select>
          </label>
          <MappedField label="system prompt" multiline rows={3} mode="template" value={d.prompt ?? ''} onChange={(value) => updateNodeData(node.id, { prompt: value })} onOpenMapper={setMappingTarget} />
          <label className="wf-field">
            <span>运行超时（秒，留空=不限制）</span>
            <input
              placeholder="例如 60"
              value={d.timeout ?? ''}
              onChange={(e) => updateNodeData(node.id, { timeout: e.target.value })}
            />
          </label>
          <FailureBehaviorField data={d} inactiveErrorEdges={inactiveErrorEdges} missingErrorRoute={missingErrorRoute} onChange={(patch) => updateNodeData(node.id, patch)} />
          <RetryFields data={d} onChange={(patch) => updateNodeData(node.id, patch)} />
        </>
      )}

      {d.kind === 'call-workflow' && (() => {
        const target = availableWorkflows.find((workflow) => workflow.id === d.workflowId)
        const choices = availableWorkflows.filter((workflow) => workflow.id !== workflowId && workflow.status === 'enabled' && workflow.publishedDoc)
        return (
          <>
            <label className="wf-field">
              <span>目标工作流</span>
              <select value={d.workflowId ?? ''} onChange={(event) => updateNodeData(node.id, { workflowId: event.target.value || undefined, lastRun: undefined })}>
                <option value="">选择已发布工作流</option>
                {choices.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name} · 发布 v{workflow.publishedRevision}</option>)}
              </select>
              {d.workflowId && !target && <small className="wf-field-hint is-error">目标工作流不存在。</small>}
              {target && (target.status !== 'enabled' || !target.publishedDoc) && <small className="wf-field-hint is-error">目标工作流未启用或没有发布快照。</small>}
            </label>
            {target?.publishedDoc?.inputs && target.publishedDoc.inputs.length > 0 && <div className="wf-subworkflow-contract"><strong>目标输入</strong>{target.publishedDoc.inputs.map((field) => <span key={field.name}><code>{field.name}</code>{field.label ? ` · ${field.label}` : ''}<small>{field.type}{field.required ? ' · 必填' : ''}</small></span>)}</div>}
            <MappedField label="输入映射" multiline rows={5} mode="template" placeholder={'{"customerId":{{result.id}}}'} value={d.inputTemplate ?? '{{result}}'} onChange={(value) => updateNodeData(node.id, { inputTemplate: value, lastRun: undefined })} onOpenMapper={setMappingTarget} />
            {target?.publishedDoc?.outputs && target.publishedDoc.outputs.length > 0 && <div className="wf-subworkflow-contract"><strong>目标输出</strong>{target.publishedDoc.outputs.map((field) => <span key={field.name}><code>{field.name}</code>{field.label ? ` · ${field.label}` : ''}<small>{field.type}{field.required ? ' · 必填' : ''}</small></span>)}</div>}
            <FailureBehaviorField data={d} inactiveErrorEdges={inactiveErrorEdges} missingErrorRoute={missingErrorRoute} onChange={(patch) => updateNodeData(node.id, patch)} />
            <RetryFields data={d} onChange={(patch) => updateNodeData(node.id, patch)} />
          </>
        )
      })()}

      {d.kind === 'if' && (
        <MappedField label="Condition" mode="expression" placeholder="比如 result.ok === true；true 走上输出、false 走下输出" value={d.condition ?? ''} onChange={(value) => updateNodeData(node.id, { condition: value })} onOpenMapper={setMappingTarget} />
      )}

      {d.kind === 'switch' && (
        <>
          <MappedField label="判断表达式（值）" mode="expression" placeholder="比如 result.kind" value={d.condition ?? ''} onChange={(value) => updateNodeData(node.id, { condition: value })} onOpenMapper={setMappingTarget} />
          <label className="wf-field">
            <span>Case（逗号分隔，对应右侧输出口）</span>
            <input
              placeholder="a, b, c（default 口兜底）"
              value={d.cases ?? ''}
              onChange={(e) => updateNodeData(node.id, { cases: e.target.value })}
            />
          </label>
        </>
      )}

      {d.kind === 'output' && (
        <MappedField label="Template" multiline rows={3} mode="template" placeholder="留空=直接显示上一节点结果；或填 结果: {{result}}" value={d.template ?? ''} onChange={(value) => updateNodeData(node.id, { template: value })} onOpenMapper={setMappingTarget} />
      )}

      {d.kind === 'loop' && (
        <>
          <label className="wf-field">
            <span>循环方式</span>
            <select value={d.mode ?? 'items'} onChange={(e) => updateNodeData(node.id, { mode: e.target.value })}>
              <option value="items">遍历数组 (items)</option>
              <option value="count">固定次数 (count)</option>
            </select>
          </label>
          {d.mode === 'count' ? (
            <label className="wf-field">
              <span>次数</span>
              <input
                placeholder="例如 5"
                value={d.count ?? ''}
                onChange={(e) => updateNodeData(node.id, { count: e.target.value })}
              />
            </label>
          ) : (
            <MappedField label="数组表达式（用 result 表示上游结果）" mode="expression" placeholder="例如 result.items" value={d.itemsExpr ?? ''} onChange={(value) => updateNodeData(node.id, { itemsExpr: value })} onOpenMapper={setMappingTarget} />
          )}
          <label className="wf-field">
            <span>次数上限 maxIters</span>
            <input
              placeholder="100"
              value={d.maxIters ?? ''}
              onChange={(e) => updateNodeData(node.id, { maxIters: e.target.value })}
            />
          </label>
          <label className="wf-field wf-field--checkbox">
            <input
              type="checkbox"
              checked={d.collect ?? false}
              onChange={(e) => updateNodeData(node.id, { collect: e.target.checked })}
            />
            <span>收集每轮结果成数组</span>
          </label>
        </>
      )}

      {d.kind === 'while' && (
        <>
          <MappedField label="继续条件（用 result 表示当前值）" mode="expression" placeholder="例如 result.count < 5" value={d.condition ?? ''} onChange={(value) => updateNodeData(node.id, { condition: value })} onOpenMapper={setMappingTarget} />
          <label className="wf-field">
            <span>次数上限 maxIters</span>
            <input
              placeholder="100"
              value={d.maxIters ?? ''}
              onChange={(e) => updateNodeData(node.id, { maxIters: e.target.value })}
            />
          </label>
          <label className="wf-field wf-field--checkbox">
            <input
              type="checkbox"
              checked={d.collect ?? false}
              onChange={(e) => updateNodeData(node.id, { collect: e.target.checked })}
            />
            <span>收集每轮结果成数组</span>
          </label>
        </>
      )}

      {d.kind === 'code' && (
        <>
          <label className="wf-field">
            <span>运行超时（秒，留空=不限制）</span>
            <input
              placeholder="例如 30"
              value={d.timeout ?? ''}
              onChange={(e) => updateNodeData(node.id, { timeout: e.target.value })}
            />
          </label>
          <FailureBehaviorField data={d} inactiveErrorEdges={inactiveErrorEdges} missingErrorRoute={missingErrorRoute} onChange={(patch) => updateNodeData(node.id, patch)} />
          <RetryFields data={d} onChange={(patch) => updateNodeData(node.id, patch)} />
          <div className="wf-codecard">
            <div className="wf-codecard__head">
            <span className="wf-codecard__title">Code</span>
            <select
              className="wf-codecard__lang"
              value={d.language ?? 'typescript'}
              onChange={(e) => updateNodeData(node.id, { language: e.target.value, lastRun: undefined })}
            >
              <option value="typescript">TypeScript</option>
              <option value="python">Python</option>
            </select>
          </div>
          <div className="wf-codecard__editor">
            <CodeEditor
              value={d.code ?? ''}
              onChange={(v) => updateNodeData(node.id, { code: v, lastRun: undefined })}
              language={d.language ?? 'typescript'}
            />
            <button
              type="button"
              className="wf-ed-expand"
              onClick={() => setCodeExpanded(true)}
              title="全屏编辑"
              aria-label="全屏编辑代码"
            >
              <img className="wf-icon-image" src={expandArrowsIcon} alt="" aria-hidden="true" />
            </button>
          </div>
          </div>
        </>
      )}

      {d.kind === 'http' && (
        <>
          <div className="wf-field-row">
            <label className="wf-field"><span>方法</span><select value={d.httpMethod ?? 'GET'} onChange={(event) => updateNodeData(node.id, { httpMethod: event.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((method) => <option key={method}>{method}</option>)}</select></label>
            <label className="wf-field"><span>超时（秒）</span><input value={d.timeout ?? '30'} onChange={(event) => updateNodeData(node.id, { timeout: event.target.value })} /></label>
          </div>
          <MappedField label="URL" mode="template" placeholder="https://api.example.com/items/{{result.id}}" value={d.url ?? ''} onChange={(value) => updateNodeData(node.id, { url: value, lastRun: undefined })} onOpenMapper={setMappingTarget} />
          <label className="wf-field"><span>连接</span><select aria-label="连接" value={d.credentialId ?? ''} onChange={(event) => updateNodeData(node.id, { credentialId: event.target.value || undefined })}><option value="">无认证</option>{credentials.filter((credential) => credential.kind !== 'webhook-secret').map((credential) => <option key={credential.id} value={credential.id}>{credential.name}{credential.kind === 'oauth2' ? ` · ${credential.status === 'connected' ? '已连接' : credential.status === 'expiring' ? '即将过期' : credential.status === 'authorizing' ? '等待授权' : '需检查'}` : ''}</option>)}</select>{d.credentialId && credentials.find((credential) => credential.id === d.credentialId)?.status === 'error' && <small className="wf-field-hint is-error">所选连接异常，请到主页“连接”中检查。</small>}{d.credentialId && credentials.find((credential) => credential.id === d.credentialId)?.status === 'expired' && <small className="wf-field-hint is-error">OAuth2 Token 已过期，下次运行会尝试自动刷新。</small>}</label>
          <MappedField label="请求头 JSON" multiline rows={3} mode="template" placeholder={'{"Content-Type":"application/json"}'} value={d.headers ?? ''} onChange={(value) => updateNodeData(node.id, { headers: value })} onOpenMapper={setMappingTarget} />
          {!['GET', 'HEAD'].includes(d.httpMethod ?? 'GET') && <MappedField label="请求体" multiline rows={4} mode="template" placeholder={'{"input":"{{result.text}}"}'} value={d.body ?? ''} onChange={(value) => updateNodeData(node.id, { body: value })} onOpenMapper={setMappingTarget} />}
          <label className="wf-field"><span>响应格式</span><select value={d.responseMode ?? 'auto'} onChange={(event) => updateNodeData(node.id, { responseMode: event.target.value })}><option value="auto">自动识别</option><option value="json">JSON</option><option value="text">文本</option></select></label>
          <label className="wf-field wf-field--checkbox"><input type="checkbox" checked={d.failOnHttpError !== false} onChange={(event) => updateNodeData(node.id, { failOnHttpError: event.target.checked })} /><span>非 2xx 响应视为失败</span></label>
          <FailureBehaviorField data={d} inactiveErrorEdges={inactiveErrorEdges} missingErrorRoute={missingErrorRoute} onChange={(patch) => updateNodeData(node.id, patch)} />
          <RetryFields data={d} onChange={(patch) => updateNodeData(node.id, patch)} />
        </>
      )}

      {d.kind === 'connector-trigger' && (
        <>
          <label className="wf-field">
            <span>应用</span>
            <select
              aria-label="应用"
              value={d.connectorId ?? ''}
              onChange={(event) => {
                const connector = latestConnectors.find((candidate) => candidate.id === event.target.value && candidate.triggers?.length)
                const trigger = connector?.triggers?.[0]
                const credentialId = connector && credentials.some((credential) => credential.id === d.credentialId && connectorCredentialCompatible(connector, credential)) ? d.credentialId : undefined
                updateNodeData(node.id, { connectorId: connector?.id, connectorVersion: connector?.version, connectorTrigger: trigger?.id, connectorAction: undefined, connectorParams: trigger ? defaultConnectorParams(trigger.fields) : {}, credentialId, pollInterval: d.pollInterval ?? '60', lastRun: undefined })
              }}
            >
              <option value="">选择应用</option>
              {latestConnectors.filter((connector) => connector.triggers?.length).map((connector) => <option key={connector.id} value={connector.id}>{connector.name} · {connector.category}</option>)}
            </select>
          </label>
          {selectedConnector && <div className="wf-connector-summary"><span className="wf-connector-dot" style={{ background: selectedConnector.color }} /><div><strong>{selectedConnector.name} · v{selectedConnector.version}</strong><span>{selectedConnector.description}</span></div>{latestConnector && latestConnector.version > selectedConnector.version && <button type="button" onClick={() => { const trigger = latestConnector.triggers?.find((candidate) => candidate.id === d.connectorTrigger) ?? latestConnector.triggers?.[0]; updateNodeData(node.id, { connectorVersion: latestConnector.version, connectorTrigger: trigger?.id, connectorParams: trigger ? compatibleConnectorParams(trigger.fields) : {}, lastRun: undefined }) }}>升级到 v{latestConnector.version}</button>}</div>}
          {d.connectorId && d.connectorVersion !== undefined && !selectedConnector && <div className="wf-inline-error"><span>连接器 {d.connectorId} v{d.connectorVersion} 当前不可用，请恢复对应版本或切换到最新版。</span>{latestConnector && <button type="button" onClick={() => { const trigger = latestConnector.triggers?.find((candidate) => candidate.id === d.connectorTrigger) ?? latestConnector.triggers?.[0]; updateNodeData(node.id, { connectorVersion: latestConnector.version, connectorTrigger: trigger?.id, connectorParams: trigger ? compatibleConnectorParams(trigger.fields) : {}, lastRun: undefined }) }}>切换到 v{latestConnector.version}</button>}</div>}
          {selectedConnector && <label className="wf-field"><span>事件</span><select aria-label="事件" value={d.connectorTrigger ?? ''} onChange={(event) => { const trigger = selectedConnector.triggers?.find((candidate) => candidate.id === event.target.value); updateNodeData(node.id, { connectorTrigger: trigger?.id, connectorParams: trigger ? defaultConnectorParams(trigger.fields) : {}, lastRun: undefined }) }}><option value="">选择事件</option>{selectedConnector.triggers?.map((trigger) => <option key={trigger.id} value={trigger.id}>{trigger.label}</option>)}</select>{selectedConnectorTrigger && <small className="wf-field-hint">{selectedConnectorTrigger.description}</small>}</label>}
          {selectedConnector && <label className="wf-field"><span>连接</span><select aria-label="连接" value={d.credentialId ?? ''} onChange={(event) => updateNodeData(node.id, { credentialId: event.target.value || undefined, lastRun: undefined })}><option value="">选择连接</option>{credentials.filter((credential) => connectorCredentialCompatible(selectedConnector, credential)).map((credential) => <option key={credential.id} value={credential.id}>{credential.name}{credential.kind === 'oauth2' ? ` · ${credential.status === 'connected' ? '已连接' : credential.status === 'expiring' ? '即将过期' : '需检查'}` : ''}</option>)}</select><small className="wf-field-hint">{selectedConnector.authHint}</small>{d.credentialId && credentials.find((credential) => credential.id === d.credentialId)?.status === 'error' && <small className="wf-field-hint is-error">所选连接异常，请到主页“连接”中检查。</small>}</label>}
          {selectedConnectorTrigger && <div className="wf-connector-fields">{selectedConnectorTrigger.fields.map((field) => {
            const value = d.connectorParams?.[field.id] ?? field.defaultValue ?? ''
            const stateKey = dynamicOptionsKey(field)
            return <ConnectorParameterField key={field.id} field={field} value={value} mapped={false} dynamic={dynamicOptions[stateKey]} dynamicKey={stateKey} onChange={(next) => setConnectorParam(field.id, next)} onLoadOptions={() => void loadDynamicOptions(field.id, stateKey)} onOpenMapper={setMappingTarget} />
          })}</div>}
          <label className="wf-field"><span>轮询间隔（秒）</span><input type="number" min="15" max="86400" step="1" value={d.pollInterval ?? '60'} onChange={(event) => updateNodeData(node.id, { pollInterval: event.target.value, lastRun: undefined })} /></label>
          <div className={`wf-polling-status${pollingTrigger?.lastError ? ' is-error' : pollingTrigger?.active ? ' is-active' : ''}`}>
            <div className="wf-polling-status__head"><div><strong>{pollingTrigger ? pollingTrigger.active ? '正在轮询' : pollingTrigger.initialized ? '监听中' : '等待建立基线' : '尚未发布'}</strong><span>{pollingTrigger?.lastError || (pollingTrigger ? `下次轮询 ${formatPollingTime(pollingTrigger.nextPollAt)}` : '发布并启用后开始轮询')}</span></div>{pollingTrigger && <button type="button" className="wf-btn" onClick={() => void pollNow()} disabled={pollingBusy || pollingTrigger.active}>{pollingBusy || pollingTrigger.active ? <Loader2 className="wf-spin" size={14} /> : <RotateCw size={14} />}立即轮询</button>}</div>
            {pollingTrigger && <dl><div><dt>最近轮询</dt><dd>{formatPollingTime(pollingTrigger.lastPolledAt)}</dd></div><div><dt>最近事件</dt><dd>{formatPollingTime(pollingTrigger.lastEventAt)}</dd></div></dl>}
          </div>
        </>
      )}

      {d.kind === 'connector' && (
        <>
          <label className="wf-field">
            <span>应用</span>
            <select
              value={d.connectorId ?? ''}
              onChange={(event) => {
                const connector = latestConnectors.find((candidate) => candidate.id === event.target.value)
                const action = connector?.actions[0]
                const credentialId = connector && credentials.some((credential) => credential.id === d.credentialId && connectorCredentialCompatible(connector, credential)) ? d.credentialId : undefined
                updateNodeData(node.id, { connectorId: connector?.id, connectorVersion: connector?.version, connectorAction: action?.id, connectorParams: action ? defaultConnectorParams(action.fields) : {}, credentialId, lastRun: undefined })
              }}
            >
              <option value="">选择应用</option>
              {latestConnectors.map((connector) => <option key={connector.id} value={connector.id}>{connector.name} · {connector.category}</option>)}
            </select>
          </label>
          {selectedConnector && <div className="wf-connector-summary"><span className="wf-connector-dot" style={{ background: selectedConnector.color }} /><div><strong>{selectedConnector.name} · v{selectedConnector.version}</strong><span>{selectedConnector.description}</span></div>{latestConnector && latestConnector.version > selectedConnector.version && <button type="button" onClick={() => { const action = latestConnector.actions.find((candidate) => candidate.id === d.connectorAction) ?? latestConnector.actions[0]; updateNodeData(node.id, { connectorVersion: latestConnector.version, connectorAction: action?.id, connectorParams: action ? compatibleConnectorParams(action.fields) : {}, lastRun: undefined }) }}>升级到 v{latestConnector.version}</button>}</div>}
          {d.connectorId && d.connectorVersion !== undefined && !selectedConnector && <div className="wf-inline-error"><span>连接器 {d.connectorId} v{d.connectorVersion} 当前不可用，请恢复对应版本或切换到最新版。</span>{latestConnector && <button type="button" onClick={() => { const action = latestConnector.actions.find((candidate) => candidate.id === d.connectorAction) ?? latestConnector.actions[0]; updateNodeData(node.id, { connectorVersion: latestConnector.version, connectorAction: action?.id, connectorParams: action ? compatibleConnectorParams(action.fields) : {}, lastRun: undefined }) }}>切换到 v{latestConnector.version}</button>}</div>}
          {selectedConnector && <label className="wf-field"><span>动作</span><select value={d.connectorAction ?? ''} onChange={(event) => { const action = selectedConnector.actions.find((candidate) => candidate.id === event.target.value); updateNodeData(node.id, { connectorAction: action?.id, connectorParams: action ? defaultConnectorParams(action.fields) : {}, lastRun: undefined }) }}><option value="">选择动作</option>{selectedConnector.actions.map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}</select>{selectedConnectorAction && <small className="wf-field-hint">{selectedConnectorAction.description}</small>}</label>}
          {selectedConnector && <label className="wf-field"><span>连接</span><select aria-label="连接" value={d.credentialId ?? ''} onChange={(event) => updateNodeData(node.id, { credentialId: event.target.value || undefined, lastRun: undefined })}><option value="">选择连接</option>{credentials.filter((credential) => connectorCredentialCompatible(selectedConnector, credential)).map((credential) => <option key={credential.id} value={credential.id}>{credential.name}{credential.kind === 'oauth2' ? ` · ${credential.status === 'connected' ? '已连接' : credential.status === 'expiring' ? '即将过期' : '需检查'}` : ''}</option>)}</select><small className="wf-field-hint">{selectedConnector.authHint}</small>{d.credentialId && credentials.find((credential) => credential.id === d.credentialId)?.status === 'error' && <small className="wf-field-hint is-error">所选连接异常，请到主页“连接”中检查。</small>}</label>}
          {selectedConnectorAction && <div className="wf-connector-fields">{selectedConnectorAction.fields.map((field) => {
            const value = d.connectorParams?.[field.id] ?? field.defaultValue ?? ''
            const stateKey = dynamicOptionsKey(field)
            return <ConnectorParameterField key={field.id} field={field} value={value} mapped dynamic={dynamicOptions[stateKey]} dynamicKey={stateKey} onChange={(next) => setConnectorParam(field.id, next)} onLoadOptions={() => void loadDynamicOptions(field.id, stateKey)} onOpenMapper={setMappingTarget} />
          })}</div>}
          <div className="wf-field-row"><label className="wf-field"><span>超时（秒）</span><input type="number" min="1" max="3600" value={d.timeout ?? '30'} onChange={(event) => updateNodeData(node.id, { timeout: event.target.value })} /></label><FailureBehaviorField data={d} inactiveErrorEdges={inactiveErrorEdges} missingErrorRoute={missingErrorRoute} onChange={(patch) => updateNodeData(node.id, patch)} /></div>
          <RetryFields data={d} onChange={(patch) => updateNodeData(node.id, patch)} />
        </>
      )}

      {d.kind === 'data-store' && (
        <>
          <label className="wf-field">
            <span>命名空间</span>
            <input aria-label="Data Store 命名空间" value={d.storeNamespace ?? 'default'} onChange={(event) => updateNodeData(node.id, { storeNamespace: event.target.value, lastRun: undefined })} placeholder="default" />
            <small className="wf-field-hint">同一工作流内隔离；只允许字母、数字、点、下划线、冒号和短横线。</small>
          </label>
          <label className="wf-field">
            <span>操作</span>
            <select aria-label="Data Store 操作" value={d.storeOperation ?? 'get'} onChange={(event) => updateNodeData(node.id, { storeOperation: event.target.value as WorkflowNodeData['storeOperation'], lastRun: undefined })}>
              <option value="get">读取键</option>
              <option value="set">写入键</option>
              <option value="delete">删除键</option>
              <option value="list">列出键</option>
            </select>
          </label>
          {(d.storeOperation ?? 'get') !== 'list' ? (
            <MappedField label="键" mode="template" value={d.storeKey ?? ''} onChange={(value) => updateNodeData(node.id, { storeKey: value, lastRun: undefined })} onOpenMapper={setMappingTarget} placeholder="例如 customer:{{result.id}}" />
          ) : (
            <MappedField label="键前缀（可选）" mode="template" value={d.storePrefix ?? ''} onChange={(value) => updateNodeData(node.id, { storePrefix: value, lastRun: undefined })} onOpenMapper={setMappingTarget} placeholder="例如 customer:" />
          )}
          {(d.storeOperation ?? 'get') === 'set' && <MappedField label="值" multiline rows={5} mode="template" value={d.storeValue ?? '{{result}}'} onChange={(value) => updateNodeData(node.id, { storeValue: value, lastRun: undefined })} onOpenMapper={setMappingTarget} placeholder={'{"status":"ready","value":{{result}}}'} />}
          <p className="wf-field-note">值在 DSH 主机上使用 AES-256-GCM 加密保存；运行历史只显示脱敏结果。Data Store 按工作流和命名空间隔离。</p>
          <FailureBehaviorField data={d} inactiveErrorEdges={inactiveErrorEdges} missingErrorRoute={missingErrorRoute} onChange={(patch) => updateNodeData(node.id, patch)} />
        </>
      )}

      {codeExpanded && (
        <CodeEditorModal
          value={d.code ?? ''}
          onChange={(v) => updateNodeData(node.id, { code: v, lastRun: undefined })}
          language={d.language ?? 'typescript'}
          onClose={() => setCodeExpanded(false)}
        />
      )}

      <label className="wf-field">
        <span>备注</span>
        <input
          value={d.notes ?? ''}
          onChange={(e) => updateNodeData(node.id, { notes: e.target.value })}
        />
      </label>
      {d.kind !== 'note' && d.kind !== 'wait' && d.kind !== 'connector-trigger' && <div className="wf-node-test"><label className="wf-field"><span>测试输入</span><textarea rows={3} placeholder="作为当前节点的上游输入" value={testInput} onChange={(event) => setTestInput(event.target.value)} /></label><button className="wf-btn wf-btn--primary" onClick={() => void testNode()} disabled={testing}>{testing ? <Loader2 className="wf-spin" size={15} /> : <Play size={15} />}{testing ? '测试中' : '测试此节点'}</button></div>}
      </div>}

      {activeTab === 'output' && d.lastRun && (
        <div className="wf-run">
          {(d.lastRun.attempts ?? 1) > 1 && <p className="wf-run-attempts">执行了 {d.lastRun.attempts} 次后完成</p>}
          {d.kind !== 'output' && d.kind !== 'trigger' && d.kind !== 'connector-trigger' && d.lastRun.input !== undefined && d.lastRun.input !== '' && (
            <label className="wf-field">
              <span>输入 Input</span>
              <textarea className="wf-run__box" readOnly rows={3} value={d.lastRun.input} />
            </label>
          )}
          {d.kind !== 'trigger' && d.kind !== 'schedule' && d.lastRun.value !== undefined && (
            <label className="wf-field">
              <span>输出 Output</span>
              <textarea
                className="wf-run__box"
                readOnly
                rows={5}
                value={
                  typeof d.lastRun.value === 'string'
                    ? d.lastRun.value
                    : JSON.stringify(d.lastRun.value)
                }
              />
            </label>
          )}
          {d.lastRun.logs && d.lastRun.logs.length > 0 && (
            <label className="wf-field">
              <span>日志 Logs</span>
              <pre className="wf-result__logs">{d.lastRun.logs.join('\n')}</pre>
            </label>
          )}
          {d.lastRun.error && (
            <label className="wf-field">
              <span>错误 Error</span>
              <pre className="wf-result__error">{d.lastRun.error}</pre>
            </label>
          )}
        </div>
      )}
      {activeTab === 'output' && !d.lastRun && (
        <div className="wf-inspector__empty-state">
          <Activity size={22} />
          <strong>还没有运行数据</strong>
          <span>运行工作流后可查看这个节点的输入、输出、日志和错误。</span>
        </div>
      )}
      {mappingTarget && <FieldMapper targetLabel={mappingTarget.label} mode={mappingTarget.mode} sources={mappingSources} onInsert={mappingTarget.insert} onClose={() => setMappingTarget(null)} />}
    </aside>
  )
}

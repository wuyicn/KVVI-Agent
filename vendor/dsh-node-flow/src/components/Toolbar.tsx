/**
 * Toolbar — add nodes, run/export the workflow.
 *
 * `Run` walks the compiled step list in order and executes each node kind:
 * agent/code nodes hit the host routes; output/condition nodes are evaluated
 * locally. Results flow downstream through a `lastOutput` variable (the most
 * recent agent/code output), available to output (`{{result}}`) and condition
 * nodes.
 *
 * @module components/Toolbar
 */

import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  Brackets,
  Bug,
  Clock3,
  Download,
  Gauge,
  HelpCircle,
  LayoutTemplate,
  Loader2,
  Moon,
  MoreHorizontal,
  PanelLeftOpen,
  Pencil,
  Play,
  Save,
  Square,
  Sun,
  Upload,
  Workflow,
  X,
} from 'lucide-react'
import { useCanvasStore } from '../store/canvas.js'
import type { WorkflowContractField, WorkflowDocument, WorkflowNodeData, WorkflowRunNode, WorkflowRunRecord, WorkflowStatus } from '../model.js'
import { ScheduleBoard } from './ScheduleBoard.js'
import { HelpDoc } from './HelpDoc.js'
import { WorkflowContractPanel } from './WorkflowContractPanel.js'
import { WorkflowConcurrencyPanel } from './WorkflowConcurrencyPanel.js'
import { WorkflowRunInputDialog } from './WorkflowRunInputDialog.js'
import { evaluateResultExpression, renderResultTemplate } from '../resultExpression.js'
import { validateWorkflowContract } from '../subworkflowProtocol.js'


/** JSON response of the host run routes. */
type RunResponse = {
  ok?: boolean
  error?: string
  value?: unknown
  logs?: string[]
  output?: string
  failure?: { kind?: string; message?: string }
  node?: WorkflowRunNode
  run?: WorkflowRunRecord
}

const now = (): string => new Date().toLocaleTimeString()

/** Substitute `{{key}}` placeholders in an output template. */
function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return renderResultTemplate(template, vars.result)
}

/** Evaluate an expression against a `result` variable (best-effort). */
function evalExpr(expr: string, vars: Record<string, unknown>): unknown {
  return evaluateResultExpression(expr, vars.result)
}

/** Evaluate a condition expression to a boolean against a `result` variable. */
function evalCondition(expr: string, vars: Record<string, unknown>): boolean {
  return Boolean(evalExpr(expr, vars))
}

/** Parse a route response as JSON, falling back to a readable text error. */
async function parseResponse(res: Response): Promise<RunResponse> {
  try {
    return (await res.json()) as RunResponse
  } catch {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status} - ${text.slice(0, 200)}` }
  }
}

function errorRouteMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const httpStatus = /\bHTTP\s+([1-5]\d{2})\b/i.exec(message)?.[1]
  return httpStatus ? `HTTP ${httpStatus} 请求失败` : '节点执行失败'
}

function stringifyRunInput(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

export function Toolbar({
  workflowId,
  onExitNodeMode,
  onBackToDashboard,
  onSave,
  saveState,
  workflowStatus,
  workflowHasUnpublishedChanges,
  executionInputs,
  onStatusChange,
  onRunComplete,
  onOpenLibrary,
  onOpenTemplates,
  onShowExecution,
  executionOpen,
  onStartDebug,
  onClearDebug,
  debugActive,
  debugBusy,
}: {
  workflowId?: string
  onExitNodeMode?: () => void
  onBackToDashboard?: () => void
  onSave?: () => void
  saveState: 'saved' | 'saving' | 'dirty' | 'offline' | 'conflict' | 'error'
  workflowStatus: WorkflowStatus
  workflowHasUnpublishedChanges: boolean
  executionInputs?: WorkflowContractField[]
  onStatusChange?: (status: WorkflowStatus) => void | Promise<void>
  onRunComplete?: (run: WorkflowRunRecord) => void | Promise<void>
  onOpenLibrary: () => void
  onOpenTemplates: () => void
  onShowExecution: () => void
  executionOpen: boolean
  onStartDebug: (input: unknown) => Promise<void> | void
  onClearDebug: () => void
  debugActive: boolean
  debugBusy: boolean
}) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const workflowName = useCanvasStore((s) => s.workflowName)
  const workflowInputs = useCanvasStore((s) => s.workflowInputs)
  const nodes = useCanvasStore((s) => s.nodes)
  const setWorkflowName = useCanvasStore((s) => s.setWorkflowName)
  const theme = useCanvasStore((s) => s.theme)
  const toggleTheme = useCanvasStore((s) => s.toggleTheme)
  const nameRef = useRef<HTMLInputElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  const runningRef = useRef(false)
  const runAbortRef = useRef<AbortController | null>(null)
  const remoteRunIdRef = useRef<string | null>(null)
  const publishingRef = useRef(false)
  const [showBoard, setShowBoard] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showContract, setShowContract] = useState(false)
  const [showConcurrency, setShowConcurrency] = useState(false)
  const [showRunInput, setShowRunInput] = useState(false)
  const [showDebugInput, setShowDebugInput] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const inputFields = executionInputs ?? workflowInputs

  const startDebugFromToolbar = (): void => {
    if (debugActive || debugBusy) return
    if (!nodes.some((node) => node.data.breakpoint)) {
      alert('请先在节点检查器中启用至少一个调试断点。')
      return
    }
    if (inputFields.length > 0) {
      setShowDebugInput(true)
      return
    }
    void Promise.resolve(onStartDebug({})).catch((error: unknown) => alert(error instanceof Error ? error.message : String(error)))
  }
  const saveLabel = saveState === 'saving'
    ? '正在保存'
    : saveState === 'dirty'
      ? '有未保存更改'
      : saveState === 'offline'
        ? '已离线保存'
        : saveState === 'conflict'
          ? '版本冲突'
      : saveState === 'error'
        ? '保存失败'
        : '已自动保存'

  useEffect(() => {
    if (!menuOpen) return
    const dismissOnPointerDown = (event: PointerEvent): void => {
      if (!moreRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', dismissOnPointerDown, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOnPointerDown, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [menuOpen])

  const stopRun = async (): Promise<void> => {
    if (!runningRef.current || stopping) return
    setStopping(true)
    const remoteRunId = remoteRunIdRef.current
    const cancelRequest = remoteRunId
      ? fetch('/dsh-node-flow/workflows', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', runId: remoteRunId }),
        }).catch(() => undefined)
      : Promise.resolve(undefined)
    runAbortRef.current?.abort(new Error('运行已取消'))
    await cancelRequest
  }

  const onRun = async (runInput?: unknown, skipInputPrompt = false) => {
    if (runningRef.current) {
      await stopRun()
      return
    }
    if (!skipInputPrompt && inputFields.length > 0) {
      setShowRunInput(true)
      return
    }
    const validatedInput = validateWorkflowContract(runInput === undefined && inputFields.length ? {} : runInput, inputFields, '运行输入')
    onClearDebug()
    const startedAt = new Date().toISOString()
    const editorRunId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const store = useCanvasStore.getState()
    const nodes = store.nodes
    const edges = store.edges
    if (nodes.length === 0) {
      alert('工作流为空')
      return
    }
    if (workflowStatus === 'enabled' || nodes.some((node) => node.data.kind === 'wait' || node.data.kind === 'connector-trigger' || node.data.kind === 'data-store')) {
      runningRef.current = true
      const runController = new AbortController()
      runAbortRef.current = runController
      remoteRunIdRef.current = editorRunId
      setStopping(false)
      setRunning(true)
      if (!executionOpen) onShowExecution()
      store.clearActiveEdges()
      for (const node of nodes) updateNodeData(node.id, { lastRun: undefined })
      try {
        if (!workflowId) throw new Error('请先保存工作流再运行 Wait 节点')
        const response = await fetch('/dsh-node-flow/workflows', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'run', id: workflowId, runId: editorRunId, document: workflowStatus === 'enabled' ? undefined : store.exportDocument(), input: validatedInput }),
          signal: runController.signal,
        })
        const data = await parseResponse(response)
        if (!response.ok || !data.run) throw new Error(data.error || `HTTP ${response.status}`)
        const waitNodeId = data.run.waitpoint?.nodeId
        for (const record of data.run.nodes) {
          updateNodeData(record.id, {
            lastRun: {
              input: typeof record.input === 'string' ? record.input : JSON.stringify(record.input),
              logs: record.logs ?? [],
              value: record.output,
              error: record.error,
              at: now(),
              duration: record.ms,
               attempts: record.attempts,
               childRunId: record.childRunId,
                errorHandled: record.errorHandled,
               waiting: data.run.status === 'waiting' && record.id === waitNodeId,
            },
          })
        }
      } catch (error) {
        if (!runController.signal.aborted) {
          if (skipInputPrompt) throw error
          alert(error instanceof Error ? error.message : String(error))
        }
      } finally {
        runningRef.current = false
        runAbortRef.current = null
        remoteRunIdRef.current = null
        setRunning(false)
        setStopping(false)
      }
      return
    }
    runningRef.current = true
    const runController = new AbortController()
    runAbortRef.current = runController
    setStopping(false)
    setRunning(true)
    if (!executionOpen) onShowExecution()
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const edgesFrom = (id: string): typeof edges => edges.filter((e) => e.source === id)

    // Reset every node to a neutral (gray) border first.
    store.clearActiveEdges()
    for (const n of nodes) updateNodeData(n.id, { lastRun: undefined })

    let startIds = nodes
      .filter((n) => n.data.kind === 'trigger' || n.data.kind === 'webhook' || n.data.kind === 'schedule' || n.data.kind === 'connector-trigger')
      .map((n) => n.id)
    if (startIds.length === 0) startIds = nodes.map((n) => n.id)

    const visited = new Set<string>()
    let ran = false
    let budget = 0
    let finalValue = stringifyRunInput(validatedInput)
    const initialInput = stringifyRunInput(validatedInput)

    // Run a single loop/while body iteration by walking from `iterateId`. The
    // body walk terminates (returns) the moment control flows back to `loopId`
    // via the `back` edge, so each iteration is a self-contained sub-walk.
    const runLoopBody = async (iterateId: string, loopId: string, input: string): Promise<string> => {
      if (!iterateId) return input
      // Each iteration gets a FRESH clone of the outer visited (which does not
      // include body nodes), so body nodes re-run every time. The clone is what
      // executeNode mutates; the outer `visited` stays clean. executeNode's
      // `stopAt=loopId` ends the sub-walk the moment control flows back to the
      // loop node (the `back` edge), which is the iteration's terminal value.
      const bodyVisited = new Set(visited)
      return await executeNode(iterateId, input, bodyVisited, loopId)
    }

    // Execute ONE node. Returns the value flowing out of it. When `stopAt` is
    // supplied, reaching that id (the loop/while node) ends a body sub-walk.
    const executeNode = async (id: string, input: string, ctxVisited: Set<string>, stopAt?: string): Promise<string> => {
      if (runController.signal.aborted) throw new Error('运行已取消')
      if (!byId.has(id)) return input
      if (id === stopAt) return input
      if (ctxVisited.has(id)) return input
      ctxVisited.add(id)
      ran = true
      budget += 1
      if (budget > 100_000) throw new Error('超过运行步数上限（可能死循环）')

      const n = byId.get(id)!
      const d = n.data
      const t0 = performance.now()
      const dur = (): number => Math.round(performance.now() - t0)
      const setVal = (patch: Record<string, unknown>): void =>
        updateNodeData(id, { lastRun: { input, logs: [], ...patch, at: now(), duration: dur() } })
      const fail = (err: unknown): void =>
        updateNodeData(id, { lastRun: { input, logs: [], error: err instanceof Error ? err.message : String(err), at: now(), duration: dur() } })

      // Non-branch fan-out: follow every outgoing edge; the value that flows
      // back to the loop boundary (stopAt) is what the last executed downstream
      // node produced, so loop/while see the branch's end value, not the first.
      const fanOut = async (value: string): Promise<string> => {
        let last = value
        for (const e of edgesFrom(id).filter((edge) => edge.sourceHandle !== 'error')) {
          store.markEdgeActive(e.id)
          last = await executeNode(e.target, value, ctxVisited, stopAt)
        }
        return last
      }

      try {
        if (d.kind === 'trigger' || d.kind === 'schedule' || d.kind === 'webhook' || d.kind === 'connector-trigger') {
          const value = d.kind === 'webhook' ? input : input || d.text || ''
          setVal({ value })
          return await fanOut(value)
        } else if (d.kind === 'code' || d.kind === 'agent' || d.kind === 'http' || d.kind === 'connector' || d.kind === 'call-workflow') {
          setVal({ running: true })
          const onError = d.onError === 'continue' || d.onError === 'route' ? d.onError : 'stop'
          let nodeError: string | undefined
          let val = ''
          const remoteRunId = `editor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
          remoteRunIdRef.current = remoteRunId
          try {
            const res = await fetch('/dsh-node-flow/node-test', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ node: { ...n, data: { ...d, lastRun: undefined } }, input, runId: remoteRunId, workflowId, parentRunId: editorRunId, persistChildRuns: d.kind === 'call-workflow' }),
              signal: runController.signal,
            })
            const data = await parseResponse(res)
            if (!res.ok || !data.node) throw new Error(data.error ?? `HTTP ${res.status}`)
            const value = data.node.output
            const logs = data.node.logs ?? []
            nodeError = data.node.error
            updateNodeData(id, { lastRun: { input, logs, value, error: nodeError, attempts: data.node.attempts, childRunId: data.node.childRunId, at: now(), duration: dur() } })
            val = value !== undefined ? (typeof value === 'object' ? JSON.stringify(value) : String(value)) : logs.join('\n')
          } catch (err) {
            nodeError = err instanceof Error ? err.message : String(err)
            fail(err)
            if (runController.signal.aborted) throw err
          } finally {
            if (remoteRunIdRef.current === remoteRunId) remoteRunIdRef.current = null
          }
          if (nodeError) {
            const errorEdges = onError === 'route' ? edgesFrom(id).filter((edge) => edge.sourceHandle === 'error' && edge.target !== id) : []
            if (errorEdges.length > 0) {
              const errorEvent = JSON.stringify({ type: 'workflow-node-error', error: { message: errorRouteMessage(nodeError), nodeId: id, nodeLabel: d.label, nodeKind: d.kind, attempts: useCanvasStore.getState().nodes.find((node) => node.id === id)?.data.lastRun?.attempts ?? 1, occurredAt: new Date().toISOString() } })
              updateNodeData(id, { lastRun: { ...(useCanvasStore.getState().nodes.find((node) => node.id === id)?.data.lastRun ?? { input, logs: [], at: now(), duration: dur() }), errorHandled: true } })
              let last = errorEvent
              for (const edge of errorEdges) {
                store.markEdgeActive(edge.id)
                last = await executeNode(edge.target, errorEvent, ctxVisited, stopAt)
              }
              return last
            }
            if (onError === 'continue') return await fanOut('')
            return input
          }
          return await fanOut(val)
        } else if (d.kind === 'output') {
          const template = (d.template ?? '').trim() ? d.template! : '{{result}}'
          const rendered = renderTemplate(template, { result: input })
          updateNodeData(id, { lastRun: { input, logs: [], value: rendered, at: now(), duration: dur() } })
          return await fanOut(rendered)
        } else if (d.kind === 'if') {
          const ok = evalCondition(d.condition ?? '', { result: input })
          updateNodeData(id, { lastRun: { input, logs: [], value: String(ok), at: now(), duration: dur() } })
          const want = ok ? 'true' : 'false'
          const edge = edgesFrom(id).find((e) => (e.sourceHandle ?? 'true') === want)
          if (edge) {
            store.markEdgeActive(edge.id)
            return await executeNode(edge.target, input, ctxVisited, stopAt)
          }
          return input
        } else if (d.kind === 'switch') {
          const val = evalExpr(d.condition ?? '', { result: input })
          updateNodeData(id, { lastRun: { input, logs: [], value: String(val), at: now(), duration: dur() } })
          const cases = (d.cases ?? '').split(',').map((s) => s.trim()).filter(Boolean)
          const sval = String(val)
          let edge = edgesFrom(id).find((e) => e.sourceHandle && cases.includes(e.sourceHandle) && e.sourceHandle === sval)
          if (!edge) edge = edgesFrom(id).find((e) => e.sourceHandle === 'default')
          if (edge) {
            store.markEdgeActive(edge.id)
            return await executeNode(edge.target, input, ctxVisited, stopAt)
          }
          return input
        } else if (d.kind === 'loop' || d.kind === 'while') {
          const value = await runLoopOrWhile(id, d, input)
          updateNodeData(id, { lastRun: { input, logs: [], value, at: now(), duration: dur() } })
          const doneEdge = edgesFrom(id).find((e) => e.sourceHandle === 'done' || (!e.sourceHandle && e.sourceHandle !== 'iterate'))
          if (doneEdge) {
            store.markEdgeActive(doneEdge.id)
            return await executeNode(doneEdge.target, value, ctxVisited, stopAt)
          }
          return value
        }
        return input
      } catch (err) {
        fail(err)
        if (runController.signal.aborted) throw err
        return input
      }
    }

    // Evaluate the loop/while node itself: run its body across iterations, then
    // produce the `done` value (collected array or the last iteration result).
    const runLoopOrWhile = async (id: string, d: WorkflowNodeData, input: string): Promise<string> => {
      const loopId = id
      const iterateEdge = edgesFrom(id).find((e) => e.sourceHandle === 'iterate')
      const maxIters = parseInt(d.maxIters ?? '', 10) || 100
      const collect = Boolean(d.collect)
      const results: string[] = []
      let count = 0

      if (d.kind === 'loop') {
        let items: unknown[] = []
        if ((d.mode ?? 'items') === 'count') {
          const c = parseInt(d.count ?? '', 10) || 0
          items = Array.from({ length: c }, (_, i) => String(i + 1))
        } else {
          const arr = evalExpr(d.itemsExpr ?? '', { result: input })
          items = Array.isArray(arr) ? arr : []
        }
        for (const it of items) {
          if (runController.signal.aborted) throw new Error('运行已取消')
          if (count >= maxIters) break
          count += 1
          const item = typeof it === 'string' ? it : JSON.stringify(it)
          const r = await runLoopBody(iterateEdge?.target ?? '', loopId, item)
          if (collect) results.push(r)
        }
        return collect ? JSON.stringify(results) : String(results.length ? results[results.length - 1] : input)
      }

      // while: keep going while the condition (against the current value) is true.
      let cond = input
      while (true) {
        if (runController.signal.aborted) throw new Error('运行已取消')
        if (count >= maxIters) break
        const ok = evalCondition(d.condition ?? '', { result: cond })
        if (!ok) break
        count += 1
        const r = await runLoopBody(iterateEdge?.target ?? '', loopId, cond)
        cond = r
        if (collect) results.push(r)
      }
      return collect ? JSON.stringify(results) : String(cond)
    }

    try {
      for (const sid of startIds) {
        finalValue = await executeNode(sid, initialInput, visited)
      }
      if (!ran) alert('工作流没有可执行的节点。')
    } catch (err) {
      if (!runController.signal.aborted) {
        if (skipInputPrompt) throw err
        alert(err instanceof Error ? err.message : String(err))
      }
    } finally {
      runningRef.current = false
      runAbortRef.current = null
      remoteRunIdRef.current = null
      setRunning(false)
      setStopping(false)
      const completed = useCanvasStore.getState().nodes.filter((node) => node.data.lastRun && !node.data.lastRun.running)
      const runNodes = completed.map((node) => ({
        id: node.id,
        kind: node.data.kind,
        status: node.data.lastRun?.error ? 'error' as const : 'ok' as const,
        input: node.data.lastRun?.input,
        output: node.data.lastRun?.value,
        logs: node.data.lastRun?.logs,
        error: node.data.lastRun?.error,
        errorHandled: node.data.lastRun?.errorHandled,
        ms: node.data.lastRun?.duration ?? 0,
        attempts: node.data.lastRun?.attempts,
        childRunId: node.data.lastRun?.childRunId,
      }))
      const failed = runNodes.filter((node) => node.status === 'error' && !node.errorHandled).length
      const handledErrors = runNodes.filter((node) => node.status === 'error' && node.errorHandled).length
      const failedNode = runNodes.find((node) => node.status === 'error' && !node.errorHandled)
      const snapshot = useCanvasStore.getState().exportDocument()
      snapshot.nodes = snapshot.nodes.map((node) => ({ ...node, data: { ...node.data, lastRun: undefined } }))
      await onRunComplete?.({
        id: editorRunId,
        workflowId,
        rootRunId: editorRunId,
        depth: 0,
        name: workflowName,
        startedAt,
        completedAt: new Date().toISOString(),
        nodeCount: runNodes.length,
        status: runController.signal.aborted ? 'cancelled' : failed > 0 ? 'error' : handledErrors > 0 ? 'handled' : 'ok',
        failed,
        handledErrors,
        value: finalValue,
        nodes: runNodes,
        snapshot,
        checkpoint: failedNode ? { nodeId: failedNode.id, input: String(failedNode.input ?? ''), updatedAt: new Date().toISOString() } : undefined,
        resumable: !runController.signal.aborted && Boolean(failedNode),
      })
    }
  }

  const saveWorkflow = async (): Promise<void> => {
    const doc = useCanvasStore.getState().exportDocument()
    const json = JSON.stringify(doc, null, 2)
    const filename = `${workflowName.replace(/\s+/g, '-').toLowerCase()}.workflow.json`
    const picker = (window as unknown as {
      showSaveFilePicker?: (opts: unknown) => Promise<{
        createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }>
      }>
    }).showSaveFilePicker

    if (picker) {
      try {
        // Always show a fresh "Save as" dialog so the user picks the location.
        const handle = await picker({
          suggestedName: filename,
          types: [{ description: 'DSH workflow', accept: { 'application/json': ['.json'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(json)
        await writable.close()
        return
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return
      }
    }

    // Fallback: download to the user's default location.
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const onExport = (): void => {
    void saveWorkflow()
  }

  const onImportFile = (file: File | undefined): void => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const doc = JSON.parse(String(reader.result)) as WorkflowDocument
        if (!window.confirm('导入将替换当前画布。确定继续吗？')) return
        useCanvasStore.getState().importDocument(doc)
      } catch (err) {
        alert('导入失败：' + (err instanceof Error ? err.message : String(err)))
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="wf-toolbar">
      <div className="wf-toolbar__brand">
        {onBackToDashboard && (
          <button className="wf-icon-btn" onClick={onBackToDashboard} title="返回工作流" aria-label="返回工作流">
            <ArrowLeft size={18} />
          </button>
        )}
        <span className="wf-toolbar__logo"><Workflow size={17} /></span>
        <div className="wf-toolbar__identity">
          <span>工作流</span>
          <div>
            <input
              ref={nameRef}
              className="wf-name"
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              aria-label="工作流名称"
            />
            <span className={`wf-save wf-save--${saveState}`}>{saveLabel}</span>
          </div>
        </div>
        <button
          className="wf-icon-btn wf-toolbar__rename"
          onClick={() => nameRef.current?.focus()}
          title="重命名工作流"
          aria-label="重命名工作流"
        >
          <Pencil size={15} />
        </button>
      </div>
      <div className="wf-toolbar__actions">
        <button className="wf-toolbar-btn" onClick={onOpenLibrary}>
          <PanelLeftOpen size={16} /> 节点库
        </button>
        <button className="wf-toolbar-btn" onClick={onOpenTemplates}>
          <LayoutTemplate size={16} /> 模板
        </button>
        <span className="wf-toolbar__divider" aria-hidden="true" />
        <button
          className={`wf-icon-btn wf-toolbar__execution${executionOpen ? ' is-active' : ''}`}
          onClick={onShowExecution}
          title="运行详情"
          aria-label="运行详情"
        >
          <Activity size={17} />
        </button>
        {onSave && (
          <button className="wf-icon-btn wf-toolbar__save" onClick={onSave} disabled={saveState === 'saving'} title="立即保存" aria-label="保存工作流">
            {saveState === 'saving' ? <Loader2 className="wf-spin" size={17} /> : <Save size={17} />}
          </button>
        )}
        <div ref={moreRef} className="wf-toolbar__more">
          <button
            className={`wf-icon-btn${menuOpen ? ' is-active' : ''}`}
            onClick={() => setMenuOpen((open) => !open)}
            title="更多操作"
            aria-label="更多操作"
          >
            <MoreHorizontal size={18} />
          </button>
          {menuOpen && (
            <div className="wf-action-menu">
              <label>
                <Upload size={15} /> 导入工作流
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    onImportFile(event.target.files?.[0])
                    event.target.value = ''
                    setMenuOpen(false)
                  }}
                />
              </label>
              <button onClick={() => { onExport(); setMenuOpen(false) }}><Download size={15} /> 导出工作流</button>
               <button onClick={() => { setShowContract(true); setMenuOpen(false) }}><Brackets size={15} /> 输入 / 输出契约</button>
               <button onClick={() => { setShowConcurrency(true); setMenuOpen(false) }}><Gauge size={15} /> 运行策略</button>
              <button onClick={() => { setShowBoard(true); setMenuOpen(false) }}><Clock3 size={15} /> 定时任务</button>
              <button onClick={() => { setShowHelp(true); setMenuOpen(false) }}><HelpCircle size={15} /> 使用文档</button>
            </div>
          )}
        </div>
        <button
          className="wf-icon-btn wf-toolbar__theme"
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        {onStatusChange && (
          <button
            className={`wf-publish-toggle${workflowStatus === 'enabled' ? ' is-enabled' : ''}${workflowHasUnpublishedChanges ? ' is-stale' : ''}`}
            disabled={publishing}
            onClick={async () => {
              if (publishingRef.current) return
              publishingRef.current = true
              setPublishing(true)
              try {
                await onStatusChange(workflowStatus === 'enabled' && !workflowHasUnpublishedChanges ? 'disabled' : 'enabled')
              } finally {
                publishingRef.current = false
                setPublishing(false)
              }
            }}
            aria-label={workflowStatus === 'enabled' && workflowHasUnpublishedChanges ? '发布工作流更新' : workflowStatus === 'enabled' ? '停用工作流' : '发布并启用工作流'}
            title={workflowStatus === 'enabled' && workflowHasUnpublishedChanges ? '发布最新草稿' : workflowStatus === 'enabled' ? '停用工作流' : '发布并启用工作流'}
          >
            <span />{publishing ? '更新中' : workflowStatus === 'enabled' && workflowHasUnpublishedChanges ? '发布更新' : workflowStatus === 'enabled' ? '已启用' : '发布'}
          </button>
        )}
        <button className={`wf-run-btn${running ? ' is-cancel' : ''}`} onClick={() => void onRun()} disabled={stopping || debugActive || debugBusy}>
          {stopping ? <Loader2 className="wf-spin" size={16} /> : running ? <Square size={15} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          {stopping ? '正在停止' : running ? '停止' : '运行'}
        </button>
        <button className="wf-debug-btn" onClick={startDebugFromToolbar} disabled={debugActive || debugBusy || running} title="在断点处暂停并逐步执行">
          {debugBusy ? <Loader2 className="wf-spin" size={15} /> : <Bug size={16} />}
          {debugActive ? '调试暂停' : debugBusy ? '调试中' : '调试'}
        </button>
        {onExitNodeMode && (
          <button
            className="wf-icon-btn"
            onClick={onExitNodeMode}
            title="退出节点模式"
            aria-label="退出节点模式"
          >
            <X size={18} />
          </button>
        )}
      </div>
      {showBoard && (
        <ScheduleBoard
          workflowId={workflowId}
          onClose={() => setShowBoard(false)}
          onViewRun={() => {
            if (!executionOpen) onShowExecution()
          }}
        />
      )}
      {showHelp && <HelpDoc onClose={() => setShowHelp(false)} />}
      {showContract && <WorkflowContractPanel onClose={() => setShowContract(false)} />}
      {showConcurrency && <WorkflowConcurrencyPanel onClose={() => setShowConcurrency(false)} />}
      {showRunInput && <WorkflowRunInputDialog
        workflowName={workflowName}
        fields={inputFields}
        published={workflowStatus === 'enabled'}
        onClose={() => setShowRunInput(false)}
        onSubmit={async (input) => { await onRun(input, true) }}
      />}
      {showDebugInput && <WorkflowRunInputDialog
        workflowName={workflowName}
        fields={inputFields}
        debug
        onClose={() => setShowDebugInput(false)}
        onSubmit={async (input) => { await onStartDebug(input) }}
      />}
    </div>
  )
}

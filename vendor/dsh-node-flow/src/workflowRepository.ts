import { refreshWebhookTokens, type SavedWorkflow, type WorkflowAuditEvent, type WorkflowAuditTargetType, type WorkflowFolder, type WorkflowRunRecord, type WorkflowRunSummary, type WorkflowStatus, type WorkflowVersion } from './model.js'
import {
  createSavedWorkflow,
  executionDocument,
  normalizeSavedWorkflow,
  publishWorkflow,
  updateWorkflowDraft,
} from './workflowProtocol.js'
import { normalizeWorkflowFolder } from './workflowFolderProtocol.js'
import { validateWorkflowContract } from './subworkflowProtocol.js'

const STORAGE_KEY = 'dsh-node-flow:workflows:v1'
const RUN_STORAGE_KEY = 'dsh-node-flow:runs:v1'
const PENDING_UPSERT_KEY = 'dsh-node-flow:pending-upserts:v1'
const PENDING_DELETE_KEY = 'dsh-node-flow:pending-deletes:v1'
let supportsDirectRun = false
let supportsRunWrites = false
let supportsWorkflowRevisions = false
let supportsWorkflowVersions = false
let supportsWorkflowFolders = false

export class WorkflowConflictError extends Error {
  constructor(public readonly latest: SavedWorkflow) {
    super('工作流已在另一个页面被修改')
    this.name = 'WorkflowConflictError'
  }
}

export class WorkflowFolderConflictError extends Error {
  constructor(public readonly latest: WorkflowFolder) {
    super('文件夹已在另一个页面被修改')
    this.name = 'WorkflowFolderConflictError'
  }
}

export function workflowFoldersSupported(): boolean {
  return supportsWorkflowFolders
}

export function isWorkflowSyncPending(id: string): boolean {
  return readPendingUpserts().has(id)
}

export function acceptLatestWorkflow(workflow: SavedWorkflow): void {
  const latest = normalizeSavedWorkflow(workflow)
  replaceLocal(latest)
  setPendingUpsert(latest.id, null)
}

function sortWorkflows(workflows: SavedWorkflow[]): SavedWorkflow[] {
  return [...workflows].sort((left, right) => {
    const created = right.createdAt.localeCompare(left.createdAt)
    return created !== 0 ? created : left.id.localeCompare(right.id)
  })
}

function readLocal(): SavedWorkflow[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as SavedWorkflow[]).map(normalizeSavedWorkflow) : []
  } catch {
    return []
  }
}

function writeLocal(workflows: SavedWorkflow[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workflows.map(normalizeSavedWorkflow)))
  } catch {
    /* Host persistence remains authoritative when browser storage is unavailable. */
  }
}

function replaceLocal(workflow: SavedWorkflow): void {
  writeLocal([workflow, ...readLocal().filter((candidate) => candidate.id !== workflow.id)])
}

function offlineConflictCopy(workflow: SavedWorkflow): SavedWorkflow {
  const now = new Date().toISOString()
  const name = `${workflow.name} - 离线冲突副本`
  return createSavedWorkflow({
    ...workflow,
    id: `${workflow.id}-conflict-${Date.now().toString(36)}`,
    name,
    status: 'disabled',
    revision: 0,
    draftRevision: 0,
    publishedRevision: undefined,
    publishedAt: undefined,
    publishedDoc: undefined,
    createdAt: now,
    updatedAt: now,
    lastRunAt: undefined,
    doc: refreshWebhookTokens({ ...workflow.doc, name }),
  }, now)
}

function readLocalRuns(): WorkflowRunRecord[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RUN_STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed as WorkflowRunRecord[] : []
  } catch {
    return []
  }
}

function writeLocalRuns(runs: WorkflowRunRecord[]): void {
  try {
    localStorage.setItem(RUN_STORAGE_KEY, JSON.stringify(runs.slice(0, 50)))
  } catch {
    /* Run history remains available from the host when browser storage is full. */
  }
}

function readPendingUpserts(): Map<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_UPSERT_KEY) ?? '{}') as unknown
    if (Array.isArray(parsed)) return new Map(parsed.map((id) => [String(id), 0]))
    if (!parsed || typeof parsed !== 'object') return new Map()
    return new Map(Object.entries(parsed).map(([id, revision]) => [id, Number(revision) || 0]))
  } catch {
    return new Map()
  }
}

function writePendingUpserts(entries: Map<string, number>): void {
  try {
    localStorage.setItem(PENDING_UPSERT_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* Pending draft versions are best-effort in restricted browser contexts. */
  }
}

function setPendingUpsert(id: string, expectedRevision: number | null): void {
  const entries = readPendingUpserts()
  if (expectedRevision === null) entries.delete(id)
  else if (!entries.has(id)) entries.set(id, expectedRevision)
  writePendingUpserts(entries)
}

function readPendingDeletes(): Map<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_DELETE_KEY) ?? '[]') as unknown
    if (Array.isArray(parsed)) return new Map(parsed.map((id) => [String(id), 0]))
    if (!parsed || typeof parsed !== 'object') return new Map()
    return new Map(Object.entries(parsed).map(([id, revision]) => [id, Number(revision) || 0]))
  } catch {
    return new Map()
  }
}

function setPendingDelete(id: string, expectedRevision: number | null): void {
  const entries = readPendingDeletes()
  if (expectedRevision === null) entries.delete(id)
  else entries.set(id, expectedRevision)
  try {
    localStorage.setItem(PENDING_DELETE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* Pending deletion is retried after browser storage becomes available. */
  }
}

async function post(payload: unknown, signal?: AbortSignal): Promise<Response> {
  return await fetch('/dsh-node-flow/workflows', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
}

async function postRun(payload: unknown, signal?: AbortSignal): Promise<Response> {
  return await fetch('/dsh-node-flow/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
}

async function postSchedule(payload: unknown): Promise<Response> {
  return await fetch('/dsh-node-flow/schedule', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function postWorkflowFolders(payload: unknown): Promise<Response> {
  return await fetch('/dsh-node-flow/workflow-folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function readWorkflowResponse(response: Response, fallback: SavedWorkflow): Promise<SavedWorkflow> {
  const data = await response.json().catch(() => ({})) as { workflow?: SavedWorkflow; latest?: SavedWorkflow; error?: string }
  if (response.status === 409 && data.latest) throw new WorkflowConflictError(normalizeSavedWorkflow(data.latest))
  if (!response.ok || !data.workflow) throw new Error(data.error || `HTTP ${response.status}`)
  if (supportsWorkflowRevisions) return normalizeSavedWorkflow(data.workflow)
  const legacy = normalizeSavedWorkflow(data.workflow)
  return {
    ...legacy,
    revision: fallback.revision,
    draftRevision: fallback.draftRevision,
    publishedRevision: fallback.publishedRevision,
    publishedAt: fallback.publishedAt,
    publishedDoc: fallback.publishedDoc,
    updatedAt: fallback.updatedAt,
  }
}

type FolderMutationResponse = {
  folder?: WorkflowFolder
  folders?: WorkflowFolder[]
  workflows?: SavedWorkflow[]
  moved?: number
  latest?: WorkflowFolder
  error?: string
}

function normalizeFolders(value: unknown): WorkflowFolder[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeWorkflowFolder)
    .filter((folder): folder is WorkflowFolder => Boolean(folder))
}

async function readFolderMutationResponse(response: Response): Promise<FolderMutationResponse> {
  const data = await response.json().catch(() => ({})) as FolderMutationResponse
  if (response.status === 409 && data.latest) {
    const latest = normalizeWorkflowFolder(data.latest)
    if (latest) throw new WorkflowFolderConflictError(latest)
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

async function clearWorkflowSchedules(workflowId: string): Promise<void> {
  try {
    const response = await fetch('/dsh-node-flow/schedules', { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json() as { schedules?: Array<{ id?: string }> }
    const prefix = `workflow:${workflowId}:`
    const matches = (data.schedules ?? []).filter((schedule) => String(schedule.id ?? '').startsWith(prefix))
    await Promise.all(matches.map((schedule) => postSchedule({ action: 'clear', id: schedule.id }).catch(() => undefined)))
  } catch {
    /* The host reconciles schedules on the next confirmed publish action. */
  }
}

async function syncLegacySchedules(workflow: SavedWorkflow): Promise<void> {
  if (supportsWorkflowRevisions) return
  await clearWorkflowSchedules(workflow.id)
  if (workflow.status !== 'enabled') return
  const document = executionDocument(workflow)
  for (const node of document.nodes) {
    if (node.data.kind !== 'schedule' || !node.data.cron?.trim()) continue
    await postSchedule({
      id: `workflow:${workflow.id}:${node.id}`,
      workflowId: workflow.id,
      name: `${workflow.name} · ${node.data.label}`,
      cron: node.data.cron.trim(),
      timezone: node.data.timezone?.trim() || undefined,
      input: node.data.text ?? '',
      steps: [],
      doc: document,
    }).catch(() => undefined)
  }
}

export async function listSavedWorkflows(): Promise<SavedWorkflow[]> {
  const local = readLocal()
  try {
    const response = await fetch('/dsh-node-flow/workflows', { cache: 'no-store' })
    if (!response.ok) return sortWorkflows(local)
    const data = await response.json() as {
      workflows?: SavedWorkflow[]
      capabilities?: { directRun?: boolean; runWrites?: boolean; workflowRevisions?: boolean; workflowVersions?: boolean; workflowFolders?: boolean; workflowConcurrency?: boolean; persistentRunQueue?: boolean }
    }
    supportsDirectRun = data.capabilities?.directRun === true
    supportsRunWrites = data.capabilities?.runWrites === true
    supportsWorkflowRevisions = data.capabilities?.workflowRevisions === true
    supportsWorkflowVersions = data.capabilities?.workflowVersions === true
    supportsWorkflowFolders = data.capabilities?.workflowFolders === true
    const remote = (Array.isArray(data.workflows) ? data.workflows : []).map(normalizeSavedWorkflow)
    const localById = new Map(local.map((workflow) => [workflow.id, workflow]))
    const pendingUpserts = readPendingUpserts()
    const pendingDeletes = readPendingDeletes()
    const merged = new Map(remote.filter((workflow) => !pendingDeletes.has(workflow.id)).map((workflow) => [workflow.id, workflow]))

    for (const [id, expectedRevision] of pendingDeletes) {
      try {
        const result = await post({ action: 'delete', id, expectedRevision })
        if (result.ok || result.status === 404) setPendingDelete(id, null)
        if (result.status === 409) {
          const data = await result.json() as { latest?: SavedWorkflow }
          if (data.latest) merged.set(id, normalizeSavedWorkflow(data.latest))
          setPendingDelete(id, null)
        }
      } catch {
        /* Keep the tombstone and retry on the next list request. */
      }
    }

    for (const [id, expectedRevision] of pendingUpserts) {
      const workflow = localById.get(id)
      if (!workflow) {
        setPendingUpsert(id, null)
        continue
      }
      merged.set(id, workflow)
      if (!supportsWorkflowRevisions && workflow.status === 'enabled') continue
      try {
        const result = await post({ action: 'save', workflow, expectedRevision })
        if (result.status === 409) {
          const data = await result.json() as { latest?: SavedWorkflow }
          if (data.latest) merged.set(id, normalizeSavedWorkflow(data.latest))
          const copy = offlineConflictCopy(workflow)
          merged.set(copy.id, copy)
          setPendingUpsert(id, null)
          setPendingUpsert(copy.id, 0)
          continue
        }
        if (result.ok) {
          const saved = await readWorkflowResponse(result, workflow)
          merged.set(id, saved)
          setPendingUpsert(id, null)
        }
      } catch {
        /* Keep the local draft and its original expected version for retry. */
      }
    }

    const workflows = sortWorkflows([...merged.values()])
    writeLocal(workflows)
    return workflows
  } catch {
    return sortWorkflows(local)
  }
}

/** Folder metadata stays host-authoritative and is intentionally not browser-cached. */
export async function listWorkflowFolders(): Promise<WorkflowFolder[]> {
  try {
    const response = await fetch('/dsh-node-flow/workflow-folders', { cache: 'no-store' })
    if (!response.ok) {
      supportsWorkflowFolders = false
      return []
    }
    const data = await response.json().catch(() => ({})) as { folders?: unknown }
    supportsWorkflowFolders = true
    return normalizeFolders(data.folders)
  } catch {
    supportsWorkflowFolders = false
    return []
  }
}

export async function createSavedWorkflowFolder(name: string): Promise<{ folder: WorkflowFolder; folders: WorkflowFolder[] }> {
  const response = await postWorkflowFolders({ action: 'create', name })
  const data = await readFolderMutationResponse(response)
  const folder = normalizeWorkflowFolder(data.folder)
  if (!folder) throw new Error('服务器没有返回文件夹')
  return { folder, folders: normalizeFolders(data.folders) }
}

export async function renameSavedWorkflowFolder(folder: WorkflowFolder, name: string): Promise<{ folder: WorkflowFolder; folders: WorkflowFolder[] }> {
  const response = await postWorkflowFolders({ action: 'rename', id: folder.id, name, expectedRevision: folder.revision })
  const data = await readFolderMutationResponse(response)
  const saved = normalizeWorkflowFolder(data.folder)
  if (!saved) throw new Error('服务器没有返回文件夹')
  return { folder: saved, folders: normalizeFolders(data.folders) }
}

export async function deleteSavedWorkflowFolder(folder: WorkflowFolder, targetFolderId?: string): Promise<{ folders: WorkflowFolder[]; workflows: SavedWorkflow[]; moved: number }> {
  const pending = readPendingUpserts()
  const pendingInFolder = readLocal().some((workflow) => workflow.folderId === folder.id && pending.has(workflow.id))
  if (pendingInFolder) throw new Error('该文件夹含有尚未同步的草稿，请恢复网络并刷新后再删除')
  const response = await postWorkflowFolders({
    action: 'delete',
    id: folder.id,
    expectedRevision: folder.revision,
    ...(targetFolderId ? { targetFolderId } : {}),
  })
  const data = await readFolderMutationResponse(response)
  return {
    folders: normalizeFolders(data.folders),
    workflows: Array.isArray(data.workflows) ? data.workflows.map((workflow) => normalizeSavedWorkflow(workflow)) : [],
    moved: typeof data.moved === 'number' && Number.isFinite(data.moved) ? Math.max(0, Math.floor(data.moved)) : 0,
  }
}

export async function moveSavedWorkflowToFolder(workflow: SavedWorkflow, folderId?: string): Promise<SavedWorkflow> {
  const current = normalizeSavedWorkflow(workflow)
  if (readPendingUpserts().has(current.id)) throw new Error('工作流草稿尚未同步，请恢复网络并刷新后再移动')
  const expectedRevision = readPendingUpserts().get(current.id) ?? current.revision
  const response = await post({
    action: 'move-folder',
    id: current.id,
    expectedRevision,
    ...(folderId ? { folderId } : {}),
  })
  const saved = await readWorkflowResponse(response, current)
  replaceLocal(saved)
  return saved
}

export async function saveSavedWorkflow(workflow: SavedWorkflow): Promise<SavedWorkflow> {
  const current = normalizeSavedWorkflow(workflow)
  const isNew = workflow.revision <= 0
  const expectedRevision = isNew ? 0 : (readPendingUpserts().get(current.id) ?? current.revision)
  const candidate = isNew
    ? createSavedWorkflow(workflow, new Date().toISOString())
    : updateWorkflowDraft(current, workflow, new Date().toISOString())
  replaceLocal(candidate)
  setPendingDelete(candidate.id, null)
  setPendingUpsert(candidate.id, expectedRevision)

  if (!supportsWorkflowRevisions && current.status === 'enabled' && !isNew) return candidate
  let response: Response
  try {
    response = await post({ action: 'save', workflow: candidate, expectedRevision })
  } catch {
    return candidate
  }
  const saved = await readWorkflowResponse(response, candidate)
  replaceLocal(saved)
  setPendingUpsert(saved.id, null)
  return saved
}

export async function updateSavedWorkflowStatus(workflow: SavedWorkflow, status: WorkflowStatus): Promise<SavedWorkflow> {
  let current = normalizeSavedWorkflow(workflow)
  const pendingRevision = readPendingUpserts().get(current.id)
  if (pendingRevision !== undefined && supportsWorkflowRevisions) {
    const syncResponse = await post({ action: 'save', workflow: current, expectedRevision: pendingRevision })
    current = await readWorkflowResponse(syncResponse, current)
    replaceLocal(current)
    setPendingUpsert(current.id, null)
  }
  const candidate = publishWorkflow(current, status, new Date().toISOString())
  try {
    if (!supportsWorkflowRevisions) {
      const saveResponse = await post({ action: 'save', workflow: { ...candidate, doc: current.doc } })
      if (!saveResponse.ok) throw new Error(`HTTP ${saveResponse.status}`)
    }
    const response = await post({ action: 'status', id: current.id, status, expectedRevision: current.revision })
    const saved = await readWorkflowResponse(response, candidate)
    replaceLocal(saved)
    setPendingUpsert(saved.id, null)
    await syncLegacySchedules(saved)
    return saved
  } catch (error) {
    if (error instanceof WorkflowConflictError) throw error
    throw new Error(status === 'enabled' ? '发布失败，服务器未确认新版本' : '停用失败，服务器未确认状态')
  }
}

export async function listWorkflowVersions(workflow: SavedWorkflow): Promise<WorkflowVersion[]> {
  const current = normalizeSavedWorkflow(workflow)
  if (!supportsWorkflowVersions) return []
  const response = await fetch(`/dsh-node-flow/workflow-versions?workflowId=${encodeURIComponent(current.id)}`, { cache: 'no-store' })
  const data = await response.json().catch(() => ({})) as { workflow?: SavedWorkflow; versions?: WorkflowVersion[]; error?: string }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  if (data.workflow) replaceLocal(normalizeSavedWorkflow(data.workflow))
  return Array.isArray(data.versions) ? data.versions : []
}

export async function restoreSavedWorkflowVersion(workflow: SavedWorkflow, versionId: string, publish: boolean): Promise<SavedWorkflow> {
  const current = normalizeSavedWorkflow(workflow)
  const response = await fetch('/dsh-node-flow/workflow-versions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', id: current.id, versionId, publish, expectedRevision: current.revision }),
  })
  if (response.status === 409) {
    const data = await response.json().catch(() => ({})) as { latest?: SavedWorkflow }
    if (data.latest) throw new WorkflowConflictError(normalizeSavedWorkflow(data.latest))
  }
  const data = await response.json().catch(() => ({})) as { workflow?: SavedWorkflow; error?: string }
  if (!response.ok || !data.workflow) throw new Error(data.error || `HTTP ${response.status}`)
  const saved = normalizeSavedWorkflow(data.workflow)
  replaceLocal(saved)
  setPendingUpsert(saved.id, null)
  return saved
}

export async function saveWorkflowRun(run: WorkflowRunRecord): Promise<void> {
  writeLocalRuns([run, ...readLocalRuns().filter((candidate) => candidate.id !== run.id)])
  if (!supportsRunWrites) return
  try {
    await fetch('/dsh-node-flow/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', run }),
    })
  } catch {
    /* Run history is secondary to the workflow result shown in the editor. */
  }
}

export async function markWorkflowRun(workflow: SavedWorkflow, startedAt: string): Promise<SavedWorkflow> {
  const current = { ...normalizeSavedWorkflow(workflow), lastRunAt: startedAt }
  replaceLocal(current)
  if (supportsWorkflowRevisions) void post({ action: 'run-meta', id: current.id, startedAt }).catch(() => undefined)
  return current
}

export async function listWorkflowRuns(): Promise<WorkflowRunRecord[]> {
  const local = readLocalRuns()
  try {
    const response = await fetch('/dsh-node-flow/runs', { cache: 'no-store' })
    if (!response.ok) return local
    const data = await response.json() as { runs?: WorkflowRunRecord[]; writable?: boolean }
    supportsRunWrites = data.writable === true
    const merged = new Map<string, WorkflowRunRecord>()
    for (const run of [...local, ...(Array.isArray(data.runs) ? data.runs : [])]) merged.set(run.id, run)
    const runs = [...merged.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 50)
    writeLocalRuns(runs)
    return runs
  } catch {
    return local
  }
}

function summarizeLocalRun(run: WorkflowRunRecord): WorkflowRunSummary {
  const waitpoint = run.waitpoint
  return {
    id: run.id,
    workflowId: run.workflowId,
    scheduleId: run.scheduleId,
    name: run.name,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    nodeCount: run.nodeCount,
    status: run.status,
    trigger: run.trigger,
    failed: run.failed,
    timedOut: run.timedOut,
    limitReason: run.limitReason,
    handledErrors: run.handledErrors ?? 0,
    resumable: run.resumable,
    resumedFromRunId: run.resumedFromRunId,
    resumedByRunId: run.resumedByRunId,
    replayedFromRunId: run.replayedFromRunId,
    parentRunId: run.parentRunId,
    parentNodeId: run.parentNodeId,
    rootRunId: run.rootRunId,
    depth: run.depth,
    skipReason: run.skipReason,
    waitpoint: waitpoint ? {
      nodeId: waitpoint.nodeId,
      mode: waitpoint.mode,
      createdAt: waitpoint.createdAt,
      resumeAt: waitpoint.resumeAt,
      expiresAt: waitpoint.expiresAt,
      childRunId: waitpoint.childRunId,
      parentRunId: waitpoint.parentRunId,
      parentNodeId: waitpoint.parentNodeId,
    } : undefined,
    replayable: Boolean(run.replayInputAvailable && run.snapshot && !run.parentRunId && !run.resumedFromRunId && (run.trigger === 'manual' || run.trigger === 'replay')),
  }
}

export async function listWorkflowRunSummaries(): Promise<WorkflowRunSummary[]> {
  try {
    const response = await fetch('/dsh-node-flow/runs?view=summary', { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json() as { runs?: WorkflowRunSummary[]; writable?: boolean }
    supportsRunWrites = data.writable === true
    if (!Array.isArray(data.runs)) return []
    return [...data.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 200)
  } catch {
    return readLocalRuns().map(summarizeLocalRun).sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 50)
  }
}

/** Audit history remains host-authoritative and is intentionally never browser-cached. */
export async function listWorkflowAuditEvents(options: { limit?: number; targetType?: WorkflowAuditTargetType } = {}): Promise<WorkflowAuditEvent[]> {
  const search = new URLSearchParams()
  if (options.limit !== undefined) search.set('limit', String(options.limit))
  if (options.targetType) search.set('targetType', options.targetType)
  const suffix = search.size ? `?${search.toString()}` : ''
  const response = await fetch(`/dsh-node-flow/audit-log${suffix}`, { cache: 'no-store' })
  const data = await response.json().catch(() => ({})) as { events?: WorkflowAuditEvent[]; error?: string }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return Array.isArray(data.events) ? data.events : []
}

export async function getWorkflowRunDetail(id: string): Promise<WorkflowRunRecord> {
  const response = await fetch(`/dsh-node-flow/runs?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
  const data = await response.json().catch(() => ({})) as { run?: WorkflowRunRecord; error?: string }
  if (!response.ok || !data.run) throw new Error(data.error || `HTTP ${response.status}`)
  return data.run
}

export async function runSavedWorkflow(workflow: SavedWorkflow, runId?: string, signal?: AbortSignal, input?: unknown): Promise<{ workflow: SavedWorkflow; run: WorkflowRunRecord }> {
  const current = normalizeSavedWorkflow(workflow)
  const document = executionDocument(current)
  const rawInput = input === undefined && document.inputs?.length ? {} : input
  const validatedInput = validateWorkflowContract(rawInput, document.inputs, '运行输入')
  if (supportsDirectRun) {
    const response = await post({ action: 'run', id: current.id, runId, input: validatedInput }, signal)
    const data = await response.json().catch(() => ({})) as { workflow?: SavedWorkflow; run?: WorkflowRunRecord; error?: string }
    if ((!response.ok && response.status !== 429) || !data.workflow || !data.run) throw new Error(data.error || `HTTP ${response.status}`)
    const saved = supportsWorkflowRevisions
      ? normalizeSavedWorkflow(data.workflow)
      : { ...current, lastRunAt: data.workflow.lastRunAt }
    replaceLocal(saved)
    writeLocalRuns([data.run, ...readLocalRuns().filter((candidate) => candidate.id !== data.run?.id)])
    return { workflow: saved, run: data.run }
  }

  const temporaryId = `dashboard-run:${current.id}:${Date.now().toString(36)}`
  try {
    const createResponse = await postSchedule({
      id: temporaryId,
      workflowId: current.id,
      name: current.name,
      cron: '0 0 1 1 *',
      input: validatedInput,
      steps: [],
      doc: document,
    })
    if (!createResponse.ok) throw new Error(`HTTP ${createResponse.status}`)
    const runResponse = await postSchedule({ action: 'run', id: temporaryId })
    const runData = await runResponse.json() as { run?: WorkflowRunRecord; error?: string }
    if ((!runResponse.ok && runResponse.status !== 429) || !runData.run) throw new Error(runData.error || `HTTP ${runResponse.status}`)
    const run = { ...runData.run, workflowId: current.id, name: current.name }
    const saved = { ...current, lastRunAt: run.startedAt }
    replaceLocal(saved)
    await saveWorkflowRun(run)
    return { workflow: saved, run }
  } finally {
    await postSchedule({ action: 'clear', id: temporaryId }).catch(() => undefined)
  }
}

export async function cancelWorkflowRun(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await post({ action: 'cancel', runId })
    if (response.ok) return
    if (response.status !== 404) throw new Error(`HTTP ${response.status}`)
    if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 75))
  }
}

export async function resumeWorkflowRun(run: Pick<WorkflowRunRecord, 'id'>, runId?: string, signal?: AbortSignal): Promise<WorkflowRunRecord> {
  const response = await fetch('/dsh-node-flow/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'resume', id: run.id, runId }),
    signal,
  })
  const data = await response.json().catch(() => ({})) as { run?: WorkflowRunRecord; error?: string }
  if ((!response.ok && response.status !== 429) || !data.run) throw new Error(data.error || `HTTP ${response.status}`)
  writeLocalRuns([data.run, ...readLocalRuns().filter((candidate) => candidate.id !== data.run?.id)])
  return data.run
}

export async function replayWorkflowRun(run: Pick<WorkflowRunRecord, 'id'>, runId?: string, signal?: AbortSignal): Promise<WorkflowRunRecord> {
  const response = await postRun({ action: 'replay', id: run.id, runId }, signal)
  const data = await response.json().catch(() => ({})) as { run?: WorkflowRunRecord; error?: string }
  if ((!response.ok && response.status !== 429) || !data.run) throw new Error(data.error || `HTTP ${response.status}`)
  writeLocalRuns([data.run, ...readLocalRuns().filter((candidate) => candidate.id !== data.run?.id)])
  return data.run
}

export async function createWaitpointCallbackToken(runId: string): Promise<{ callbackUrl: string; token: string }> {
  const response = await postRun({ action: 'create-wait-token', id: runId })
  const data = await response.json().catch(() => ({})) as { callbackUrl?: string; token?: string; error?: string }
  if (!response.ok || !data.callbackUrl || !data.token) throw new Error(data.error || `HTTP ${response.status}`)
  return { callbackUrl: data.callbackUrl, token: data.token }
}

export async function resolveWorkflowApproval(runId: string, decision: 'approved' | 'rejected', note: string): Promise<WorkflowRunRecord> {
  const response = await postRun({ action: 'resolve-waitpoint', id: runId, decision, note })
  const data = await response.json().catch(() => ({})) as { run?: WorkflowRunRecord; error?: string }
  if (!response.ok || !data.run) throw new Error(data.error || `HTTP ${response.status}`)
  return data.run
}

export async function deleteSavedWorkflow(workflow: SavedWorkflow): Promise<void> {
  const current = normalizeSavedWorkflow(workflow)
  const expectedRevision = readPendingUpserts().get(current.id) ?? current.revision
  writeLocal(readLocal().filter((candidate) => candidate.id !== current.id))
  setPendingUpsert(current.id, null)
  setPendingDelete(current.id, expectedRevision)
  await clearWorkflowSchedules(current.id)
  let response: Response
  try {
    response = await post({ action: 'delete', id: current.id, expectedRevision })
  } catch {
    return
  }
  if (response.status === 409) {
    const data = await response.json() as { latest?: SavedWorkflow }
    if (data.latest) {
      const latest = normalizeSavedWorkflow(data.latest)
      replaceLocal(latest)
      setPendingDelete(current.id, null)
      throw new WorkflowConflictError(latest)
    }
  }
  if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`)
  setPendingDelete(current.id, null)
}

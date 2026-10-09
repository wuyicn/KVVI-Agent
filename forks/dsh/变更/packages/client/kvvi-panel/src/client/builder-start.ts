import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

interface BuilderSteps<Workspace, Session> {
  createDirectory: (parent: string, name: string) => Promise<string>
  createWorkspace: (path: string) => Promise<Workspace>
  createSession: (workspace: Workspace) => Promise<Session>
  send: (session: Session, text: string, requestId: string) => Promise<void>
}
/**
 * @param steps - original directory, workspace and session capabilities.
 * @returns a starter retaining successful phases by intent for this UI lifetime.
 * Failed sends reuse the request ID; arbitrary pre-existing directories are never adopted.
 */
export function createBuilderStarter<Workspace, Session>(steps: BuilderSteps<Workspace, Session>) {
  const operations = new Map<string, {
    input: string
    path?: string
    workspace?: Workspace
    session?: Session
    requestId: string
    done: boolean
    pending?: Promise<void>
  }>()
  return async (parent: string, name: string, purpose: string, intentId: string): Promise<void> => {
    const input = JSON.stringify([parent, name, purpose])
    let operation = operations.get(intentId)
    if (operation !== undefined && operation.input !== input) throw new Error('KVVI_BUILD_INPUT_CHANGED')
    if (operation === undefined) {
      operation = { input, requestId: randomUUID(), done: false }
      operations.set(intentId, operation)
    }
    if (operation.done) return
    if (operation.pending !== undefined) return operation.pending
    const state = operation
    const run = async () => {
      state.path ??= await steps.createDirectory(parent, name)
      state.workspace ??= await steps.createWorkspace(state.path)
      state.session ??= await steps.createSession(state.workspace)
      const text = `请搭建业务“${name}”。需求：${purpose}。先确认表单与业务流程，再按搭建规范生成，发布前交给我检查。`
        + `本次搭建意图编号为 ${intentId}，提交 publish_submit 时将它原样填入 buildIntentId。`
        + '请将确认的资产代号写入工作区 .kvvi-system.json 的 assetId 字段。不得自行审批或发布。'
      await steps.send(state.session, text, state.requestId)
      state.done = true
    }
    state.pending = run()
    try { await state.pending } finally { delete state.pending }
  }
}

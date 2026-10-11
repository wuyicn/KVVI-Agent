import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

interface BuilderSteps<Workspace, Session> {
  createDirectory: (intentId: string) => Promise<string>
  createWorkspace: (path: string, name: string) => Promise<Workspace>
  createSession: (workspace: Workspace) => Promise<Session>
  send: (session: Session, text: string, requestId: string) => Promise<void>
}
/**
 * @param steps - managed directory, workspace and session capabilities.
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
  return async (name: string, intentId: string): Promise<void> => {
    const input = name
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
      state.path ??= await steps.createDirectory(intentId)
      state.workspace ??= await steps.createWorkspace(state.path, name)
      state.session ??= await steps.createSession(state.workspace)
      const text = `请和我一起搭建业务。暂定名称：${JSON.stringify(name)}。先问我想管理什么业务，再一起确认表单、需要的字段和字段类型。名称可以稍后确定，需求确认前不要生成；只用业务语言交流，发布前交给我检查。`
        + `本次搭建意图编号为 ${intentId}，提交 publish_submit 时将它原样填入 buildIntentId。`
        + '请将确认的资产代号写入工作区 .kvvi-system.json 的 assetId 字段。不得自行审批或发布。'
      await steps.send(state.session, text, state.requestId)
      state.done = true
    }
    state.pending = run()
    try { await state.pending } finally { delete state.pending }
  }
}

/** Business-facing projection only; raw events remain available in diagnostics. */
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ToolCallBlock } from '../contract/snapshot.ts'
import type { ChatKey } from '../locale.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'

/**
 * @param text - unmodified logged input.
 * @param t - current conversation translator.
 * @returns business copy only for the exact generated builder templates.
 */
export function businessRequestText(text: string, t: ChatViewSlotProps['t']): string {
  if (/^请协助编辑现有表单，资产代号为 [\w.-]+。先检查本工作区契约是否属于这个资产，不一致时停止并请我确认。只修改草稿，不改员工正在使用的已发布版本；提交前交给我检查，仍由所有者审批发布。$/u.test(text)) {
    return t('business.editRequest')
  }
  const generated = new RegExp(
    String.raw`^((?:请搭建业务“[^\n]+”。需求：[\s\S]*。先确认表单与业务流程，再按搭建规范生成，发布前交给我检查。|请和我一起搭建业务。暂定名称：[^\n]*。先问我想管理什么业务，再一起确认表单、需要的字段和字段类型。名称可以稍后确定，需求确认前不要生成；只用业务语言交流，发布前交给我检查。))`
    + String.raw`本次搭建意图编号为 [\w-]+，提交 publish_submit 时将它原样填入 buildIntentId。`
    + String.raw`请将确认的资产代号写入工作区 \.kvvi-system\.json 的 assetId 字段。不得自行审批或发布。$`, 'u',
  ).exec(text)?.[1]
  return generated === undefined ? text : generated + t('business.ownerApproval')
}

/**
 * @param kind - projected node kind.
 * @returns whether the node belongs only in diagnostics.
 */
export function isBusinessHiddenNode(kind: string): boolean {
  return ['context', 'system-prompt', 'turn-process', 'compaction', 'manual-compaction', 'unknown'].includes(kind)
}

/**
 * @param code - producer-owned error code, when present.
 * @returns a localized business failure category without inventing rollback.
 */
export function businessFailureKey(code?: string): ChatKey {
  if (code === 'KVVI_NOT_ALLOWED') return 'business.permissionDenied'
  if (code === 'KVVI_SESSION_REQUIRED' || code === 'KVVI_SESSION_EXPIRED') return 'business.signInAgain'
  if (code === 'TIMEOUT' || code === 'TRANSPORT') return 'business.connectionFailed'
  if (code === 'KVVI_PLATFORM_UNREACHABLE') return 'business.connectionFailed'
  if (code === 'KVVI_NOT_FOUND' || code === 'KVVI_RECORD_NOT_FOUND') return 'business.notFound'
  if (code === 'KVVI_ROW_VERSION_CONFLICT') return 'business.conflict'
  return 'business.failed'
}

function failedToolCode(root: ToolCallBlock): string | undefined {
  if (!('kind' in root) || !root.isError) return undefined
  if (root.error?.code !== undefined) return root.error.code
  // Historical KVVI tools throw ordinary Error values, serialized by tools as
  // a single "Error: CODE: detail" text block. Never inspect success payloads.
  const first = root.content[0]
  return first?.type === 'text' ? /^Error: (KVVI_[A-Z_]+)(?::| \(HTTP [0-9]{3}\)$|$)/u.exec(first.text)?.[1] : undefined
}

function hasNestedFailure(root: ToolCallBlock): boolean {
  const pending = [...root.subCalls]
  while (pending.length > 0) {
    const child = pending.pop()
    if (child === undefined) continue
    if ('kind' in child && child.isError) return true
    pending.push(...child.subCalls)
  }
  return false
}

/**
 * @param node - one projected chat node.
 * @returns a business notice for failures and retries, otherwise undefined.
 */
export function businessNodeNotice(node: ChatNode): ChatKey | undefined {
  if (node.kind === 'turn-error') return businessFailureKey(node.data.code)
  if (node.kind === 'turn-max-tokens') return 'business.incomplete'
  if (node.kind === 'model-retry') return node.data.current.retryState === 'scheduled' ? 'business.retrying' : 'business.retried'
  if (node.kind === 'tool-call') {
    const root = node.data.root
    if ('kind' in root && root.isError) return businessFailureKey(failedToolCode(root))
    if (hasNestedFailure(root)) return 'business.partialFailure'
  }
  return undefined
}

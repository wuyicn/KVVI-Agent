/**
 * `kvvi-publish` —— 搭建者**提交发布**的那一步。
 *
 * ── 为什么这个包存在 ────────────────────────────────────────────────────
 *
 * 发布通道的注释把两半分得很清楚：
 *
 *     | Step | Who | Where |
 *     |---|---|---|
 *     | Submit (with the contracts) | the builder | **the agent / the CLI scaffold** |
 *     | Approve + publish | the owner | 企业管理 → 发布 |
 *
 * 而**「the agent」那一半此前没有实现**：搭建者的工作台没有提交按钮（浏览器
 * 读不到工作区的契约文件），他的工具集里也没有发布工具。于是「搭出来的系统
 * 怎么上去」只剩 CLI 脚手架一条路 —— 一句写在注释里的承诺，产品里对应不上。
 *
 * 这一侧是**唯一**能同时满足两件事的位置：
 *   · **读得到契约**：工具跑在运行时里，工作区就在它手上（`session.header.cwd`）；
 *   · **不自审批**：提交只用本会话的 BUILDER 身份，审批与发布仍在所有者那边
 *     （§9.6.1，服务端各自判）。
 *
 * ── 提交是不可逆的，所以要一次确认 ──────────────────────────────────────
 *
 * 本包同时挂一条 `tools/pre-execute` 闸：`publish_submit` 一律回 `{kind:'ask'}`，
 * 由用户在界面上按下确认才继续。**这不是礼貌** —— 提交之后草案就进了通道，
 * 所有者会看到它；而 `ask` 在没有人应答时是**拒绝**（fail closed），
 * 所以「没人在场就静默提交」不会发生。
 *
 * @module @deepseek-ai/dsh-tool-kvvi-publish
 */
import { readFileSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-kvvi-mode-router'
import { refusalMessage, request } from './client.ts'
import type { CallContext } from './client.ts'

export const name = 'kvvi-publish'
export const inject = ['tools', 'kvviModeRouter']

/** Deployment configuration for the publish tool. */
export interface Config {
  /** Base URL of the KVVI platform service (no trailing `/api/v1`). */
  platformUrl: string
  /** Shared runtime-context secret; identical in both processes. */
  contextSecret: string
}

/** Schemastery configuration for the publish tool. */
export const Config: z<Config> = z.object({
  platformUrl: z.string().required(),
  contextSecret: z.string().required(),
})

/**
 * 六份契约。与平台的 `PUBLISH_CONTRACTS`、与 `runtime-projection` 的
 * `REQUIRED_CONTRACTS` 同一套 —— 少一份就不是可运行系统，平台会拒。
 */
export const CONTRACT_TYPES = [
  'business-schema', 'view-schema', 'workflow-spec',
  'permission-spec', 'tool-spec', 'app-model-command',
] as const

/**
 * 从文件名认契约种类。
 *
 * ⚠️ 与 `工具/发布脚手架.py` 的 `FILENAME_HINTS` **同一套**：认法在两处漂移的
 * 表现是「CLI 能发、工具发不了」（或反过来），而两边都只报「缺某一份」。
 * 顺序有意义：先认更具体的（`搭建命令` 里也含 `命令`）。
 */
const FILENAME_HINTS: readonly (readonly [string, string])[] = [
  ['app-model-command', '搭建命令'],
  ['business-schema', 'business-schema'],
  ['view-schema', 'view-schema'],
  ['workflow-spec', 'workflow-spec'],
  ['permission-spec', 'permission-spec'],
  ['tool-spec', '工具'],
]

/**
 * 相对契约目录的路径。报注记时用它，读文件时用绝对路径。
 * @param tree - 契约目录的绝对路径。
 * @param path - 文件或目录的绝对路径。
 * @returns 相对路径。
 */
function relativeOf(tree: string, path: string): string {
  return relative(tree, path)
}

/** 一次提交的结果。 */
export interface SubmitResult {
  readonly draftId: string
  readonly status: string
  readonly reused: boolean
  readonly changed: { added?: number; removed?: number; modified?: number }
  readonly notes: string[]
}

/** 平台草案端点的响应。 */
interface DraftResponse {
  draftId?: string
  status?: string
  reused?: boolean
  diffReport?: { summary?: { added?: number; removed?: number; modified?: number } }
}

/**
 * 整目录跳过的判据 —— **全仓唯一一份**。
 *
 * 它由两个读者共用：真正决定读哪些文件的 {@link scanContractTree}，以及
 * 把「跳过了什么」写成注记的那一处。两处各写一份判断的话，改了一边另一边
 * 不跟着改，表现就是**注记说跳过了、实际却读进去了**（或反过来）—— 而两种
 * 方向都只报「缺某一份契约」，看不出是判据漂移。
 *
 * @param entry - 一个目录项的名字（不是路径）。
 * @returns 跳过它的理由；不跳过返回 `undefined`。
 */
function skipReason(entry: string): string | undefined {
  // 校验环境不是交付物：它装着套件自己的夹具与结果，混进契约里会
  // 让「六份」变成「六份加一堆」。
  if (entry === '_校验' || entry === '_校验环境' || entry === 'fixture') {
    return '校验环境（夹具与结果），不是交付物'
  }
  if (entry === 'schemas') {
    return '工具契约引用的请求/响应体片段，它们本身不是契约'
  }
  if (entry.startsWith('.')) return '隐藏目录'
  return undefined
}

/**
 * 一个被整目录跳过的子树。
 */
export interface SkippedDir {
  /** 相对契约目录的路径。 */
  readonly path: string
  /** 跳过它的理由。 */
  readonly reason: string
  /** 这个子树里有多少个 `.json`（用户要凭这个数字知道丢了多少）。 */
  readonly files: number
}

/**
 * 数一个子树里有多少 `.json`。
 *
 * 注记里只写「跳过了 `06-工具/schemas`」的话，搭建者不知道那是 1 份还是 30 份，
 * 也就没法判断该不该在意 —— 而这一条注记的全部用处就是这个判断。
 *
 * @param dir - 目录的绝对路径。
 * @returns 该子树下 `.json` 文件的个数（含更深层）。
 */
function countJsonFiles(dir: string): number {
  let count = 0
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    const info = lstatSync(path)
    if (info.isSymbolicLink()) throw new Error('KVVI_CONTRACT_SYMLINK_UNSUPPORTED')
    if (info.isDirectory()) count += countJsonFiles(path)
    else if (entry.endsWith('.json')) count += 1
  }
  return count
}

// UTF-8字节序与CLI一致，避免JS的UTF-16默认排序在非BMP文件名上漂移。
function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * 走一遍契约目录：认出六份契约，并记下整目录跳过了什么。
 *
 * 一次遍历同时产出两者 —— 跳过的记法必须来自**正在读的那一遍**，
 * 不能另写一遍「顺便看看跳过了谁」。
 *
 * @param tree - 契约目录的绝对路径。
 * @returns 每个契约种类下的文件路径（按名字排序，稳定），以及被跳过的子树。
 */
export function scanContractTree(tree: string): {
  found: Record<string, string[]>
  skipped: SkippedDir[]
} {
  const out: Record<string, string[]> = {}
  const skipped: SkippedDir[] = []
  for (const type of CONTRACT_TYPES) out[type] = []
  try {
    if (lstatSync(tree).isSymbolicLink()) throw new Error('KVVI_CONTRACT_SYMLINK_UNSUPPORTED')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  try {
    readdirSync(tree)
  } catch {
    // 目录不存在（还没建契约）时返回全空 —— 调用方按「缺哪几份」报，不在这里猜。
    return { found: out, skipped }
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry)
      if (lstatSync(path).isSymbolicLink()) throw new Error('KVVI_CONTRACT_SYMLINK_UNSUPPORTED')
      if (statSync(path).isDirectory()) {
        const reason = skipReason(entry)
        if (reason !== undefined) {
          // ⚠️ **跳过了就要说出来。** 从前这里是直接 `continue`：`schemas/` 下
          //    8 份文件被整块丢掉，注记里一个字都没有 —— 而同一批里
          //    `03-客户列表-view-schema.json` 被丢下是逐条点了名的。
          //    同一类事情两种处理，搭建者就分不清「这个目录不重要」和
          //    「这个目录被吃了」。
          skipped.push({ path: relativeOf(tree, path), reason, files: countJsonFiles(path) })
          continue
        }
        walk(path)
        continue
      }
      if (!entry.endsWith('.json')) continue
      // ⚠️ **判据是相对路径，不只是文件名。**
      //
      // 工具契约在 `06-工具/` 目录下，而文件名本身（`customer_assign.json`）
      // 里没有任何线索 —— 只看文件名的话这一类**永远认不出来**，
      // 而报错是「目录里找不到对应的文件」，看起来像文件不存在。
      // 这一条与 `工具/发布脚手架.py` 的 `contract_files` 同一判据。
      //
      // `schemas/` 也要排除：那是工具契约引用的请求/响应体片段，
      // 混进 `{tools: [...]}` 会得到 8 份没有 `tool_code` 的东西。
      const relative = relativeOf(tree, path)
      for (const [type, hint] of FILENAME_HINTS) {
        if (relative.includes(hint)) {
          out[type]?.push(path)
          break
        }
      }
    }
  }
  walk(tree)
  for (const paths of Object.values(out)) paths.sort(comparePaths)
  skipped.sort((a, b) => comparePaths(a.path, b.path))
  return { found: out, skipped }
}

/**
 * 契约目录里有哪些文件。
 *
 * @param tree - 契约目录的绝对路径。
 * @returns 每个契约种类下的文件路径（按名字排序，稳定）。
 */
export function contractFiles(tree: string): Record<string, string[]> {
  return scanContractTree(tree).found
}

/**
 * 读出六份契约，并说明装订时丢下了什么。
 *
 * 装订约定与 `工具/发布脚手架.py` 的 `read_contracts` 一致 —— 两处必须同源，
 * 否则同一次构建经由 CLI 与经由 Agent 会发上去**不同的东西**。
 *
 * @param tree - 契约目录。
 * @returns `{contracts, notes}`；`notes` 里逐条写出「用了哪份、丢下了什么」，
 *   末尾再逐条写出「整目录跳过了哪些」—— 后者也是丢掉的东西，只是丢在目录粒度上。
 */
export function readContracts(tree: string): { contracts: Record<string, unknown>; notes: string[] } {
  const { found, skipped } = scanContractTree(tree)
  for (const type of CONTRACT_TYPES) {
    const paths = found[type] ?? []
    if (type !== 'tool-spec' && paths.length > 1) {
      throw new Error(`KVVI_CONTRACT_MULTIPLE_UNSUPPORTED: ${type}：${paths.map(p => relativeOf(tree, p)).join('、')}`)
    }
  }
  const contracts: Record<string, unknown> = {}
  const notes: string[] = []
  for (const type of CONTRACT_TYPES) {
    const paths = found[type] ?? []
    if (paths.length === 0) {
      notes.push(`✗ ${type}：目录里找不到对应的文件`)
      continue
    }
    if (paths.length === 1 || type === 'tool-spec') {
      if (type === 'tool-spec' && paths.length > 1) {
        contracts[type] = { tools: paths.map(p => JSON.parse(readFileSync(p, 'utf8')) as unknown) }
        notes.push(`⚠ tool-spec：${String(paths.length)} 份单工具契约，按 {tools: [...]} 装订`)
      } else {
        contracts[type] = JSON.parse(readFileSync(paths[0] ?? '', 'utf8')) as unknown
      }
      continue
    }
  }
  // ⚠️ 整目录跳过也逐条说。它们和上面「丢下的」是同一件事 —— 目录里**有什么没发上去** ——
  //    只是粒度是目录而不是文件。分开报的理由是粒度和理由都不同，不是因为它更次要。
  for (const dir of skipped) {
    notes.push(`⚠ 整目录跳过：${dir.path}（${String(dir.files)} 个 .json）`
      + ` —— ${dir.reason}`)
  }
  return { contracts, notes }
}

/**
 * 这个会话的工作区。
 *
 * 取的是 `session.header.cwd` —— 与 `tool-bash`/`tool-fs` 同一个来源。
 * 自己另找一个「工作区」的概念会让工具和文件工具指向不同的目录。
 *
 * @param agent - the agent owning this call.
 * @returns 绝对路径；会话没有 cwd 时为 `undefined`。
 */
function workspaceOf(agent: Agent | undefined): string | undefined {
  const cwd = agent?.session.header.cwd
  return cwd === undefined || cwd === '' ? undefined : resolve(cwd)
}

/**
 * 契约目录：显式给的优先，否则 `<工作区>/契约`。
 *
 * ⚠️ **只允许在工作区之内**。模型给一个 `/etc` 进来，这个工具就会把系统目录
 * 当契约读 —— 而它有读文件的权限（`readContracts` 在进程里跑）。
 * 越界一律拒，不「规范化成工作区内的路径」。
 *
 * @param agent - the agent owning this call.
 * @param requested - the model-supplied directory, if any.
 * @returns 绝对路径。
 * @throws {Error} 没有工作区，或目录落在工作区之外。
 */
export function resolveContractsDir(agent: Agent | undefined, requested?: string): string {
  const workspace = workspaceOf(agent)
  if (workspace === undefined) {
    throw new Error('KVVI_WORKSPACE_REQUIRED: 这个会话没有工作区，无法读契约')
  }
  const target = requested === undefined || requested === ''
    ? join(workspace, '契约')
    : resolve(workspace, requested)
  if (target !== workspace && !target.startsWith(workspace + sep)) {
    throw new Error('KVVI_WORKSPACE_ESCAPE: 契约目录必须在工作区内')
  }
  let current = workspace
  for (const part of relative(workspace, target).split(sep).filter(Boolean)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('KVVI_CONTRACT_SYMLINK_UNSUPPORTED')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break
      throw error
    }
  }
  return target
}

/**
 * Host plugin body.
 * @param ctx - the plugin context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // 身份**只**来自模式路由验过的那个会话；这里不接受、也不推导任何别的身份。
  const context = (): CallContext => ({
    mode: ctx.kvviModeRouter.requireMode(),
    baseUrl: config.platformUrl.replace(/\/+$/u, ''),
    secret: config.contextSecret,
  })

  ctx.tools.register(defineTool({
    name: 'publish_submit',
    description: '提交一次发布：把工作区里的六份契约交给平台，形成一张**待所有者审批**的发布草案。'
      + '这一步之后草案就进了通道，所有者会看到它；改内容要重新提交一版。'
      + '调用前先把「将提交哪六份、装订时丢下了什么」讲给用户，得到明确的确认再调 —— '
      + '本工具还会弹一次确认面板，不要在没跟用户说过的情况下直接调。'
      + '**只提交，不审批、不发布**：那是所有者的动作（§9.6.1，提交人不能批自己那一份）。',
    parameters: {
      system: {
        type: 'string', required: true,
        description: '系统代号（`assetId`）。员工与所有者按这个代号看到系统。',
      },
      name: { type: 'string', description: '系统显示名。缺省用平台已有的名字。' },
      buildIntentId: {
        type: 'string',
        description: '新建表单时给定的搭建意图编号，原样传回。用于发布后归入用户选择的分组；编辑已有表单时不传。',
      },
      contractsDir: {
        type: 'string',
        description: '契约目录，相对工作区。缺省 `契约`。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draftId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          reused: { type: 'boolean', required: true },
          changed: { type: 'object', required: true, additionalProperties: true },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.reused
          ? `同一份变更已经有一张开着的草案，继续用它：${value.draftId}（${value.status}）`
          : `已提交草案 ${value.draftId}（${value.status}）。等所有者审批与发布。`,
      }],
    },
    execute: async (args, exec) => {
      const dir = resolveContractsDir(exec.agent, args.contractsDir)
      const { contracts, notes } = readContracts(dir)
      const missing = CONTRACT_TYPES.filter(type => contracts[type] === undefined)
      // 少一份就**不发** —— 平台也会拒（`KVVI_PUBLISH_CONTRACTS_INCOMPLETE`），
      // 但在这里先说清楚缺的是哪一份，比让平台回一个码更有用。
      if (missing.length > 0) {
        throw new Error(`KVVI_PUBLISH_CONTRACTS_INCOMPLETE: 缺 ${missing.join('、')}（在 ${dir}）`)
      }
      const body: Record<string, unknown> = { assetId: args.system, contracts }
      if (args.buildIntentId !== undefined) body['buildIntentId'] = args.buildIntentId
      if (args.name !== undefined && args.name !== '') body['name'] = args.name
      const result = await request<DraftResponse>(context(), 'POST', '/publish/drafts', body)
      if (!result.ok) throw new Error(refusalMessage(result))
      const value = result.value
      if (typeof value.draftId !== 'string' || value.draftId === '') {
        // 没有草案 id 就说「成功了」的话，下一步（让所有者去审批）会指向一个
        // 不存在的东西。宁可在这里失败。
        throw new Error('KVVI_PUBLISH_NO_DRAFT_ID: 平台没有回草案 id')
      }
      return {
        draftId: value.draftId,
        status: typeof value.status === 'string' ? value.status : 'AWAITING_APPROVAL',
        reused: value.reused === true,
        changed: value.diffReport?.summary ?? {},
        notes,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Submit ${args.system} for approval`,
      // `edit` 而不是 `write`：`ToolCallKind` 里没有 `write`（它只有
      // read/edit/delete/move/search/execute/fetch/other）。提交改的是
      // **平台的发布状态**，最接近的是 edit。
      kind: 'edit',
    }),
  }))

  // ★ **提交是不可逆的，所以它过一次确认面板。**
  //
  // `ask` 在没有应答者时是**拒绝**（`dsh-user-approval` 的 fail-closed 语义），
  // 所以「没人在场就静默提交」不会发生 —— 这正是这里要的。
  // 只对这一个工具这样做：闸门放宽到所有工具，用户很快就会学会无脑点确认。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'publish_submit') return await next()
    return {
      kind: 'ask',
      reason: '提交发布草案：这份契约会进入发布通道，所有者将看到它并决定是否发布。',
    }
  })
}

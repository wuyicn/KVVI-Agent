import type { LucideIcon } from 'lucide-react'
import {
  AlarmClock,
  Blocks,
  Bot,
  Braces,
  CirclePlay,
  Database,
  Globe2,
  GitBranch,
  Hourglass,
  ListTree,
  Network,
  NotepadText,
  PackageCheck,
  Repeat2,
  RadioTower,
  RotateCw,
  Webhook,
} from 'lucide-react'
import type { CSSProperties } from 'react'
import type { WorkflowNodeType } from '../model.js'

export type NodeCatalogItem = {
  kind: WorkflowNodeType
  label: string
  description: string
  group: '触发器' | '执行' | '流程控制' | '辅助'
  color: string
  icon: LucideIcon
  keywords: string
}

export const NODE_CATALOG: NodeCatalogItem[] = [
  {
    kind: 'trigger',
    label: '手动触发',
    description: '从一段输入文本启动工作流',
    group: '触发器',
    color: '#22a06b',
    icon: CirclePlay,
    keywords: 'trigger start input 手动 开始 输入',
  },
  {
    kind: 'schedule',
    label: '定时触发',
    description: '使用 Cron 按计划运行工作流',
    group: '触发器',
    color: '#d97706',
    icon: AlarmClock,
    keywords: 'schedule cron timer 定时 计划',
  },
  {
    kind: 'webhook',
    label: 'Webhook',
    description: '通过外部 HTTP 请求触发已发布工作流',
    group: '触发器',
    color: '#2563a8',
    icon: Webhook,
    keywords: 'webhook http api trigger 外部 触发 回调',
  },
  {
    kind: 'connector-trigger',
    label: '应用触发器',
    description: '轮询应用并在新事件到达时运行',
    group: '触发器',
    color: '#0f8f83',
    icon: RadioTower,
    keywords: 'connector polling trigger event app 轮询 事件 应用 触发器',
  },
  {
    kind: 'agent',
    label: 'DSH Agent',
    description: '调用模型执行需要推理的任务',
    group: '执行',
    color: '#7c5ce7',
    icon: Bot,
    keywords: 'agent ai model subagent 模型 智能体',
  },
  {
    kind: 'call-workflow',
    label: '调用工作流',
    description: '执行另一个已发布工作流并返回结果',
    group: '执行',
    color: '#4f75d8',
    icon: Network,
    keywords: 'call workflow subworkflow reusable child 调用 子流程 复用',
  },
  {
    kind: 'connector',
    label: '应用连接器',
    description: '调用 GitHub、Slack、Notion 等应用动作',
    group: '执行',
    color: '#d05b36',
    icon: Blocks,
    keywords: 'connector app piece integration github slack notion 连接器 应用 集成',
  },
  {
    kind: 'data-store',
    label: 'Data Store',
    description: '在 DSH 主机加密保存工作流状态',
    group: '执行',
    color: '#467a9c',
    icon: Database,
    keywords: 'data store state key value persistence kv 数据 存储 状态 键值 持久化',
  },
  {
    kind: 'wait',
    label: '等待',
    description: '延迟、等待外部回调或人工审批',
    group: '流程控制',
    color: '#8f6a2f',
    icon: Hourglass,
    keywords: 'wait delay callback approval pause 等待 延迟 回调 审批',
  },
  {
    kind: 'code',
    label: '代码执行',
    description: '运行 TypeScript 或 Python 代码',
    group: '执行',
    color: '#0f8f83',
    icon: Braces,
    keywords: 'code python typescript js 代码 脚本',
  },
  {
    kind: 'http',
    label: 'HTTP 请求',
    description: '从 DSH 主机调用 HTTP API',
    group: '执行',
    color: '#176b87',
    icon: Globe2,
    keywords: 'http request api fetch webhook 请求 接口',
  },
  {
    kind: 'output',
    label: '输出结果',
    description: '格式化并结束当前执行分支',
    group: '执行',
    color: '#d14d62',
    icon: PackageCheck,
    keywords: 'output result return 输出 结果',
  },
  {
    kind: 'if',
    label: 'If 分支',
    description: '根据布尔条件走不同路径',
    group: '流程控制',
    color: '#b7791f',
    icon: GitBranch,
    keywords: 'if branch condition true false 条件 分支',
  },
  {
    kind: 'switch',
    label: 'Switch 分支',
    description: '根据多个匹配值选择路径',
    group: '流程控制',
    color: '#bd4d88',
    icon: ListTree,
    keywords: 'switch case route 分流 匹配',
  },
  {
    kind: 'loop',
    label: 'Loop 循环',
    description: '遍历数组或按次数重复执行',
    group: '流程控制',
    color: '#2583b8',
    icon: Repeat2,
    keywords: 'loop repeat array count 循环 遍历',
  },
  {
    kind: 'while',
    label: 'While 循环',
    description: '条件成立时持续执行分支',
    group: '流程控制',
    color: '#c77b17',
    icon: RotateCw,
    keywords: 'while repeat condition 循环 条件',
  },
  {
    kind: 'note',
    label: '画布备注',
    description: '记录说明，不参与工作流执行',
    group: '辅助',
    color: '#b38a13',
    icon: NotepadText,
    keywords: 'note comment docs 备注 注释 说明',
  },
]

export const NODE_META = Object.fromEntries(
  NODE_CATALOG.map((item) => [item.kind, item]),
) as Record<WorkflowNodeType, NodeCatalogItem>

export function NodeGlyph({
  kind,
  size = 32,
  iconSize = 16,
}: {
  kind: WorkflowNodeType
  size?: number
  iconSize?: number
}) {
  const meta = NODE_META[kind]
  const Icon = meta.icon
  return (
    <span
      className="wf-node-glyph"
      style={{ '--node-color': meta.color, width: size, height: size } as CSSProperties}
      aria-hidden="true"
    >
      <Icon size={iconSize} strokeWidth={1.9} />
    </span>
  )
}

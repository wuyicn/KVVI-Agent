import { expect, it } from 'vitest'
import { businessRequestText } from '../src/client/chat/business-presentation.ts'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
const t = ((key: string) => key) as ChatViewSlotProps['t']
it.each(['', '客户登记', '销售/采购', 'quote " and \\ newline\n'])('projects the guided builder request without technical metadata: %j', (name) => {
  const visible = `请和我一起搭建业务。暂定名称：${JSON.stringify(name)}。先问我想管理什么业务，再一起确认表单、需要的字段和字段类型。名称可以稍后确定，需求确认前不要生成；只用业务语言交流，发布前交给我检查。`
  const logged = visible + '本次搭建意图编号为 intent-test，提交 publish_submit 时将它原样填入 buildIntentId。'
    + '请将确认的资产代号写入工作区 .kvvi-system.json 的 assetId 字段。不得自行审批或发布。'
  expect(businessRequestText(logged, t)).toBe(visible + 'business.ownerApproval')
  expect(businessRequestText('请解释 buildIntentId', t)).toBe('请解释 buildIntentId')
})

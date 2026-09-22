import type { WorkflowContractField } from './model.js'
import { normalizeWorkflowContract, validateWorkflowContract } from './subworkflowProtocol.js'

export type WorkflowContractInputValues = Record<string, string>

function fieldLabel(field: WorkflowContractField): string {
  return field.label || field.name
}

export function parseWorkflowContractField(field: WorkflowContractField, source: string, label = '运行输入'): unknown {
  const text = source.trim()
  if (!text) return undefined
  const name = fieldLabel(field)
  if (field.type === 'string') return source
  if (field.type === 'number') {
    const value = Number(text)
    if (!Number.isFinite(value)) throw new Error(`${label}字段“${name}”必须是数字`)
    return value
  }
  if (field.type === 'boolean') {
    if (text === 'true') return true
    if (text === 'false') return false
    throw new Error(`${label}字段“${name}”必须是布尔值`)
  }
  if (field.type === 'object' || field.type === 'array') {
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`${label}字段“${name}”必须是合法 JSON`)
    }
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return source
  }
}

export function parseWorkflowContractInput(
  fields: WorkflowContractField[] | undefined,
  values: WorkflowContractInputValues,
  label = '运行输入',
): Record<string, unknown> {
  const contract = normalizeWorkflowContract(fields)
  const input: Record<string, unknown> = {}
  for (const field of contract) {
    const value = parseWorkflowContractField(field, values[field.name] ?? '', label)
    if (value !== undefined) input[field.name] = value
  }
  return validateWorkflowContract(input, contract, label) as Record<string, unknown>
}


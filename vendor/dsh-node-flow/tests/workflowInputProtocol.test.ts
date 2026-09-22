import assert from 'node:assert/strict'
import test from 'node:test'
import type { WorkflowContractField } from '../src/model.js'
import { parseWorkflowContractInput } from '../src/workflowInputProtocol.js'

const contract: WorkflowContractField[] = [
  { name: 'title', label: '标题', type: 'string', required: true },
  { name: 'count', label: '数量', type: 'number', required: true },
  { name: 'enabled', label: '启用', type: 'boolean', required: true },
  { name: 'customer', label: '客户', type: 'object', required: true },
  { name: 'labels', label: '标签', type: 'array' },
  { name: 'metadata', label: '元数据', type: 'any' },
]

test('parses typed manual workflow inputs without stringifying JSON values', () => {
  assert.deepEqual(parseWorkflowContractInput(contract, {
    title: 'Quarterly review',
    count: '7.5',
    enabled: 'false',
    customer: '{"id":42,"name":"Ada"}',
    labels: '["priority","finance"]',
    metadata: '{"source":"dashboard"}',
  }), {
    title: 'Quarterly review',
    count: 7.5,
    enabled: false,
    customer: { id: 42, name: 'Ada' },
    labels: ['priority', 'finance'],
    metadata: { source: 'dashboard' },
  })
})

test('keeps free-form any values as text and treats empty optional fields as absent', () => {
  const parsed = parseWorkflowContractInput(contract, {
    title: 'Plain text',
    count: '1',
    enabled: 'true',
    customer: '{"id":1}',
    labels: ' ',
    metadata: 'not JSON',
  })
  assert.deepEqual(parsed, {
    title: 'Plain text',
    count: 1,
    enabled: true,
    customer: { id: 1 },
    metadata: 'not JSON',
  })
})

test('rejects malformed values, missing required values, and contract type mismatches', () => {
  assert.throws(() => parseWorkflowContractInput(contract, {
    title: 'Broken', count: 'one', enabled: 'true', customer: '{"id":1}',
  }), /数量.*数字/)
  assert.throws(() => parseWorkflowContractInput(contract, {
    title: 'Broken', count: '1', enabled: 'yes', customer: '{"id":1}',
  }), /启用.*布尔值/)
  assert.throws(() => parseWorkflowContractInput(contract, {
    title: 'Broken', count: '1', enabled: 'true', customer: '{not-json}',
  }), /客户.*合法 JSON/)
  assert.throws(() => parseWorkflowContractInput(contract, {
    title: '', count: '1', enabled: 'true', customer: '{"id":1}',
  }), /缺少必填字段“标题”/)
  assert.throws(() => parseWorkflowContractInput(contract, {
    title: 'Mismatch', count: '1', enabled: 'true', customer: '[1,2]',
  }), /客户.*应为 object/)
})

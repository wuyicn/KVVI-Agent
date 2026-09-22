import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateResultExpression,
  parseResultValue,
  renderResultJsonTemplate,
  renderResultTemplate,
  resultPathExpression,
  resultTemplateToken,
} from '../src/resultExpression.js'

test('renders nested fields from objects and JSON strings', () => {
  assert.equal(renderResultTemplate('你好 {{result.user.name}}', { user: { name: '小明' } }), '你好 小明')
  assert.equal(renderResultTemplate('{{result.items[0].id}}', '{"items":[{"id":42}]}'), '42')
  assert.equal(renderResultTemplate('{{result}}', 'plain text'), 'plain text')
})

test('renders project variables in templates and constrained expressions', () => {
  const variables = { API_HOST: 'https://api.example.com', RETRIES: 3, ENABLED: true }
  assert.equal(renderResultTemplate('{{vars.API_HOST}}/users/{{result.id}}', { id: 7 }, variables), 'https://api.example.com/users/7')
  assert.deepEqual(JSON.parse(renderResultJsonTemplate('{"host":"{{vars.API_HOST}}","retries":{{vars.RETRIES}}}', {}, variables)), { host: 'https://api.example.com', retries: 3 })
  assert.equal(evaluateResultExpression('vars.ENABLED && vars.RETRIES >= 3', null, variables), true)
  assert.equal(evaluateResultExpression('vars.constructor.constructor("return process")()', null, variables), undefined)
})

test('evaluates expressions against parsed structured input', () => {
  assert.equal(evaluateResultExpression('result.total > 10', '{"total":12}'), true)
  assert.equal(evaluateResultExpression('JSON.parse(result).total', '{"total":12}'), 12)
  assert.equal(evaluateResultExpression('result === \'{"total":12}\'', '{"total":12}'), true)
  assert.deepEqual(parseResultValue('[1,2,3]'), [1, 2, 3])
  assert.equal(evaluateResultExpression('result.missing', '{}'), undefined)
})

test('escapes mapped values inside JSON strings and preserves typed values outside strings', () => {
  const input = { text: '你好 "DSH"\n下一行', count: 3, user: { id: 7 } }
  assert.deepEqual(JSON.parse(renderResultJsonTemplate('{"text":"{{result.text}}","count":{{result.count}},"user":{{result.user}}}', input)), input)
})

test('builds safe expressions for array and unusual object keys', () => {
  const path = ['items', 0, 'order-id']
  assert.equal(resultPathExpression(path), 'result.items[0]["order-id"]')
  assert.equal(resultTemplateToken(path), '{{result.items[0]["order-id"]}}')
})

test('supports a constrained expression language and rejects arbitrary code', () => {
  const value = '{"name":" DSH ","score":12,"items":["AI","Code"]}'
  assert.equal(evaluateResultExpression('JSON.parse(result).name.trim().toLowerCase() === "dsh"', value), true)
  assert.equal(evaluateResultExpression('Number(JSON.parse(result).score) >= 10 && JSON.parse(result).items.includes("AI")', value), true)
  assert.equal(evaluateResultExpression('false && result.missing || 1+2*3 === 7', value), true)
  assert.equal(evaluateResultExpression('globalThis.process.exit()', value), undefined)
  assert.equal(evaluateResultExpression('result.constructor.constructor("return process")()', value), undefined)
})

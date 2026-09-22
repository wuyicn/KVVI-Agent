import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deleteProjectVariable, extractProjectVariableReferences, listProjectSecretValues, listProjectVariableSummaries, redactProjectSecrets, resolveProjectVariables, saveProjectVariable } from '../src/projectVariableStore.js'

test('encrypts project variables and hides secret values from summaries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-node-flow-variables-'))
  try {
    const plain = saveProjectVariable(directory, { name: 'api_host', kind: 'plain', value: 'https://api.example.com' })
    const secret = saveProjectVariable(directory, { name: 'api_token', kind: 'secret', value: 'super-secret-token' })
    assert.equal(plain.name, 'API_HOST')
    assert.equal(secret.value, undefined)
    assert.deepEqual(resolveProjectVariables(directory), { API_HOST: 'https://api.example.com', API_TOKEN: 'super-secret-token' })
    assert.deepEqual(listProjectSecretValues(directory), ['super-secret-token'])
    const summaries = listProjectVariableSummaries(directory)
    assert.equal(summaries.find((variable) => variable.name === 'API_HOST')?.value, 'https://api.example.com')
    assert.equal(summaries.find((variable) => variable.name === 'API_TOKEN')?.value, undefined)
    const stored = readFileSync(join(directory, 'variables.json'), 'utf8')
    assert.equal(stored.includes('https://api.example.com'), false)
    assert.equal(stored.includes('super-secret-token'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('validates updates, extracts references, and redacts nested secret values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-node-flow-variables-'))
  try {
    const saved = saveProjectVariable(directory, { name: 'TOKEN', kind: 'secret', value: 'secret-value-123' })
    assert.throws(() => saveProjectVariable(directory, { id: saved.id, name: 'RENAMED', kind: 'secret' }), /不可修改/)
    const updated = saveProjectVariable(directory, { id: saved.id, name: saved.name, kind: 'secret', value: 'secret-value-456' })
    assert.ok(updated.updatedAt > saved.updatedAt)
    assert.throws(() => saveProjectVariable(directory, { name: 'bad-name', kind: 'plain', value: 'x' }), /变量名/)
    assert.deepEqual(extractProjectVariableReferences({ url: '{{vars.API_HOST}}', condition: 'vars.ENABLED && vars["COUNT"] > 0', ignored: '{{result.value}}' }), ['API_HOST', 'COUNT', 'ENABLED'])
    assert.deepEqual(redactProjectSecrets({ output: 'Bearer secret-value-123', logs: ['secret-value-123'] }, ['secret-value-123']), { output: 'Bearer [secret]', logs: ['[secret]'] })
    assert.equal(deleteProjectVariable(directory, saved.id), true)
    assert.equal(deleteProjectVariable(directory, saved.id), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

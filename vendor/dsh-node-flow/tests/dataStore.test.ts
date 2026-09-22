import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deleteDataStoreValue, deleteDataStoreWorkflow, listDataStoreValues, readDataStoreValue, validateDataStoreNodeConfiguration, writeDataStoreValue } from '../src/dataStore.js'

test('encrypts Data Store values and isolates workflow namespaces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-data-store-'))
  try {
    writeDataStoreValue(directory, 'workflow-a', 'state', 'customer:1', { status: 'ready', count: 2 })
    writeDataStoreValue(directory, 'workflow-a', 'state', 'customer:2', 'second')
    writeDataStoreValue(directory, 'workflow-b', 'state', 'customer:1', 'other')
    assert.deepEqual(readDataStoreValue(directory, 'workflow-a', 'state', 'customer:1')?.value, { status: 'ready', count: 2 })
    assert.equal(readDataStoreValue(directory, 'workflow-b', 'state', 'customer:1')?.value, 'other')
    assert.deepEqual(listDataStoreValues(directory, 'workflow-a', 'state', 'customer:').map((item) => item.key), ['customer:1', 'customer:2'])
    assert.equal(deleteDataStoreValue(directory, 'workflow-a', 'state', 'customer:2'), true)
    assert.equal(readDataStoreValue(directory, 'workflow-a', 'state', 'customer:2'), undefined)
    assert.equal(deleteDataStoreWorkflow(directory, 'workflow-b'), 1)
    assert.equal(readDataStoreValue(directory, 'workflow-b', 'state', 'customer:1'), undefined)
    const persisted = readFileSync(join(directory, 'data-store.json'), 'utf8')
    assert.equal(persisted.includes('ready'), false)
    assert.equal(persisted.includes('second'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('validates Data Store operation-specific fields', () => {
  assert.doesNotThrow(() => validateDataStoreNodeConfiguration({ kind: 'data-store', label: 'Get', storeNamespace: 'orders', storeOperation: 'get', storeKey: 'order:1' }))
  assert.doesNotThrow(() => validateDataStoreNodeConfiguration({ kind: 'data-store', label: 'List', storeNamespace: 'orders', storeOperation: 'list', storePrefix: 'order:' }))
  assert.throws(() => validateDataStoreNodeConfiguration({ kind: 'data-store', label: 'Missing key', storeOperation: 'get', storeKey: '' }), /不能为空/)
  assert.throws(() => validateDataStoreNodeConfiguration({ kind: 'data-store', label: 'Invalid namespace', storeOperation: 'list', storeNamespace: 'bad namespace' }), /命名空间/)
})

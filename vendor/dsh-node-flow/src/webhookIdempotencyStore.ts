import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { webhookIdempotencyId } from './webhookProtocol.js'

const MAX_RECORDS = 2000
const MAX_RESPONSE_BYTES = 256 * 1024

type EncryptedValue = { iv: string; tag: string; data: string }
type StoredRecord = {
  id: string
  workflowId: string
  nodeId: string
  fingerprint: string
  runId: string
  createdAt: string
  expiresAt: string
  state: 'processing' | 'completed'
  response?: EncryptedValue
}

export type WebhookIdempotencyResponse = {
  status: number
  headers: Record<string, string>
  body: string
  runId: string
}

export type WebhookIdempotencyClaim =
  | { kind: 'claimed'; id: string }
  | { kind: 'processing'; runId: string }
  | { kind: 'replay'; response: WebhookIdempotencyResponse }
  | { kind: 'conflict' }

function recordsFile(dataDirectory: string): string {
  return join(dataDirectory, 'webhook-idempotency.json')
}

function keyFile(dataDirectory: string): string {
  return join(dataDirectory, 'webhook-idempotency.key')
}

function loadKey(dataDirectory: string): Buffer {
  mkdirSync(dataDirectory, { recursive: true })
  const file = keyFile(dataDirectory)
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32), { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* Windows ACLs are managed by the profile. */ }
  }
  const key = readFileSync(file)
  if (key.byteLength !== 32) throw new Error('Webhook 幂等存储密钥无效')
  return key
}

function loadRecords(dataDirectory: string): StoredRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(recordsFile(dataDirectory), 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed as StoredRecord[] : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('无法读取 Webhook 幂等记录')
  }
}

function saveRecords(dataDirectory: string, records: StoredRecord[]): void {
  mkdirSync(dataDirectory, { recursive: true })
  const file = recordsFile(dataDirectory)
  const temporary = `${file}.tmp-${process.pid}`
  const contents = JSON.stringify(records.slice(-MAX_RECORDS), null, 2)
  writeFileSync(temporary, contents, { mode: 0o600 })
  try { renameSync(temporary, file) } catch {
    writeFileSync(file, contents, { mode: 0o600 })
    try { unlinkSync(temporary) } catch { /* best-effort cleanup */ }
  }
  try { chmodSync(file, 0o600) } catch { /* Windows ACLs are managed by the profile. */ }
}

function encrypt(dataDirectory: string, value: WebhookIdempotencyResponse): EncryptedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', loadKey(dataDirectory), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

function decrypt(dataDirectory: string, value: EncryptedValue): WebhookIdempotencyResponse {
  try {
    const decipher = createDecipheriv('aes-256-gcm', loadKey(dataDirectory), Buffer.from(value.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8')
    return JSON.parse(plain) as WebhookIdempotencyResponse
  } catch {
    throw new Error('Webhook 幂等响应无法解密')
  }
}

function prune(records: StoredRecord[], now: number): StoredRecord[] {
  return records.filter((record) => Date.parse(record.expiresAt) > now)
}

export function claimWebhookIdempotency(dataDirectory: string, input: {
  workflowId: string
  nodeId: string
  method: string
  key: string
  fingerprint: string
  runId: string
  ttlSeconds: number
  now?: number
}): WebhookIdempotencyClaim {
  const now = input.now ?? Date.now()
  const records = prune(loadRecords(dataDirectory), now)
  const id = webhookIdempotencyId(input.workflowId, input.nodeId, input.method, input.key)
  const existing = records.find((record) => record.id === id)
  if (existing) {
    if (existing.fingerprint !== input.fingerprint) return { kind: 'conflict' }
    if (existing.state === 'processing') return { kind: 'processing', runId: existing.runId }
    if (!existing.response) return { kind: 'conflict' }
    return { kind: 'replay', response: decrypt(dataDirectory, existing.response) }
  }
  records.push({
    id,
    workflowId: input.workflowId,
    nodeId: input.nodeId,
    fingerprint: input.fingerprint,
    runId: input.runId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.ttlSeconds * 1000).toISOString(),
    state: 'processing',
  })
  saveRecords(dataDirectory, records)
  return { kind: 'claimed', id }
}

export function completeWebhookIdempotency(dataDirectory: string, id: string, response: WebhookIdempotencyResponse): void {
  const encoded = JSON.stringify(response)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Webhook 幂等响应超过 256 KB，无法缓存')
  const records = loadRecords(dataDirectory)
  const index = records.findIndex((record) => record.id === id)
  if (index < 0 || records[index].state !== 'processing') return
  records[index] = { ...records[index], state: 'completed', response: encrypt(dataDirectory, response) }
  saveRecords(dataDirectory, records)
}

export function releaseWebhookIdempotency(dataDirectory: string, id: string): void {
  const records = loadRecords(dataDirectory).filter((record) => record.id !== id)
  saveRecords(dataDirectory, records)
}

export function removeWebhookIdempotencyWorkflow(dataDirectory: string, workflowId: string): void {
  const records = loadRecords(dataDirectory).filter((record) => record.workflowId !== workflowId)
  saveRecords(dataDirectory, records)
}

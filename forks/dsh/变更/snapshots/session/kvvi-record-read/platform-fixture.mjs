/** Isolated company response; the shipped CLI, Loader and business tools remain real. */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { contextHeaders } from '../../../packages/tool/kvvi-business/src/client.ts'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'

const MODE = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  companyId: '33333333-3333-4333-8333-333333333333', gateway: 'USER',
}
const SECRET = 'isolated-snapshot-secret'


export const name = 'kvvi-platform-fixture'
export const inject = []

/** Bind an ephemeral platform fixture and register the real tool plugin. */
export async function apply(ctx) {
  let platformUrl
  await applyLoopbackServerEffect(ctx, {
    label: name, onCleanup() {},
    onListening(address) { platformUrl = `http://127.0.0.1:${address.port}` },
    requestListener(req, res) {
      const expected = contextHeaders(MODE, SECRET, Number(req.headers['x-kvvi-issued-at']))
      const signed = Object.entries(expected).every(([key, value]) => req.headers[key] === value)
      const values = {
        '/api/v1/systems': { items: [{ assetId: 'customer', name: '客户登记系统' }] },
        '/api/v1/systems/customer/fields': { assetId: 'customer', hiddenFieldCount: 0, fields: [
          { field_code: 'customer_name', label: '客户名称', required: true, nullable: false },
          { field_code: 'follow_status', label: '跟进状态', type: 'enum', required: true, nullable: false,
            options: [{ code: 'not_followed', label: '未跟进' }] },
        ] },
        '/api/v1/systems/customer/records/R-20261006-000001': {
          recordId: 'record-one', recordNo: 'R-20261006-000001', state: 'not_followed', rowVersion: 7,
          data: { customer_name: '测试客户', follow_status: '未跟进' },
          fieldVisibility: { customer_name: 'VISIBLE', follow_status: 'READONLY', secret_salary: 'HIDDEN' },
        },
      }
      const value = signed && req.method === 'GET' ? values[req.url] : undefined
      res.writeHead(value === undefined ? 403 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value ?? { error: 'KVVI_NOT_ALLOWED' }))
    },
  })
  const preset = yaml.load(readFileSync(new URL('../../../packages/preset/agent-presets/presets/kvvi-worker/agent.cordis.yml', import.meta.url), 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })]) })
  const workerPrefix = preset.find(entry => entry.id === 'persona').config.prefix
  ctx.reflect.provide('kvviModeRouter', { platformUrl, workerPrefix, requireMode: () => MODE })
}

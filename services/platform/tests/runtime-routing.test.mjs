import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { forwardHeaders } from '../src/proxy.mjs'
import { runtimeContextHeaders, verifyRuntimeContextHeaders } from '../src/runtime-auth.mjs'

const secret = 'stage8-runtime-context-secret'
const ctx = {
  sessionId: 'a0000000-0000-4000-8000-000000000099',
  companyId: 'a0000000-0000-4000-8000-000000000001',
  gateway: 'USER',
}

describe('Stage 8：平台到运行时的模式上下文', () => {
  test('浏览器伪造的 x-kvvi-* 会被删除并由服务端上下文替换', () => {
    const trusted = runtimeContextHeaders(ctx, secret, 1_700_000_000_000)
    const out = forwardHeaders({
      host: 'public.example', cookie: 'kvvi-session=browser-token',
      'x-kvvi-gateway': 'BUILDER', 'x-kvvi-company': 'evil-company',
      'x-kvvi-signature': 'forged',
    }, new URL('http://runtime:7401'), 'dsh-auth=channel', trusted)

    assert.equal(out['x-kvvi-gateway'], 'USER')
    assert.equal(out['x-kvvi-company'], ctx.companyId)
    assert.equal(out.cookie, 'dsh-auth=channel')
    assert.equal(verifyRuntimeContextHeaders(out, secret, 1_700_000_000_500).gateway, 'USER')
  })

  test('篡改任一模式字段会使签名失效', () => {
    const signed = runtimeContextHeaders(ctx, secret, 1_700_000_000_000)
    assert.throws(() => verifyRuntimeContextHeaders({
      ...signed, 'x-kvvi-gateway': 'BUILDER',
    }, secret, 1_700_000_000_500), /KVVI_RUNTIME_CONTEXT_INVALID/)
  })
})

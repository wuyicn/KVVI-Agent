import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { handleAuth } from '../src/auth.mjs'
import { handleGate, tokenFromCookie } from '../src/gate.mjs'
import { verifyToken } from '../src/identity.mjs'
import { A, PASSWORD, resetDatabase, grantPlatformRole, closeAll } from './harness.mjs'

before(async () => {
  await resetDatabase()
  await grantPlatformRole(A.alice, 'owner')
})

after(async () => { await closeAll() })

const login = (credentials) => handleAuth({
  method: 'POST', path: '/auth/login', body: credentials, headers: {},
})

const submit = (path, loginName = 'alice') => handleGate({
  method: 'POST', path, query: path,
  body: new URLSearchParams({ login: loginName, password: PASSWORD,
    companyId: A.company }).toString(),
  headers: {}, login, verify: async () => false,
})

describe('Stage 8：工作台与搭建台使用独立登录入口', () => {
  test('两个入口显示不同标题且不暴露对方功能清单', async () => {
    const worker = await handleGate({
      method: 'GET', path: '/kvvi/login', query: '/kvvi/login', body: '', headers: {},
      login, verify: async () => false,
    })
    const builder = await handleGate({
      method: 'GET', path: '/kvvi/builder/login', query: '/kvvi/builder/login', body: '', headers: {},
      login, verify: async () => false,
    })
    assert.match(worker.html, /KVVI 工作台/)
    assert.doesNotMatch(worker.html, /搭建工具|插件安装|发布契约/)
    assert.match(builder.html, /KVVI 搭建台/)
  })

  test('搭建者入口创建服务端绑定的 BUILDER 会话', async () => {
    const out = await submit('/kvvi/builder/login')
    assert.equal(out.status, 303)
    assert.equal(out.headers.location, '/')
    const token = tokenFromCookie(out.headers['set-cookie'])
    const ctx = await verifyToken(token)
    assert.equal(ctx.gateway, 'BUILDER')
    assert.equal(ctx.companyId, A.company)
  })

  test('普通员工从搭建者入口登录会被拒绝', async () => {
    const out = await submit('/kvvi/builder/login', 'bob')
    assert.equal(out.status, 303)
    assert.equal(out.headers.location,
      '/kvvi/builder/login?error=KVVI_BUILDER_ACCESS_REQUIRED')
  })

  test('员工入口始终创建 USER 会话', async () => {
    const out = await submit('/kvvi/login', 'bob')
    const ctx = await verifyToken(tokenFromCookie(out.headers['set-cookie']))
    assert.equal(ctx.gateway, 'USER')
  })
})

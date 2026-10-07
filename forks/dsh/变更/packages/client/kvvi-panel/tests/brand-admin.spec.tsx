// @vitest-environment jsdom
/**
 * 企业管理的「品牌」页签。
 *
 * ── 这一组盯的是「保存不许顺手清空」 ────────────────────────────────────
 *
 * | # | 性质 | 不成立会怎样 |
 * |---|---|---|
 * | 1 | 保存只发**改动过的键** | 改一个名字，顺手把标志和标语清掉，而平台报成功 |
 * | 2 | 没有改动就不发请求 | 一次「保存」把三个字段整份写回去，等于把并发编辑抹掉 |
 * | 3 | 清空一个字段只清那一个（发 null） | 想删标语的人删掉了整个品牌 |
 * | 4 | 读失败时**不画表单** | 手里没有现值，算不出「改动过哪些键」，谁按保存都可能清空 |
 * | 5 | 「平台拒了」与「连不上」是两句话 | 网络问题被当成权限问题，两边都白查 |
 * | 6 | 校验拒了的 `problems` 原样显示 | 平台说了哪个字段不对，界面只回一句「失败了」 |
 * | 7 | 保存后用**平台返回的值**重置表单 | 下一次比较的基准是键入的内容而不是存下来的内容 |
 * | 8 | 页签只给所有者看 | 界面把「看得见」当成「改得动」 |
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KvviAdminShell } from '../src/client/AdminShell.tsx'
import { KvviBrandAdmin, brandDraftOf, brandWriteFailure, brandingPatch } from '../src/client/BrandAdmin.tsx'
import type { Copy } from '../src/client/FormView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The dictionary as a plain function, as the slot renderer supplies it. */
const copy: Copy = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

interface Answer {
  readonly status?: number
  readonly body: unknown
}

/** One recorded request; `body` is the parsed JSON the page sent. */
interface Call {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

/**
 * A fake platform answering by `METHOD path`, with a request log.
 *
 * Answering by path rather than by call order is what lets a case tell "sent
 * the wrong endpoint" from "sent the right one twice".
 * @param routes - one answer per `METHOD /api/v1/...` key.
 * @returns the recorded calls.
 */
function platform(routes: Readonly<Record<string, Answer>>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      path: url,
      body: init?.body === undefined ? undefined : JSON.parse(init.body) as unknown,
    })
    const answer = routes[`${method} ${url}`]
    if (answer === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'KVVI_UNKNOWN_ROUTE' }) })
    }
    const status = answer.status ?? 200
    return Promise.resolve({ ok: status < 400, status, json: async () => answer.body })
  }))
  return calls
}

const STORED = { name: '旧名', logoUrl: '/old.svg', tagline: '旧标语' }

/** A healthy branding endpoint plus whatever else a case needs. */
function brandingPlatform(overrides: Readonly<Record<string, Answer>> = {}): Call[] {
  return platform({
    'GET /api/v1/company/branding': { body: STORED },
    'PUT /api/v1/company/branding': { body: { name: '新名', logoUrl: '/old.svg', tagline: '旧标语' } },
    ...overrides,
  })
}

/** Render the brand half and wait for its read to land. */
async function mountBrand() {
  const view = render(<KvviBrandAdmin copy={copy} />)
  await waitFor(() => { expect(screen.getByLabelText('公司名称')).toBeTruthy() })
  return view
}

/** The single PUT this case made, or a failure naming what was sent instead. */
function put(calls: readonly Call[]): Call {
  const writes = calls.filter(call => call.method === 'PUT')
  expect(writes).toHaveLength(1)
  const write = writes[0]
  if (write === undefined) throw new Error('no PUT was sent')
  return write
}

describe('brandingPatch', () => {
  const stored = { name: '旧名', logoUrl: '/old.svg', tagline: '旧标语' }

  it('keeps only the fields that differ from what was read', () => {
    expect(brandingPatch(stored, { ...stored, name: '新名' })).toEqual({ name: '新名' })
  })

  it('reads an emptied field as a clear, and sends only that field', () => {
    expect(brandingPatch(stored, { ...stored, tagline: '' })).toEqual({ tagline: null })
    expect(brandingPatch(stored, { ...stored, logoUrl: '   ' })).toEqual({ logoUrl: null })
  })

  it('sends nothing when nothing changed', () => {
    expect(brandingPatch(stored, { ...stored })).toEqual({})
    // Whitespace-only against an unset field is still no change worth a write.
    expect(brandingPatch({ ...stored, name: null }, { ...stored, name: '' })).toEqual({})
  })
})

describe('brandDraftOf', () => {
  it('shows unset values as empty boxes', () => {
    expect(brandDraftOf({ name: null, logoUrl: null, tagline: null })).toEqual({
      name: '', logoUrl: '', tagline: '',
    })
  })
})

describe('the brand page', () => {
  it('shows what the platform stored', async () => {
    platform({ 'GET /api/v1/company/branding': { body: STORED } })
    await mountBrand()
    expect(screen.getByLabelText<HTMLInputElement>('公司名称').value).toBe('旧名')
    expect(screen.getByLabelText<HTMLInputElement>('标志地址').value).toBe('/old.svg')
    expect(screen.getByLabelText<HTMLInputElement>('标语').value).toBe('旧标语')
  })

  it('sends only the key the owner changed', async () => {
    const calls = brandingPlatform()
    await mountBrand()
    fireEvent.change(screen.getByLabelText('公司名称'), { target: { value: '新名' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => { expect(screen.getByText('品牌已保存')).toBeTruthy() })

    const write = put(calls)
    expect(write.path).toBe('/api/v1/company/branding')
    // ⚠️ The point of the case: PUT leaves out what it is not told, so sending
    // all three would clear the two the owner never touched.
    expect(write.body).toEqual({ name: '新名' })
    expect(Object.keys(write.body as object)).toEqual(['name'])
  })

  it('clears exactly the field that was emptied', async () => {
    const calls = brandingPlatform()
    await mountBrand()
    fireEvent.change(screen.getByLabelText('标语'), { target: { value: '' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => { expect(screen.getByText('品牌已保存')).toBeTruthy() })
    expect(put(calls).body).toEqual({ tagline: null })
  })

  it('sends nothing at all when the form was not edited', async () => {
    const calls = brandingPlatform()
    await mountBrand()
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => { expect(screen.getByText('没有改动，没有发出请求')).toBeTruthy() })
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0)
  })

  it('re-seeds the form from the platform\u2019s answer, so a second save is a no-op', async () => {
    const calls = brandingPlatform({
      'PUT /api/v1/company/branding': { body: { name: '服务端存的', logoUrl: '/old.svg', tagline: '旧标语' } },
    })
    await mountBrand()
    fireEvent.change(screen.getByLabelText('公司名称'), { target: { value: '键入的' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => { expect(screen.getByText('品牌已保存')).toBeTruthy() })
    // What the server stored is what the next save compares against.
    expect(screen.getByLabelText<HTMLInputElement>('公司名称').value).toBe('服务端存的')
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => { expect(screen.getByText('没有改动，没有发出请求')).toBeTruthy() })
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1)
  })

  it('re-reads when a successful write carries no body', async () => {
    const calls = platform({
      'GET /api/v1/company/branding': { body: STORED },
      // 204: the write happened, but the answer is not the new state.
      'PUT /api/v1/company/branding': { status: 204, body: null },
    })
    await mountBrand()
    fireEvent.change(screen.getByLabelText('公司名称'), { target: { value: '新名' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => { expect(screen.getByText('品牌已保存')).toBeTruthy() })
    // Three empty boxes would have read as "everything was cleared" — the form
    // shows what the platform actually holds.
    await waitFor(() => { expect(calls.filter(call => call.method === 'GET')).toHaveLength(2) })
    expect(screen.getByLabelText<HTMLInputElement>('公司名称').value).toBe('旧名')
    expect(put(calls).body).toEqual({ name: '新名' })
  })

  it('says the platform is unreachable when the save itself cannot be sent', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { method?: string }) => {
      if (init?.method === 'PUT') return Promise.reject(new Error('Failed to fetch'))
      return Promise.resolve({ ok: true, status: 200, json: async () => STORED })
    }))
    await mountBrand()
    fireEvent.change(screen.getByLabelText('公司名称'), { target: { value: '新名' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    // A save that never arrived must not read as a successful one.
    expect(screen.getByRole('alert').textContent).toContain('连不上平台')
    expect(screen.queryByText('品牌已保存')).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('公司名称').value).toBe('新名')
  })

  it('says it is saving while the write is in flight', async () => {
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { method?: string }) => {
      if (init?.method !== 'PUT') return Promise.resolve({ ok: true, status: 200, json: async () => STORED })
      return new Promise((resolve) => {
        release = () => { resolve({ ok: true, status: 200, json: async () => STORED }) }
      })
    }))
    await mountBrand()
    fireEvent.change(screen.getByLabelText('公司名称'), { target: { value: '新名' } })
    fireEvent.click(screen.getByText('保存'))
    // The button stops inviting a second write while the first is unanswered.
    await waitFor(() => { expect(screen.getByText('保存中…')).toBeTruthy() })
    release?.()
    await waitFor(() => { expect(screen.getByText('品牌已保存')).toBeTruthy() })
  })

  it('shows the platform\u2019s field-level refusals verbatim', async () => {
    brandingPlatform({
      'PUT /api/v1/company/branding': {
        status: 400,
        body: {
          error: 'KVVI_BRANDING_INVALID',
          problems: [{ field: 'logoUrl', reason: 'NOT_ABSOLUTE_URL' }],
        },
      },
    })
    await mountBrand()
    fireEvent.change(screen.getByLabelText('公司名称'), { target: { value: '新名' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('KVVI_BRANDING_INVALID')
    // The field and its reason are the platform's own words: they are what
    // whoever has to fix the value needs, and a rephrasing would lose them.
    expect(alert.textContent).toContain('logoUrl')
    expect(alert.textContent).toContain('NOT_ABSOLUTE_URL')
  })
})

describe('the brand page when the read fails', () => {
  it('says the platform is unreachable, draws no form, and stays renderable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Failed to fetch'))))
    render(<KvviBrandAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    // An explanation, not a blank page: the page still says what it is.
    expect(screen.getByText(/公司名称、标志与标语会显示在员工界面/)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('连不上平台')
    // No form and no save button: with no current values there is no way to
    // compute "which keys changed", and a save from here could clear all three.
    expect(screen.queryByLabelText('公司名称')).toBeNull()
    expect(screen.queryByText('保存')).toBeNull()
  })

  it('keeps "the platform refused" apart from "the network failed"', async () => {
    platform({ 'GET /api/v1/company/branding': { status: 403, body: { error: 'KVVI_OWNER_REQUIRED' } } })
    render(<KvviBrandAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).toContain('平台拒绝了这次读取')
    expect(text).toContain('KVVI_OWNER_REQUIRED')
    expect(text).not.toContain('连不上平台')
  })

  it('reads again when the owner retries', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('Failed to fetch'))
      return Promise.resolve({ ok: true, status: 200, json: async () => STORED })
    }))
    render(<KvviBrandAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => { expect(screen.getByLabelText<HTMLInputElement>('公司名称').value).toBe('旧名') })
    expect(attempts).toBe(2)
  })

  it('carries the platform\u2019s own detail into the refusal sentence', async () => {
    platform({
      'GET /api/v1/company/branding': {
        status: 400,
        body: { error: 'KVVI_BRANDING_INVALID', detail: 'name is too long' },
      },
    })
    render(<KvviBrandAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(screen.getByRole('alert').textContent).toContain('KVVI_BRANDING_INVALID')
    expect(screen.getByRole('alert').textContent).toContain('name is too long')
  })

  it('abandons a read in flight when the page goes away', async () => {
    const reported: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { reported.push(args) })
    let aborted = 0
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted += 1
          reject(new Error('The operation was aborted'))
        })
      },
    )))
    const view = render(<KvviBrandAdmin copy={copy} />)
    view.unmount()
    await waitFor(() => { expect(aborted).toBe(1) })
    await Promise.resolve()
    spy.mockRestore()
    // Withdrawing the request is this page's own doing: it is not reported as
    // a platform failure, and nothing writes to the page after it is gone.
    expect(reported).toEqual([])
  })
})

describe('brandWriteFailure', () => {
  it('explains a refusal with the platform\u2019s code and a network failure without one', () => {
    expect(brandWriteFailure('KVVI_OWNER_REQUIRED', undefined, copy)).toContain('KVVI_OWNER_REQUIRED')
    expect(brandWriteFailure('KVVI_UNREACHABLE', 'Error: Failed to fetch', copy)).toContain('连不上平台')
  })

  it('carries the platform\u2019s own detail next to the code', () => {
    const sentence = brandWriteFailure('KVVI_BRANDING_INVALID', 'tagline is too long', copy)
    expect(sentence).toContain('KVVI_BRANDING_INVALID')
    expect(sentence).toContain('tagline is too long')
  })
})

describe('the brand tab', () => {
  const CAPABILITIES = {
    role: 'owner', canManageMembers: true, canManageRoles: true, canManagePlatformRoles: true,
    canManageBuilder: true, dimensions: [], dataScopes: [], fieldVisibilities: [],
  }

  /** The administration routes the shell reads on mount. */
  function adminPlatform(role: string): Call[] {
    return platform({
      'GET /api/v1/admin/capabilities': { body: { ...CAPABILITIES, role } },
      'GET /api/v1/admin/members': { body: { items: [] } },
      'GET /api/v1/admin/roles': { body: { items: [] } },
      'GET /api/v1/admin/departments': { body: { items: [] } },
      'GET /api/v1/company/branding': { body: STORED },
    })
  }

  it('is offered to an owner, and opens the three-field form', async () => {
    adminPlatform('owner')
    render(<KvviAdminShell copy={copy} />)
    await waitFor(() => { expect(screen.getByText('品牌')).toBeTruthy() })
    fireEvent.click(screen.getByText('品牌'))
    await waitFor(() => { expect(screen.getByLabelText('标语')).toBeTruthy() })
  })

  it('is not offered to an administrator who is not the owner', async () => {
    adminPlatform('admin')
    render(<KvviAdminShell copy={copy} />)
    await waitFor(() => { expect(screen.getByText('角色与权限')).toBeTruthy() })
    // Clarity, not enforcement: the platform refuses the write regardless.
    expect(screen.queryByText('品牌')).toBeNull()
    expect(screen.queryByText('发布')).toBeNull()
  })
})

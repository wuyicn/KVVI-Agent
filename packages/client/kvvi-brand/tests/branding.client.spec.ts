/**
 * The branding read, against a scripted `fetch`.
 *
 * ── What this group pins ────────────────────────────────────────────────
 *
 * | # | Property | If it breaks |
 * |---|---|---|
 * | 1 | The endpoint is the same-origin `/api/v1/company/branding` | the brand silently never loads, on an origin nobody thought to check |
 * | 2 | "The platform refused" is a code | a 403 reads as a company that configured nothing |
 * | 3 | "The network failed" is its own outcome | a proxy outage reads as a tenant with no brand |
 * | 4 | "Nothing is set" is a successful read | the default state of every company reads as an error |
 * | 5 | A body that is not branding is refused | an HTML error page becomes a brand with no name |
 * | 6 | Aborting is the caller's own doing | a component unmount reports a network failure |
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readBranding } from '../src/client/branding.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** One scripted response; a string body stands for a non-JSON answer. */
function answer(status: number, body: unknown): Response {
  return typeof body === 'string'
    ? new Response(body, { status })
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Install a scripted platform and return the URLs it was asked for. */
function platform(reply: (url: string) => Response | Promise<Response>): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    calls.push(url)
    return Promise.resolve(reply(url))
  }))
  return calls
}

describe('readBranding', () => {
  it('reads the three values from the same-origin product endpoint', async () => {
    const calls = platform(() => answer(200, {
      name: '示例公司', logoUrl: '/assets/logo.svg', tagline: '让每一件事都有据可查',
    }))
    await expect(readBranding()).resolves.toEqual({
      status: 'read',
      branding: {
        name: '示例公司', logoUrl: '/assets/logo.svg', tagline: '让每一件事都有据可查',
      },
    })
    expect(calls).toEqual(['/api/v1/company/branding'])
  })

  it('reads three nulls as a successful read, not as a failure', async () => {
    platform(() => answer(200, { name: null, logoUrl: null, tagline: null }))
    // The default state of every company: nothing configured. It is an
    // answer, and the fallbacks render off it exactly as they do off an
    // outage — the difference is what an operator is told, not what shows.
    await expect(readBranding()).resolves.toEqual({
      status: 'read', branding: { name: null, logoUrl: null, tagline: null },
    })
  })

  it('reads blank and missing fields as absent', async () => {
    platform(() => answer(200, { name: '', logoUrl: '   ', tagline: 42 }))
    await expect(readBranding()).resolves.toEqual({
      status: 'read', branding: { name: null, logoUrl: null, tagline: null },
    })
  })

  it('reports a platform refusal with the platform\u2019s own code and detail', async () => {
    platform(() => answer(403, { error: 'KVVI_OWNER_REQUIRED', detail: 'only an owner may read this' }))
    await expect(readBranding()).resolves.toEqual({
      status: 'failed',
      failure: { kind: 'refused', code: 'KVVI_OWNER_REQUIRED', detail: 'only an owner may read this' },
    })
  })

  it('names an HTTP status when the refusal body carries no code', async () => {
    platform(() => answer(502, '<html>bad gateway</html>'))
    await expect(readBranding()).resolves.toEqual({
      status: 'failed', failure: { kind: 'refused', code: 'KVVI_HTTP_502' },
    })
  })

  it('names an HTTP status when the refusal body is JSON without an error', async () => {
    platform(() => answer(500, { message: 'boom' }))
    await expect(readBranding()).resolves.toEqual({
      status: 'failed', failure: { kind: 'refused', code: 'KVVI_HTTP_500' },
    })
  })

  it('reports an unreachable platform as its own outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))))
    await expect(readBranding()).resolves.toEqual({
      status: 'failed', failure: { kind: 'unreachable', detail: 'Error: connect ECONNREFUSED' },
    })
  })

  it('reports an aborted read as the caller\u2019s own teardown', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('The operation was aborted'))))
    await expect(readBranding(controller.signal)).resolves.toEqual({ status: 'aborted' })
  })

  it('refuses a 200 whose body is not a branding document', async () => {
    platform(() => answer(200, '<html>sign in</html>'))
    await expect(readBranding()).resolves.toEqual({
      status: 'failed', failure: { kind: 'refused', code: 'KVVI_BAD_RESPONSE' },
    })
  })

  it('refuses a 200 whose JSON body is not an object', async () => {
    platform(() => answer(200, 'null'))
    await expect(readBranding()).resolves.toEqual({
      status: 'failed', failure: { kind: 'refused', code: 'KVVI_BAD_RESPONSE' },
    })
  })
})

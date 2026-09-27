// @vitest-environment jsdom
/**
 * Session-notice behaviour and the banner's visible output.
 *
 * ── Why this group exists ───────────────────────────────────────────────
 *
 * The banner is the only place that says "your sign-in ended" out loud. Four
 * different symptoms used to mean that and none of them said it, so the three
 * things worth pinning are:
 *
 * | # | Property | If it breaks |
 * |---|---|---|
 * | 1 | Recognising both 401 envelopes | the banner never appears, or appears on unrelated refusals |
 * | 2 | The wrapper is reversible and installs once | a plugin reload stacks wrappers; each response is processed N times |
 * | 3 | One notice per code, cleared by the next success | a burst of failed requests paints a wall of identical banners |
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionBanner } from '../src/client/SessionBanner.tsx'
import {
  RELOGIN_CODES, SessionNoticeController, noticeOf,
} from '../src/client/session-notice.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** The dictionary as the slot renderer supplies it. */
const t = (key: string, params?: Record<string, unknown>): string => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name]))
}

/**
 * Put a transport under the wrapper, then install the wrapper over it.
 *
 * ⚠️ Order matters, and getting it wrong is what the first draft of this spec
 * did: assigning `globalThis.fetch` **after** `install()` throws the wrapper
 * away, so every request bypasses the code under test and the assertions fail
 * for a reason that has nothing to do with the banner.
 * @param initial - The first answer the transport gives.
 * @returns The controller, a disposer, and a setter for later answers.
 */
function harnessUnderTest(initial: { status: number; body: unknown }) {
  const answer = { ...initial }
  globalThis.fetch = async () => new Response(
    typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
    { status: answer.status, headers: { 'content-type': 'application/json' } },
  )
  const controller = new SessionNoticeController()
  const dispose = controller.install()
  return { controller, dispose, answer }
}

describe('noticeOf: the two 401 envelopes', () => {
  it('reads the platform envelope', () => {
    expect(noticeOf(401, { error: 'KVVI_SESSION_ENDED', message: '这次会话已经结束了' }))
      .toEqual({ code: 'KVVI_SESSION_ENDED', message: '这次会话已经结束了' })
  })

  it('reads the runtime envelope, where the code sits one level deeper', () => {
    expect(noticeOf(401, {
      type: 'server-response',
      result: { ok: false, error: { code: 'KVVI_AUTHORIZATION_CHANGED', message: '权限变了' } },
    })).toEqual({ code: 'KVVI_AUTHORIZATION_CHANGED', message: '权限变了' })
  })

  it('admits a code outside the table when the platform flags relogin', () => {
    // The platform may add codes; `relogin: true` is its way of saying "this
    // one needs a sign-in" without the client shipping a new table first.
    expect(noticeOf(401, { error: 'KVVI_SOMETHING_NEW', relogin: true })?.code)
      .toBe('KVVI_SOMETHING_NEW')
  })

  it('stays silent on a 401 that is neither', () => {
    // Showing the banner on every refusal would make it meaningless.
    expect(noticeOf(401, { error: 'KVVI_NOT_ALLOWED' })).toBeNull()
    expect(noticeOf(401, {})).toBeNull()
    expect(noticeOf(401, null)).toBeNull()
    expect(noticeOf(401, 'not json')).toBeNull()
    expect(noticeOf(403, { error: 'KVVI_SESSION_ENDED' })).toBeNull()
  })

  it('falls back to the code when no sentence came', () => {
    expect(noticeOf(401, { error: 'KVVI_SESSION_REQUIRED' }))
      .toEqual({ code: 'KVVI_SESSION_REQUIRED', message: 'KVVI_SESSION_REQUIRED' })
  })

  it('keeps the codes the platform actually sends', () => {
    expect(RELOGIN_CODES).toContain('KVVI_SESSION_ENDED')
    expect(RELOGIN_CODES).toContain('KVVI_AUTHORIZATION_CHANGED')
  })
})

describe('SessionNoticeController', () => {
  it('★ a 401 raises the notice; the next success clears it', async () => {
    const { controller, dispose, answer } = harnessUnderTest(
      { status: 401, body: { error: 'KVVI_SESSION_ENDED', message: '结束了' } })
    await globalThis.fetch('/api/session/list')
    expect(controller.state.getSnapshot().notice?.code).toBe('KVVI_SESSION_ENDED')

    // A sign-in completed in another tab is not seen here; the next request on
    // this page is, and that is what clears the banner.
    answer.status = 200
    answer.body = { ok: true }
    await globalThis.fetch('/api/session/list')
    expect(controller.state.getSnapshot().notice).toBeNull()
    dispose()
  })

  it('★ the wrapper installs once and is reversible', () => {
    const inner = globalThis.fetch
    const controller = new SessionNoticeController()
    const dispose = controller.install()
    const once = globalThis.fetch
    expect(once).not.toBe(inner)

    // A second install must not stack: N wrappers process every response N times.
    // It hands back the same disposer rather than adding a layer.
    const disposeAgain = controller.install()
    expect(globalThis.fetch).toBe(once)
    expect(disposeAgain).toBe(dispose)

    disposeAgain()
    expect(globalThis.fetch).toBe(inner)

    // Disposing twice is harmless: a plugin reload may clean up twice, and a
    // second restore must not undo an unrelated later wrapper.
    dispose()
    expect(globalThis.fetch).toBe(inner)
  })

  it('publishes one notice per code, however many requests fail', async () => {
    const { controller, dispose, answer } = harnessUnderTest(
      { status: 401, body: { error: 'KVVI_SESSION_EXPIRED', message: '过期了' } })
    let renders = 0
    controller.state.subscribe(() => { renders += 1 })

    await globalThis.fetch('/a')
    await globalThis.fetch('/b')
    await globalThis.fetch('/c')
    expect(renders).toBe(1)

    // A different code is a different fact and does publish.
    answer.body = { error: 'KVVI_SESSION_ENDED', message: '结束了' }
    await globalThis.fetch('/d')
    expect(renders).toBe(2)
    expect(controller.state.getSnapshot().notice?.code).toBe('KVVI_SESSION_ENDED')
    dispose()
  })

  it('leaves a non-JSON 401 body alone (the historical login page HTML)', async () => {
    const { controller, dispose } = harnessUnderTest({ status: 401, body: '<!DOCTYPE html><html>…' })
    const response = await globalThis.fetch('/api/session/list')
    // The caller still gets its response: the wrapper must not become a new
    // failure point for requests it merely observes.
    expect(response.status).toBe(401)
    expect(controller.state.getSnapshot().notice).toBeNull()
    dispose()
  })

  it('publishes nothing when recover() runs on a clean state', () => {
    const controller = new SessionNoticeController()
    let renders = 0
    controller.state.subscribe(() => { renders += 1 })
    controller.recover()
    expect(renders).toBe(0)
  })
})

describe('SessionBanner', () => {
  /**
   * Props as the renderer hands them over, with the hook seat bound.
   * @param notice - The live notice, or `null`.
   * @param onRelogin - Records the re-login callback's argument.
   */
  const propsFor = (notice: { code: string; message: string } | null,
    onRelogin: (code: string) => void) => ({
    t,
    useSessionNotice: () => ({ notice }),
    relogin: onRelogin,
  }) as unknown as Parameters<typeof SessionBanner>[0]

  it('renders nothing while the session is fine', () => {
    const { container } = render(<SessionBanner {...propsFor(null, () => {})} />)
    expect(container.querySelector('[data-kvvi-session-banner]')).toBeNull()
  })

  it('★ shows the reason and the code, and offers a re-login', () => {
    const seen: string[] = []
    render(<SessionBanner {...propsFor({ code: 'KVVI_SESSION_ENDED', message: '这次会话已经结束了' },
      (code) => { seen.push(code) })} />)

    expect(screen.getByRole('alert')).toBeTruthy()
    // The sentence comes from the dictionary, with the platform's reason in it.
    expect(screen.getByText('原因：这次会话已经结束了。重新登录后可以继续。')).toBeTruthy()
    // The code travels verbatim: it is what an operator quotes in a report.
    expect(screen.getByText('KVVI_SESSION_ENDED')).toBeTruthy()

    fireEvent.click(screen.getByRole('button'))
    expect(seen).toEqual(['KVVI_SESSION_ENDED'])
  })
})

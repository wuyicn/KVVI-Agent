// @vitest-environment jsdom
/**
 * The publish half of enterprise administration.
 *
 * ── What this group pins ────────────────────────────────────────────────
 *
 * | # | Property | If it breaks |
 * |---|---|---|
 * | 1 | Approval states the digest it approves | the approver's decision is not bound to any content |
 * | 2 | Approve is offered only while awaiting approval | the button invites a call the platform will refuse |
 * | 3 | Publish is offered only once approved | same, one state later |
 * | 4 | Refusals show the platform's own code | the one string an operator greps for is replaced by a guess |
 * | 5 | The faces from §9.6.6 are shown | an approver decides without seeing what a diff report must cover |
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { KvviPublishAdmin } from '../src/client/PublishAdmin.tsx'
import type { Copy } from '../src/client/FormView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const copy: Copy = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? template
    : template.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name]))
}

const DRAFT = {
  draftId: 'd-1', status: 'AWAITING_APPROVAL', change_digest: 'sha256:aaa',
  proposer: 'builder', created_at: '2026-09-27 10:00', approved_by: null, published_at: null,
}

const DETAIL = {
  draft_id: 'd-1', status: 'AWAITING_APPROVAL', change_digest: 'sha256:aaa',
  diff_report: {
    counts: { added: 16, removed: 0, changed: 2 },
    faces: ['见得到什么（人员范围）', '能做什么动作', '数据范围档位'],
  },
  approval_opinion: null, published_at: null,
}

/**
 * A scripted platform: answers by path, records every call.
 * @param overrides - per-path answers, keyed by `METHOD /path`.
 */
function platform(overrides: Record<string, { status: number; body: unknown }> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const path = url.replace(/^.*\/api\/v1/, '')
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    calls.push({ method, path, body })
    const answer = overrides[`${method} ${path}`]
      ?? { status: 200, body: { items: [DRAFT] } }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

describe('KvviPublishAdmin', () => {
  it('explains existing duplicates when publishing a uniqueness rule', async () => {
    platform({
      'GET /publish/drafts': { status: 200, body: { items: [{ ...DRAFT, status: 'APPROVED' }] } },
      'POST /publish/drafts/d-1/publish': { status: 409, body: { error: 'KVVI_UNIQUE_EXISTING_DUPLICATES' } },
    })
    render(<KvviPublishAdmin copy={copy} />)
    fireEvent.click(await screen.findByText('发布'))
    expect(await screen.findByText('已有记录存在重复，请先处理重复数据，再发布“不允许重复”规则。原有数据未删除。')).toBeTruthy()
  })
  it('lists the drafts with their proposer and status', async () => {
    platform()
    render(<KvviPublishAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByText('builder')).toBeTruthy() })
    expect(screen.getByText('AWAITING_APPROVAL')).toBeTruthy()
  })

  it('shows an empty state rather than an empty table', async () => {
    platform({ 'GET /publish/drafts': { status: 200, body: { items: [] } } })
    render(<KvviPublishAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByText('没有待处理的发布草案')).toBeTruthy() })
  })

  it('★ approval states the digest it approves', async () => {
    const calls = platform()
    render(<KvviPublishAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByText('builder')).toBeTruthy() })

    fireEvent.click(screen.getByText('批准'))
    await waitFor(() => { expect(calls.some(c => c.path.endsWith('/approve'))).toBe(true) })
    const approve = calls.find(c => c.path.endsWith('/approve'))
    // The digest is how the approver says *which* content they decided on,
    // rather than "a draft that looked like this".
    expect(approve?.body).toEqual({ decision: 'APPROVE', changeDigest: 'sha256:aaa' })
  })

  it('★ offers approve only while awaiting, and publish only once approved', async () => {
    platform({
      'GET /publish/drafts': {
        status: 200,
        body: { items: [DRAFT, { ...DRAFT, draftId: 'd-2', status: 'APPROVED' },
          { ...DRAFT, draftId: 'd-3', status: 'PUBLISHED' }] },
      },
    })
    render(<KvviPublishAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getAllByText('批准').length).toBe(3) })

    // One awaiting draft, one approved, one published: exactly one of each
    // action is enabled. A button that invites a refusal teaches nothing.
    const approvable = screen.getAllByText('批准').filter(b => !(b as HTMLButtonElement).disabled)
    const publishable = screen.getAllByText('发布').filter(b => !(b as HTMLButtonElement).disabled)
    expect(approvable).toHaveLength(1)
    expect(publishable).toHaveLength(1)
  })

  it('★ shows the platform\'s own code when it refuses', async () => {
    platform({
      'POST /publish/drafts/d-1/approve': {
        status: 409, body: { error: 'KVVI_SELF_APPROVAL_FORBIDDEN' },
      },
    })
    render(<KvviPublishAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByText('builder')).toBeTruthy() })

    fireEvent.click(screen.getByText('批准'))
    await waitFor(() => {
      expect(screen.getByText(/不能批准自己提交的那一份/)).toBeTruthy()
    })
  })

  it('leaves an unregistered refusal code verbatim', async () => {
    platform({
      'POST /publish/drafts/d-1/approve': {
        status: 409, body: { error: 'KVVI_SOMETHING_NOBODY_TRANSLATED' },
      },
    })
    render(<KvviPublishAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByText('builder')).toBeTruthy() })
    fireEvent.click(screen.getByText('批准'))
    // Inventing "save failed" would erase the only diagnostic value it has.
    await waitFor(() => { expect(screen.getByText('KVVI_SOMETHING_NOBODY_TRANSLATED')).toBeTruthy() })
  })

  it('★ the diff shows the counts and every face §9.6.6 requires', async () => {
    platform({ 'GET /publish/drafts/d-1': { status: 200, body: DETAIL } })
    render(<KvviPublishAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByText('builder')).toBeTruthy() })

    fireEvent.click(screen.getByText('看差异'))
    await waitFor(() => { expect(screen.getByText(/新增 16 \/ 删除 0 \/ 改动 2/)).toBeTruthy() })
    // The faces are how an approver sees that all of §9.6.6 was considered.
    expect(screen.getByText('能做什么动作')).toBeTruthy()
    expect(screen.getByText(/变更摘要 sha256:aaa/)).toBeTruthy()
  })

  it('reloads the list after a write, so a refused stale row does not linger', async () => {
    const calls = platform({
      'POST /publish/drafts/d-1/approve': {
        status: 409, body: { error: 'KVVI_DRAFT_NOT_AWAITING_APPROVAL' },
      },
    })
    render(<KvviPublishAdmin copy={copy} />)
    await waitFor(() => { expect(screen.getByText('builder')).toBeTruthy() })
    const before = calls.filter(c => c.path === '/publish/drafts').length

    fireEvent.click(screen.getByText('批准'))
    await waitFor(() => {
      expect(calls.filter(c => c.path === '/publish/drafts').length).toBeGreaterThan(before)
    })
  })
})

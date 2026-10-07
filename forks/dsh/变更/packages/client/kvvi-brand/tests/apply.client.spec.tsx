// @vitest-environment jsdom
/**
 * The plugin's wiring: five occupants, one read, one store.
 *
 * ── What this group pins ────────────────────────────────────────────────
 *
 * | # | Property | If it breaks |
 * |---|---|---|
 * | 1 | All five slots are filled | one of them silently keeps the product's own brand |
 * | 2 | One read per activation, on the product endpoint | a five-occupant brand costs five round trips |
 * | 3 | Every occupant shares one store identity | the sidebar and the hero can disagree |
 * | 4 | Occupants install before or after the declarations | activation order decides whether the brand appears |
 * | 5 | Teardown withdraws all five and aborts the read | HMR leaves a half-branded shell or a request in flight |
 * | 6 | A failed read still occupies every slot | an outage empties the brand row |
 *
 * The registry is the real one (`SlotRegistry`), because "declaring is
 * claiming" and the declaration lifetime is exactly what is under test.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** Every hole this package fills, and the locale each registration declares. */
const HOLES = [
  ['sidebar.brand.mark', undefined],
  ['sidebar.brand.name', undefined],
  ['conversation.hero.brand.mark', undefined],
  ['conversation.hero.title', 'conversation'],
  ['conversation.hero.badge', 'conversation'],
] as const

/** One scripted branding answer, plus the requests it was asked for. */
function platform(body: unknown, status = 200) {
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal })
    return Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    }))
  }))
  return calls
}

/**
 * A context with the real slot registry and the five holes declared.
 * @param declare - whether the declaring registration runs before apply.
 * @returns the context, the registry, and a way to declare the holes later.
 */
async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(([name]) => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  return { ctx, slots, declareHoles, disposeHoles: declare ? declareHoles() : undefined }
}

/**
 * The live snapshot behind one registration's declared store seat.
 *
 * The plugin declares a plain handle rather than a factory, and overrides
 * `create()` on it to return the one instance it activated — so this probe
 * reads exactly the snapshot the occupants render from.
 * @param slots - the live registry.
 * @param hole - the slot whose registration to read.
 * @returns the store snapshot.
 */
function storeStateOf(slots: SlotRegistry, hole: Parameters<SlotRegistry['entries']>[0]): unknown {
  const declared = slots.entries(hole)[0]?.store
  if (declared === undefined || typeof declared === 'function') {
    throw new Error(`${hole} declared no shared store handle`)
  }
  return declared.create().getSnapshot()
}

/** Let the read's promise chain settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('kvvi-brand browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the slot service it uses', () => {
    expect(inject).toEqual(['slots'])
  })

  it('fills all five slots and shares one store across them', async () => {
    platform({ name: null, logoUrl: null, tagline: null })
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()

    for (const [hole, locale] of HOLES) {
      const entries = subject.slots.entries(hole)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.locale).toBe(locale)
    }
    // One handle, not one per occupant: the framework mints an instance per
    // entry, and that would give the sidebar its own copy of the fact the hero
    // reads.
    const stores = HOLES.map(([hole]) => subject.slots.entries(hole)[0]?.store)
    expect(new Set(stores).size).toBe(1)
  })

  it('reads the company branding once, from the product endpoint', async () => {
    const calls = platform({ name: null, logoUrl: null, tagline: null })
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    expect(calls.map(call => call.url)).toEqual(['/api/v1/company/branding'])
    // Five occupants, one read — and one that carries the effect's signal, so
    // teardown can end it.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('installs the occupants whatever order the declarations arrive in', async () => {
    platform({ name: null, logoUrl: null, tagline: null })
    // After: the plugin waits on each declaration in turn.
    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const [hole] of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const [hole] of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)

    // Before: the plugin installs on the declarations it already has, and
    // withdraws the whole set when they collapse.
    const before = await bench()
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    before.disposeHoles?.()
    for (const [hole] of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
  })

  it('withdraws every occupant and aborts the read on teardown', async () => {
    const calls = platform({ name: null, logoUrl: null, tagline: null })
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const signal = calls[0]?.signal ?? undefined
    expect(signal?.aborted).toBe(false)

    await fiber.dispose()
    for (const [hole] of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
    expect(signal?.aborted).toBe(true)
  })

  it('publishes nothing when teardown aborts the read in flight', async () => {
    // A real fetch rejects on abort; the read reports that as the caller's own
    // doing, and a settled-after-teardown answer must not land in the store.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('The operation was aborted')) })
      },
    )))
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const declared = subject.slots.entries('sidebar.brand.mark')[0]?.store
    if (declared === undefined || typeof declared === 'function') throw new Error('no store handle')
    const store = declared.create()

    await fiber.dispose()
    await settle()
    expect(store.getSnapshot()).toEqual({ status: 'loading', branding: null, failure: null })
  })

  it('publishes the company\u2019s branding into the store the occupants read', async () => {
    platform({ name: '示例公司', logoUrl: '/assets/example.svg', tagline: '让每一件事都有据可查' })
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    expect(storeStateOf(subject.slots, 'sidebar.brand.name')).toEqual({
      status: 'ready',
      branding: { name: '示例公司', logoUrl: '/assets/example.svg', tagline: '让每一件事都有据可查' },
      failure: null,
    })
  })

  it('keeps the occupants and reports a refusal when the read fails', async () => {
    platform({ error: 'KVVI_SESSION_REQUIRED' }, 401)
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    for (const [hole] of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
    expect(storeStateOf(subject.slots, 'sidebar.brand.mark')).toEqual({
      status: 'failed',
      branding: null,
      failure: { kind: 'refused', code: 'KVVI_SESSION_REQUIRED' },
    })
  })

  it('reports an unreachable platform apart from a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))))
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    await settle()
    expect(storeStateOf(subject.slots, 'sidebar.brand.mark')).toEqual({
      status: 'failed',
      branding: null,
      failure: { kind: 'unreachable', detail: 'Error: connect ECONNREFUSED' },
    })
  })
})

// @vitest-environment jsdom
/**
 * The five occupants, fed the store state directly.
 *
 * ── What this group pins ────────────────────────────────────────────────
 *
 * | # | Property | If it breaks |
 * |---|---|---|
 * | 1 | With no company branding every occupant renders KVVI's own brand |
 *       a tenant that configured nothing loses its product name and headline |
 * | 2 | With company branding every occupant renders the company's | the feature silently does not work |
 * | 3 | A failed read renders the fallback, never a hole | a platform outage empties the sidebar and the hero |
 * | 4 | A failed read stays distinguishable from "nothing is set" | an outage is reported as a tenant that never configured anything |
 * | 5 | The two hero occupants keep the owner's own copy and pill class | the KVVI hero shows a different headline or an unstyled badge |
 *
 * The store is fed with `createBrandingStore().create()` and the framework
 * hooks are plain stubs: this tier asserts presentation, not the read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { CompanyBrandMark, CompanyBrandName, HeroBadge, HeroHeadline, KvviMark } from '../src/client/Brand.tsx'
import { createBrandingStore } from '../src/client/stores.ts'
import type { BrandingState, BrandingStore } from '../src/client/stores.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

/** The product name as the build injects it (the one source of that name). */
const PRODUCT_NAME = 'KVVI 工作台'

/** The conversation package's two entries, as its own dictionary holds them. */
const CONVERSATION_COPY: Record<string, string> = {
  'hero.headline': '探索未至之境',
  'hero.preview': '预览版',
}

/** The `t` seat the framework binds for `locale: 'conversation'`. */
const t: PropsLocale<'conversation'>['t'] = key => CONVERSATION_COPY[key] ?? key

/** The owner's pill class, as the hero passes it at its render site. */
const PILL = 'previewBadge'

/** A framework hook seat over one fixed snapshot. */
function seat(state: BrandingState): PropsStore<BrandingStore> {
  return {
    useStore: <S,>(selector: (snapshot: BrandingState) => S): S => selector(state),
    // Present because the share derives from the declared store handle, not
    // because an occupant writes: none of these five ever calls an action.
    actions: { loaded: (): void => undefined, failed: (): void => undefined },
  }
}

/** A successful read that found nothing: the default state of a company. */
const UNCONFIGURED: BrandingState = {
  status: 'ready', branding: { name: null, logoUrl: null, tagline: null }, failure: null,
}

/** A company that stated all three values. */
const CONFIGURED: BrandingState = {
  status: 'ready',
  branding: { name: '示例公司', logoUrl: '/assets/example.svg', tagline: '让每一件事都有据可查' },
  failure: null,
}

/** A read that never reached the platform. */
const UNREACHABLE: BrandingState = {
  status: 'failed', branding: null, failure: { kind: 'unreachable', detail: 'Error: ECONNREFUSED' },
}

/** A read the platform refused. */
const REFUSED: BrandingState = {
  status: 'failed', branding: null, failure: { kind: 'refused', code: 'KVVI_SESSION_REQUIRED' },
}

/** A read that has not settled yet. */
const PENDING: BrandingState = { status: 'loading', branding: null, failure: null }

/** One store instance carrying the state under test. */
function storeOf(state: BrandingState) {
  const store = createBrandingStore().create()
  if (state.status === 'ready' && state.branding !== null) store.actions.loaded(state.branding)
  if (state.status === 'failed' && state.failure !== null) store.actions.failed(state.failure)
  return store
}

describe('brand occupants without company branding', () => {
  it('renders the KVVI mark and the product name', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', PRODUCT_NAME)
    const mark = render(<CompanyBrandMark size={24} {...seat(UNCONFIGURED)} />)
    // The mark is the drawn artwork, not a logo image.
    expect(mark.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 21.38')
    expect(mark.container.querySelector('img')).toBeNull()
    mark.unmount()

    const name = render(<CompanyBrandName {...seat(UNCONFIGURED)} />)
    expect(name.getByText(PRODUCT_NAME)).toBeTruthy()
  })

  it('leaves the hero on the owner\u2019s own headline and pill', () => {
    const headline = render(<HeroHeadline {...seat(UNCONFIGURED)} t={t} />)
    expect(headline.getByText('探索未至之境')).toBeTruthy()
    headline.unmount()

    const badge = render(<HeroBadge className={PILL} {...seat(UNCONFIGURED)} t={t} />)
    // The pill keeps the class the hero handed over, so the badge that was
    // there before this package existed is still the badge that is there now.
    expect(badge.container.querySelector(`span.${PILL}`)?.textContent).toBe('预览版')
  })

  it('renders the same fallbacks before the read settles', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', PRODUCT_NAME)
    const mark = render(<CompanyBrandMark size={24} {...seat(PENDING)} />)
    expect(mark.container.querySelector('svg')).not.toBeNull()
    mark.unmount()

    const name = render(<CompanyBrandName {...seat(PENDING)} />)
    expect(name.getByText(PRODUCT_NAME)).toBeTruthy()
    name.unmount()

    const headline = render(<HeroHeadline {...seat(PENDING)} t={t} />)
    expect(headline.getByText('探索未至之境')).toBeTruthy()
    headline.unmount()

    const badge = render(<HeroBadge className={PILL} {...seat(PENDING)} t={t} />)
    expect(badge.container.querySelector(`span.${PILL}`)?.textContent).toBe('预览版')
  })
})

describe('brand occupants with company branding', () => {
  it('renders the company logo, name, and tagline', () => {
    const mark = render(<CompanyBrandMark size={24} {...seat(CONFIGURED)} />)
    const logo = mark.container.querySelector('img')
    expect(logo?.getAttribute('src')).toBe('/assets/example.svg')
    expect(logo?.getAttribute('width')).toBe('24')
    expect(logo?.getAttribute('height')).toBe('24')
    // Decorative: the name beside it carries the accessible text.
    expect(logo?.getAttribute('alt')).toBe('')
    mark.unmount()

    const name = render(<CompanyBrandName {...seat(CONFIGURED)} />)
    expect(name.getByText('示例公司')).toBeTruthy()
    name.unmount()

    const headline = render(<HeroHeadline {...seat(CONFIGURED)} t={t} />)
    expect(headline.getByText('让每一件事都有据可查')).toBeTruthy()
  })

  it('keeps the hero mark\u2019s host geometry for the logo', () => {
    const mark = render(<CompanyBrandMark size={34} className="fish" {...seat(CONFIGURED)} />)
    const logo = mark.container.querySelector('img')
    expect(logo?.getAttribute('class')).toBe('fish')
    expect(logo?.getAttribute('width')).toBe('34')
  })

  it('removes the preview badge once the company has stated a brand', () => {
    const badge = render(<HeroBadge className={PILL} {...seat(CONFIGURED)} t={t} />)
    // Not an empty pill: the whole element, border and padding included, is
    // inside the slot, so nothing is left beside the customer's tagline.
    expect(badge.container.innerHTML).toBe('')
  })

  it('hides the badge for any stated brand, and falls back per field', () => {
    // A company that set only a name: the mark keeps the KVVI artwork, the
    // name is the company's, and the badge — a product statement rather than
    // a field — is already gone.
    const named: BrandingState = {
      status: 'ready', branding: { name: '示例公司', logoUrl: null, tagline: null }, failure: null,
    }
    const mark = render(<CompanyBrandMark size={24} {...seat(named)} />)
    expect(mark.container.querySelector('svg')).not.toBeNull()
    mark.unmount()

    const badge = render(<HeroBadge className={PILL} {...seat(named)} t={t} />)
    expect(badge.container.innerHTML).toBe('')
    badge.unmount()

    const headline = render(<HeroHeadline {...seat(named)} t={t} />)
    expect(headline.getByText('探索未至之境')).toBeTruthy()
  })
})

describe('brand occupants when the read fails', () => {
  it('renders the built-in brand rather than a hole when the platform is unreachable', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', PRODUCT_NAME)
    const mark = render(<CompanyBrandMark size={24} {...seat(UNREACHABLE)} />)
    expect(mark.container.querySelector('svg')).not.toBeNull()
    mark.unmount()

    const name = render(<CompanyBrandName {...seat(UNREACHABLE)} />)
    expect(name.getByText(PRODUCT_NAME)).toBeTruthy()
    name.unmount()

    const headline = render(<HeroHeadline {...seat(UNREACHABLE)} t={t} />)
    expect(headline.getByText('探索未至之境')).toBeTruthy()
    headline.unmount()

    const badge = render(<HeroBadge className={PILL} {...seat(UNREACHABLE)} t={t} />)
    expect(badge.container.querySelector(`span.${PILL}`)?.textContent).toBe('预览版')
  })

  it('renders the built-in brand when the platform refuses the read', () => {
    vi.stubEnv('DSH_CLIENT_TITLE', PRODUCT_NAME)
    const name = render(<CompanyBrandName {...seat(REFUSED)} />)
    expect(name.getByText(PRODUCT_NAME)).toBeTruthy()
  })

  it('keeps "refused", "unreachable", and "nothing set" as three different states', () => {
    // The store, not the pixels: both failures render the fallback, so the
    // only place an operator can tell an outage from an unconfigured tenant
    // is the state itself.
    expect(storeOf(REFUSED).getSnapshot()).toEqual(REFUSED)
    expect(storeOf(UNREACHABLE).getSnapshot()).toEqual(UNREACHABLE)
    expect(storeOf(UNCONFIGURED).getSnapshot()).toEqual(UNCONFIGURED)
  })
})

describe('the KVVI mark itself', () => {
  it('keeps its host class and scales from the requested edge', () => {
    const mark = render(<KvviMark size={34} className="fish" />)
    const svg = mark.container.querySelector('svg')
    expect(svg?.getAttribute('class')).toBe('fish')
    expect(svg?.getAttribute('width')).toBe('34')
    // The 24:21.38 artwork keeps its ratio at every requested edge.
    expect(Number(svg?.getAttribute('height'))).toBeCloseTo((34 * 21.38) / 24)
  })
})

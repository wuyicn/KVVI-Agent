/**
 * KVVI's occupants for the Web shell's brand slots.
 *
 * ── What each one decides ───────────────────────────────────────────────────
 *
 * | Slot | With company branding | Without |
 * |---|---|---|
 * | `sidebar.brand.mark` | the company logo | the KVVI mark |
 * | `sidebar.brand.name` | the company name | the product name |
 * | `conversation.hero.brand.mark` | the company logo | the KVVI mark |
 * | `conversation.hero.title` | the company tagline | the conversation's own headline |
 * | `conversation.hero.badge` | nothing | the conversation's own badge |
 *
 * ── The product name has one source, and it is not this file ────────────────
 *
 * `DSH_CLIENT_TITLE` is the build's product identity: it already titles the
 * browser document and the layout's product header. Restating it here would
 * give the product two names that can drift apart, so the name occupant reads
 * that same build value and owns no literal of its own. The hero copy comes
 * from the conversation package's dictionary for the same reason — those two
 * occupants declare `locale: 'conversation'` and translate the owner's own
 * entry rather than copying it.
 *
 * ── Every arm renders something ─────────────────────────────────────────────
 *
 * A pending or failed read renders the built-in KVVI brand, never a hole: the
 * brand row and the hero are always on screen, and an outage in the platform
 * must not empty them. The store keeps that failure distinguishable from "this
 * company set nothing" for whoever has to act on it.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeroBadgeOwnerProps, HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandNameOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { companyNameOf, hasBranding, logoUrlOf, taglineOf } from './stores.ts'
import type { BrandingStore } from './stores.ts'

/** Native viewBox of {@link KVVI_MARK_PATH} (width and height in user units). */
const KVVI_MARK_VIEWBOX = { width: 24, height: 21.38 }

/**
 * The KVVI mark outline, normalized from the design source (a CorelDRAW export
 * on a 42333x58208 canvas) to a 24-unit-wide viewBox. Only the initial `M` is
 * absolute, so the artwork translates and scales as one unit.
 */
const KVVI_MARK_PATH = 'M0.5001 0.4112l4.848 0 0 4.9391 -4.848 6.8549 0 -11.794zm-0.0385 13.3923l1.8711 3.1329 2.3524 3.925 -4.2236 0 0 -7.0579zm9.2013 -7.6537l-4.8357 6.7163 4.8375 8.1041 4.8176 0 -4.8503 -8.0863 4.8483 -6.734 -4.8175 0zm9.0561 0l-4.8355 6.7163 4.8375 8.1041 4.8175 0 -4.8503 -8.0863 4.8483 -6.734 -4.8175 0z'

/** Owner share and store seat shared by both brand-mark occupancies. */
type BrandMarkProps = HeroBrandMarkOwnerProps & PropsStore<BrandingStore>

/** Owner share and store seat of the sidebar brand-name occupancy. */
type BrandNameProps = SidebarBrandNameOwnerProps & PropsStore<BrandingStore>

/** Store and locale seats of the two hero copy occupancies. */
type HeroCopyProps = PropsStore<BrandingStore> & PropsLocale<'conversation'>

/**
 * Render the KVVI mark at the geometry its host asked for. Painting in
 * `currentColor` lets one mark follow both themes.
 * @param props - host mark geometry (the hero's owner bag, which is the wider one).
 * @returns the KVVI mark svg (decorative; the name occupant carries the accessible name).
 */
export function KvviMark({ size, className }: HeroBrandMarkOwnerProps): ReactNode {
  return (
    <svg
      width={size}
      height={(size * KVVI_MARK_VIEWBOX.height) / KVVI_MARK_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${KVVI_MARK_VIEWBOX.width} ${KVVI_MARK_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={KVVI_MARK_PATH} fill="currentColor" />
    </svg>
  )
}

/**
 * Render the company's logo in the brand mark, or the KVVI mark when the
 * company has not set one.
 *
 * The logo is decorative — both hosts place the mark beside a name, and the
 * name carries the accessible text. `object-fit: contain` keeps a wide logo
 * inside the square edge the host asked for instead of squashing it.
 * @param props - host mark geometry plus the branding store seat.
 * @returns the logo image, or the KVVI mark.
 */
export function CompanyBrandMark({ size, className, useStore }: BrandMarkProps): ReactNode {
  const logoUrl = useStore(logoUrlOf)
  if (logoUrl === null) return <KvviMark size={size} className={className} />
  return (
    <img
      className={className}
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      style={{ objectFit: 'contain' }}
    />
  )
}

/**
 * Render the company's name beside the independently slotted mark, or the
 * product's own name when the company has not set one.
 *
 * The name is build-time product identity rather than per-locale copy: the same
 * `DSH_CLIENT_TITLE` value already titles the browser document and the in-app
 * product header, so reading it here keeps one home for the product name.
 * @param props - the branding store seat.
 * @returns the product name.
 */
export function CompanyBrandName({ useStore }: BrandNameProps): ReactNode {
  const name = useStore(companyNameOf)
  return <span>{name ?? process.env.DSH_CLIENT_TITLE}</span>
}

/**
 * Render the company's tagline in the hero, or the conversation's own headline
 * when the company has not set one.
 * @param props - the store and locale seats.
 * @returns the headline copy.
 */
export function HeroHeadline({ useStore, t }: HeroCopyProps): ReactNode {
  return useStore(taglineOf) ?? t('hero.headline')
}

/**
 * Render the hero badge, or nothing once the company has stated a brand.
 *
 * The badge is the product's own statement about itself; beside a customer's
 * tagline it says the wrong thing about whose product this is. Rendering null
 * removes the host's pill along with it, which is why the whole pill — class
 * included — travels through the slot rather than only its copy.
 * @param props - host pill class, the store seat, and the locale seat.
 * @returns the badge, or null.
 */
export function HeroBadge({ className, useStore, t }: HeroBadgeOwnerProps & HeroCopyProps): ReactNode {
  return useStore(hasBranding) ? null : <span className={className}>{t('hero.preview')}</span>
}

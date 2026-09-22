import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Native viewBox of {@link KVVI_MARK_PATH} (width and height in user units). */
const KVVI_MARK_VIEWBOX = { width: 24, height: 21.38 }

/**
 * The KVVI mark outline, normalized from the design source to a 24-unit-wide
 * viewBox. Only the initial `M` is absolute, so the artwork translates and
 * scales as one unit.
 */
const KVVI_MARK_PATH = 'M0.5001 0.4112l4.848 0 0 4.9391 -4.848 6.8549 0 -11.794zm-0.0385 13.3923l1.8711 3.1329 2.3524 3.925 -4.2236 0 0 -7.0579zm9.2013 -7.6537l-4.8357 6.7163 4.8375 8.1041 4.8176 0 -4.8503 -8.0863 4.8483 -6.734 -4.8175 0zm9.0561 0l-4.8355 6.7163 4.8375 8.1041 4.8175 0 -4.8503 -8.0863 4.8483 -6.734 -4.8175 0z'

/**
 * Render the product mark with the presentation requested by its host surface.
 * Painting in `currentColor` lets one mark follow both themes.
 * @param props - Host-supplied mark presentation.
 * @returns the product mark svg (aria-hidden; the name occupant carries the accessible name).
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg
      width={size}
      height={(size * KVVI_MARK_VIEWBOX.height) / KVVI_MARK_VIEWBOX.width}
      viewBox={`0 0 ${KVVI_MARK_VIEWBOX.width} ${KVVI_MARK_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={KVVI_MARK_PATH} fill="currentColor" />
    </svg>
  )
}

/**
 * Render the product name beside the independently slotted mark.
 *
 * The name is build-time product identity rather than per-locale copy: the same
 * `DSH_CLIENT_TITLE` value already titles the browser document
 * (`apps/web/vite.config.ts`) and the in-app product header (`AppFrame.tsx`),
 * so reading it here keeps one home for the product name. Both slot occupants
 * register only for a named build profile, which sets this value with them.
 * @returns the product name.
 */
export function OfficialBrandName() {
  return <span>{process.env.DSH_CLIENT_TITLE}</span>
}

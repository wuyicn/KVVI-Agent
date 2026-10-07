/**
 * KVVI brand plugin, node half. The empty apply gives Loader a host-side row
 * while the browser half ships through `exports["./client"]`.
 *
 * This package is the KVVI fork's own brand occupant: it fills the sidebar's
 * brand slots and the conversation hero's brand, headline, and badge slots. The
 * sidebar slots are free because upstream's `ui-brand-official` registers into
 * them only under the `official` build profile, which KVVI's builds do not set;
 * the hero's headline and badge are declared by `ui-conversation` (a locale
 * dictionary cannot be retranslated by a second package), and this one fills
 * them.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}

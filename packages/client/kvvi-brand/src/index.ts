/**
 * KVVI brand plugin, node half. The empty apply gives Loader a host-side row
 * while the browser half ships through `exports["./client"]`.
 *
 * This package is the KVVI fork's own brand occupant. Upstream's
 * `ui-brand-official` registers into the same slots but only under the
 * `official` build profile, which KVVI's builds do not set — so the slots are
 * free for this package to take, and no upstream source file needed editing.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply(): void {}

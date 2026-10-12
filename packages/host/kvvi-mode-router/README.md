# @deepseek-ai/dsh-host-kvvi-mode-router

Binds every DSH Remote request to one signed KVVI identity and one fixed agent preset.

## Model Experience

This package adds no tool, no prompt section, and no session event. What it changes is *which* preset a session may load: `USER` is pinned to `kvvi-worker` and `BUILDER` to `kvvi-builder`, so a session's tool catalog is decided before the first turn rather than by what a request asks for.

`agentPresets.select` is wrapped rather than replaced, and `assertPresetAllowed` throws `KVVI_PRESET_LOCKED_TO_SESSION_MODE` for any other request. The visible effect on a model is that the worker mode has no builder tools at all — not that they are hidden, but that they were never in its composition.

Token cost is zero from this package. It filters session lists and control streams, which changes *which* sessions appear, not how many tokens any of them carry.

## Configuration

| Field | Required | Meaning |
|---|---|---|
| `secret` | yes | The runtime-context secret, identical to the platform's `KVVI_INTERNAL_TOKEN`. An empty value throws `KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED` at construction. |

## What it binds

| Surface | Enforcement |
|---|---|
| `connection/request` | Verifies `x-kvvi-*` before the rest of the request runs; a bad signature is `401` and nothing downstream sees the request. |
| `typert-gateway/upgrade` | Same verification, re-applied per socket event so a WebSocket frame cannot escape the context that opened it. |
| `typert-gateway/request` | `authorizeRuntimeRequest` rejects any Remote the mode does not own. |
| `typert-gateway/project` | Frames are projected through the owning session, so a frame from another mode's session is not delivered. |
| `sessionController.create/list/search/control` | Session ids are namespaced by company, user, and mode; a known id from another namespace is `KVVI_SESSION_ACCESS_DENIED`. |
| `agentPresets.select` | Preset pinned to the mode; anything else throws. |

`requireMode()` is the package's public read for everything else: the business tools call it to obtain the identity they sign with, and it throws `KVVI_RUNTIME_CONTEXT_REQUIRED` outside a bound request rather than falling back to an anonymous identity.

## Managed business storage

New-business starts use `POST /api/kvvi-business-directory/:intentId` after the original connection trust and signed-identity checks. Only `BUILDER` may allocate storage. The absolute, operator-configured `DSH_HOME` must exist; files live below `business-workspaces/<identity-hash>/<intent-uuid>`. Business names and browser-supplied paths do not select directories. An ownership marker permits retries, while links and unmarked existing leaves are refused. Allocation returns `403` for worker mode, `400` for an invalid UUID, or `503` when storage is unavailable. This creates draft storage only and does not approve or publish a business.

## Known Limitations and Deferred Work

- **Draft preview is not publication validation.** `GET /api/kvvi-builder-preview/:intentId` serves an inert projection of the fixed six-file registration layout from the authenticated builder's managed directory. It verifies the company/asset binding, ownership marker and supported controls; linked, missing, oversized, changing or unsupported files fail closed. It allocates no storage and returns no permission policies. Its digest identifies the read content, not an approved revision. Every result is `validation: not_checked` and `canSubmit: false`.

- **The session is bound by request, not by turn.** `requireMode()` reads an `AsyncLocalStorage` store set when the request entered. Work a session starts *after* the originating request has returned — a scheduled follow-up, a background job that resumes later — runs without that store and reads as `KVVI_RUNTIME_CONTEXT_REQUIRED`. Binding identity to the session itself is the fix, and it is deferred because it changes where the identity lives for every consumer.
- **Server-side session fork is refused, not implemented.** `KVVI_SESSION_FORK_DISABLED` stands until a fork target can be named safely by the server; a client-supplied target id cannot be trusted to stay inside the caller's namespace.
- **Preset pinning is per-request, not per-session-record.** A preset cannot change mid-session, but the guarantee is enforced by this wrapper rather than by a field on the session row, so a caller that bypasses the wrapper would bypass it too.

**Runtime invariant:** No companion is published. Mode binding is checked on the request path it wraps, and the widened surfaces are restored by the effect that widened them.

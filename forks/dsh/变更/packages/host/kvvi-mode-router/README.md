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
| `agent/created` | An authenticated, namespaced Agent with the matching preset receives an immutable copy of its verified platform identity, tied to the exact live Agent and Session objects. |
| `tools/pre-execute`, `tools/execute`, `approval/request` | Restore the Agent's original platform identity before policy, approval answerers, and tool bodies run; unknown Agents or conflicting current callers fail closed. |

`requireMode()` is the package's public read for everything else: business and publish tools obtain the identity they sign with through it. Authenticated creation/resume binds the live Agent before DSH releases queued goal work. Later tools recover that exact platform session, including when the original request scope is absent. Every read inside a tool or approval context rechecks the exact live binding, so disposing the Agent or replacing its Session while approval is pending refuses the resumed operation before it signs a platform request. A current caller with a different platform session, company, user, or mode receives `KVVI_SESSION_ACCESS_DENIED`; it cannot replace the original identity even within the same owner namespace. Tool arguments and session-id strings never supply an identity. Every actual platform operation still validates the live platform session and its current permissions.

## Known Limitations and Deferred Work

- **Background identity lasts only for the exact live Agent and Session in this router process.** Bindings are not serialized and are removed when the Agent is disposed. After a process/router restart, an automatically resumed Agent has no trusted binding and platform tools fail with `KVVI_RUNTIME_CONTEXT_REQUIRED`. A fresh authenticated creation/resume is required; parsing an existing namespaced id cannot recover credentials. Replacing the Session object also refuses continuation. Generic background code outside the tool/approval waterfalls still requires an authenticated request scope.
- **Server-side session fork is refused, not implemented.** `KVVI_SESSION_FORK_DISABLED` stands until a fork target can be named safely by the server; a client-supplied target id cannot be trusted to stay inside the caller's namespace.
- **Preset pinning is per-request, not per-session-record.** A preset cannot change mid-session, but the guarantee is enforced by this wrapper rather than by a field on the session row, so a caller that bypasses the wrapper would bypass it too.

**Runtime invariant:** No companion is published. Request verification and the tool/approval wrappers enforce identity at their call sites. The exact live-object association is process-local, and wrapped service methods are restored by the effect that widened them.

`pnpm test` includes the YAML Loader composition test: a real authenticated HTTP request creates an Agent, then the background business executor asks for approval and signs the original platform session. The test checks one-shot approval, rejection without a state POST, platform session revocation without retry, and the turn-enclosed approval audit trace. Only the external platform HTTP responder and unused GUI facades are fixtures; the identity router, Agent factory, tool runtime, approval service, and business executor are real plugins.

---
description: "How a deployed KVVI company's business data becomes model-facing tools: the identity path from the platform's signed session context, the closed tool set, and the tools deliberately not registered." kind: "subsystem"
---

# KVVI business tools

## Summary

[`packages/tool/kvvi-business`](../../packages/tool/kvvi-business/README.md) exposes one deployed company's records, their declared fields, and its workflow to the Worker Agent as seven model-facing tools. Every one of them is an HTTP call into **that company's own platform service**, under **the signed-in employee's identity** — the same execution point the web panel calls. The Agent therefore holds no authorization logic of its own: whatever the system permits the employee, the Agent may do on their behalf, and whatever it refuses, it refuses the Agent too.

That is the whole design. Everything below is either the identity path that makes it literally true, or the boundary that keeps it true as the tool set grows.

## Table of Contents

- [The identity path](#the-identity-path)
- [Why the runtime signs instead of carrying a token](#why-the-runtime-signs-instead-of-carrying-a-token)
- [The closed tool set](#the-closed-tool-set)
- [Refusals are codes, not sentences](#refusals-are-codes-not-sentences)
- [Tools that are deliberately not registered](#tools-that-are-deliberately-not-registered)
- [Dev Note](#dev-note)

-----

<a id="the-identity-path"></a>
## The identity path

```
browser ──login──▶ platform ──signed context──▶ runtime ──tool call──▶ platform
                   (§4.6.5)     (x-kvvi-*)       (mode router)          /api/v1
```

Four facts hold at every arrow:

1. **The platform is the only entry.** The runtime has no host-network port, so a browser cannot reach it directly and cannot forge the context headers.
2. **The runtime verifies before it stores.** `kvvi-mode-router` checks the signature, the age, and the gateway on every request, and only then runs the rest of the request inside that context.
3. **The tool reads the context, never the arguments.** `ctx.kvviModeRouter.requireMode()` is the only source of identity. A model that emits `tenant: other` does not reach that field, because no tool declares it and `assertNoIdentityFields` refuses the call before it is sent.
4. **The platform resolves the session row, not the header.** The signed headers name a session; the row decides the company, the user, and the gateway. The two are compared field by field, so a context signed for one user cannot act as another and a `USER` session cannot be used as a `BUILDER` one.

<a id="why-the-runtime-signs-instead-of-carrying-a-token"></a>
## Why the runtime signs instead of carrying a token

A tool executes inside the Node process, not in a browser tab. It holds no session cookie and no delegation token — those belong to the browser, and at that moment there is no browser. Copying a user token into the runtime would be worse than signing: a token is bearer credentials, so anything in the runtime that could read it could act as that employee indefinitely, while a signed context expires in 60 seconds and names the session it was minted for.

The wire format is one format with two implementations (the platform's `runtime-auth.mjs` and this package's `client.ts`). Two implementations of one format drift, so the stage-10 checker signs in one process and verifies in the other and compares the bytes; a drift fails the gate rather than production.

<a id="the-closed-tool-set"></a>
## The closed tool set

| Tool | Platform call | Writes? |
|---|---|---|
| `record_schema` | `GET /systems/:id/fields` | no |
| `record_list` | `GET /systems/:id/records` | no |
| `record_get` | `GET /systems/:id/records/:rid` | no |
| `record_create` | `POST /systems/:id/records` | yes |
| `record_update` | `PATCH /systems/:id/records/:rid` | yes |
| `workflow_available_actions` | `GET /systems/:id/records/:rid/actions` | no |
| `workflow_act` | `POST /systems/:id/records/:rid/transitions` | yes |

The `:rid` segment accepts the record's id or its record number (`R-20261006-000003`). The platform resolves a record number within the session's company and the named system, so `record_create`'s `recordNo` is a usable argument to `record_get` without reading the record back first.

The `kvvi-worker` preset carries exactly these seven, plus `ask_user`, and nothing that can build, run a command, read a file, or fetch a URL. That is a boundary, not a short list: a mode that can run commands is a mode whose permissions cannot be reasoned about, because the command need not go through the platform at all.

`record_update` and `workflow_act` both require `rowVersion`, and the platform refuses a stale one. A transition also changes the record, so it carries the version for the same reason a field edit does — a workflow that let last-writer-win would push an already-approved request back to pending.

<a id="refusals-are-codes-not-sentences"></a>
## Refusals are codes, not sentences

Every tool reports the platform's own stable code. `KVVI_SELF_APPROVAL_FORBIDDEN` is the same string whether it came from the panel or the Agent, and G8's acceptance criterion is exactly that: for one account, one action, and one data scope, the two channels agree on allow/deny and on the result.

Codes are not decoration. A model that reads `KVVI_ROW_VERSION_CONFLICT` can decide to re-read the record; a model that reads "the update failed" retries the same request forever. The tool descriptions say so explicitly for the two codes where the right next step is a decision rather than a retry.

<a id="tools-that-are-deliberately-not-registered"></a>
## Tools that are deliberately not registered

**`aggregate_read`.** The platform serves no aggregate endpoint, and §9.8.1 makes one non-trivial: whoever sees an aggregate must be able to see every constituent row, so a total cannot be computed from a filtered page — a `COMPANY`-wide sum handed to someone scoped to `SELF` leaks the very rows they may not read. Serving it needs the query engine and the scope algebra behind it, not a tool wrapper. Registering a tool that refuses every call would cost a tool slot, teach the model to retry something it can never complete, and make the capability gap look like a bug rather than a missing subsystem.

**`workflow_act` was in this list until Stage 10.** The workflow runtime (`judgeTransition` / `step`) existed since Stage 7, but no HTTP route reached it, so the Stage 9 panel shipped without transition buttons. Stage 10 added `.../actions` and `.../transitions`, which is what made both the tool and the detail-view buttons possible. The lesson is recorded here because it is the recurring one: an implemented capability with no entry point is, from outside, indistinguishable from an unimplemented one.

-----

<a id="dev-note"></a>
## Dev Note

**Why these tools are not in `core/`.** Every other tool group answers "what harness capability does this implement?" — bash, files, web, subagents. These answer "what does *this customer's* business data look like to a model?", and that answer changes with the customer's contracts rather than with the harness. Putting them beside the harness's own tools would mean the harness's capability map grows a row per deployment.

**Why the preset pins the platform URL and secret with no default.** `platformUrl: !!js process.env.KVVI_PLATFORM_URL ?? 'http://127.0.0.1:7400'` and `contextSecret: !!js process.env.KVVI_INTERNAL_TOKEN ?? ''` — the URL default is the development topology, and the empty secret makes `apply` throw `KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED` at load. A default secret would be a shared secret committed to a repository, and a silently-defaulted URL would point a worker at the wrong deployment while looking healthy.

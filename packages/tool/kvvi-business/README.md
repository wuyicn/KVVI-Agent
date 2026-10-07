# @deepseek-ai/dsh-tool-kvvi-business

Model-facing business tools over a deployed KVVI company's platform API.

## Model Experience

Eight tools reach the model in the `kvvi-worker` preset. Each is one HTTP call into the customer's own platform service under the signed-in employee's identity, so the tool result is exactly what that employee would see in the panel — the same row scope, the same field visibility, the same refusals. `record_schema` reads the structure rather than the data: the field codes a payload must use, which of them are required, and what an enum accepts.

The tools are the only thing this package contributes. They add no prompt section, no session event, and no system instruction; the persona that explains what the mode is lives in the preset. Descriptions are written for the model's decision, not for a human reader: they say which code means "re-read and decide" and which means "this is a rule, not a missing permission".

Results render the complete schema-validated platform value as JSON into model-visible text, including visible record values, field labels, enum options, workflow destinations and row versions. The platform remains responsible for filtering rows and fields. `system_list` projects only names and codes from the company catalogue, discarding publication metadata. The employee persona presents business results and keeps internal metadata out of ordinary replies.

Token cost is one tool schema per tool, eight schemas total, with flat argument objects. No package-level cache is added. Rendered results remain in normal conversation history and contribute to subsequent context and KV-cache usage; record_list may return up to 50 rows. Prefer record_get when a record reference is known.

## Configuration

| Field | Required | Meaning |
|---|---|---|
| `platformUrl` | yes | Base URL of the KVVI platform service, without `/api/v1`. |
| `contextSecret` | yes | The shared runtime-context secret; the same value the platform verifies with. |

Neither has a working default. An empty `contextSecret` throws `KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED` at load rather than at the first tool call, because a tool that authenticates to nothing fails in a way that reads as a platform outage.

## Registered tools

| Tool | Writes | Notes |
|---|---|---|
| `system_list` | no | Company catalogue of published system names and exact codes. It does not grant access to records. |
| `record_schema` | no | The system's declared fields — the codes `data` accepts. Read it before writing; an unlisted code is `KVVI_FIELD_NOT_DECLARED`. Fields this session may not see are absent, and `hiddenFieldCount` says how many. |
| `record_list` | no | Rows and fields already filtered by the platform. |
| `record_get` | no | Returns the `rowVersion` the two writes need. |
| `record_create` | yes | Flat `data` map of field code to value. |
| `record_update` | yes | `rowVersion` required; a stale one is `KVVI_ROW_VERSION_CONFLICT`. |
| `workflow_available_actions` | no | Contract and flow permissions already applied; an empty list means no legal next step. |
| `workflow_act` | yes | `action` must come from `workflow_available_actions`; `rowVersion` required. |

## Identity

`ctx.kvviModeRouter.requireMode()` is the only source of identity, and it is read at execution rather than at load. `assertNoIdentityFields` then refuses any argument tree containing `companyId`, `tenant`, `actor`, `roles`, `gateway`, or `userId` at any depth, before a request is built — record payloads are nested by nature, so a top-level-only check would pass exactly the request that matters.

## The `id` argument

The four record tools take `id`, and it accepts **either** the record's id **or** its record number (`recordNo`, e.g. `R-20261006-000003`). The platform resolves a record number within the session's company and the named system, so a freshly created record is reachable by the number `record_create` returned, without reading it back first.

The argument descriptions spell this out because the model cannot infer it: `record_create` returns `recordNo` while `record_get` and `record_list` return `recordId`, and a model holding only the number has no way to learn that the number is accepted. An earlier incident ended with a record number pasted into an id lookup, an internal-error answer, and the model concluding the record was unreadable to its session.

## Known Limitations and Deferred Work

- **`aggregate_read` is not registered.** The platform serves no aggregate endpoint, and §9.8.1 requires that whoever sees an aggregate can see every constituent row, so a total cannot be computed from a filtered page. Registering a tool that refuses every call would cost a tool slot and train the model to retry something it can never complete.
- **The platform URL and secret come from the environment**, so a deployment that forgets one gets a load failure rather than a degraded tool. That is deliberate; the empty secret is the load-time assertion.
- **No test here covers the wire format against the platform's verifier.** This package ships standalone inside the fork, so a test importing the platform's sources would pass only in the KVVI-Agent working tree. The cross-process check runs in `工具/check_stage10.py`, which signs here and verifies there.
- **Tool results are not paginated.** `record_list` returns the platform's default page (50 rows) and there is no argument to ask for more.

**Runtime invariant:** No companion is published. Every observation these tools make is a platform response, and the platform owns the relationships behind it.

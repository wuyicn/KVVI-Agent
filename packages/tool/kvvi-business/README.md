# @deepseek-ai/dsh-tool-kvvi-business

Model-facing business tools over a deployed KVVI company's platform API.

## Model Experience

Six tools reach the model in the `kvvi-worker` preset. Each is one HTTP call into the customer's own platform service under the signed-in employee's identity, so the tool result is exactly what that employee would see in the panel — the same row scope, the same field visibility, the same refusals.

The tools are the only thing this package contributes. They add no prompt section, no session event, and no system instruction; the persona that explains what the mode is lives in the preset. Descriptions are written for the model's decision, not for a human reader: they say which code means "re-read and decide" and which means "this is a rule, not a missing permission".

Token cost is one tool schema per tool, six schemas total, with flat argument objects. Nothing here caches or re-sends business data between calls, so no tool result affects the KV cache beyond the turn that produced it.

## Configuration

| Field | Required | Meaning |
|---|---|---|
| `platformUrl` | yes | Base URL of the KVVI platform service, without `/api/v1`. |
| `contextSecret` | yes | The shared runtime-context secret; the same value the platform verifies with. |

Neither has a working default. An empty `contextSecret` throws `KVVI_RUNTIME_CONTEXT_SECRET_REQUIRED` at load rather than at the first tool call, because a tool that authenticates to nothing fails in a way that reads as a platform outage.

## Registered tools

| Tool | Writes | Notes |
|---|---|---|
| `record_list` | no | Rows and fields already filtered by the platform. |
| `record_get` | no | Returns the `rowVersion` the two writes need. |
| `record_create` | yes | Flat `data` map of field code to value. |
| `record_update` | yes | `rowVersion` required; a stale one is `KVVI_ROW_VERSION_CONFLICT`. |
| `workflow_available_actions` | no | Contract and flow permissions already applied; an empty list means no legal next step. |
| `workflow_act` | yes | `action` must come from `workflow_available_actions`; `rowVersion` required. |

## Identity

`ctx.kvviModeRouter.requireMode()` is the only source of identity, and it is read at execution rather than at load. `assertNoIdentityFields` then refuses any argument tree containing `companyId`, `tenant`, `actor`, `roles`, `gateway`, or `userId` at any depth, before a request is built — record payloads are nested by nature, so a top-level-only check would pass exactly the request that matters.

## Known Limitations and Deferred Work

- **`aggregate_read` is not registered.** The platform serves no aggregate endpoint, and §9.8.1 requires that whoever sees an aggregate can see every constituent row, so a total cannot be computed from a filtered page. Registering a tool that refuses every call would cost a tool slot and train the model to retry something it can never complete.
- **The platform URL and secret come from the environment**, so a deployment that forgets one gets a load failure rather than a degraded tool. That is deliberate; the empty secret is the load-time assertion.
- **No test here covers the wire format against the platform's verifier.** This package ships standalone inside the fork, so a test importing the platform's sources would pass only in the KVVI-Agent working tree. The cross-process check runs in `工具/check_stage10.py`, which signs here and verifies there.
- **Tool results are not paginated.** `record_list` returns the platform's default page (50 rows) and there is no argument to ask for more.

**Runtime invariant:** No companion is published. Every observation these tools make is a platform response, and the platform owns the relationships behind it.

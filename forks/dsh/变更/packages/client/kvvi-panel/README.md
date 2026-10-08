# @deepseek-ai/dsh-client-kvvi-panel

KVVI's business page, authenticated account area and session-bound business tabs for the DSH web client.

## Model Experience

This package contributes browser presentation only; it adds no model-visible input, no session event, and no prompt section. The overlay reads KVVI business data over HTTP from the KVVI platform service, which is outside the session log by design: nothing it displays reaches a model request, so nothing about it needs to be reconstructable from the log.

## Contribution

The package uses the original shell and right-sidebar resource controller. Business navigation appears before plugins; the account contribution opens the original settings dialog. Without an account occupant, the shell keeps its original settings trigger.

| Slot | Contribution |
|---|---|
| `sidebar.panellist` / `main` | Global business entry, system directory and records-first workbench |
| `kvvi.business.session` | Shared session-bound business content and optional embedded AI host |
| `settings.account` | Actual authenticated identity, settings and notification placeholder |
| `conversation.session.header.actions` | Current workspace's form/record shortcuts and successful-write observer |
| `sidebar.right.pane.tab` | Authorized form, list and detail resource bodies |
| `shell.overlay` | Session notice and legacy business overlay |

Business resource URIs contain the asset and, for details, record identity. Opening a business resource uses the existing pane; explicit DSH split, floating and fullscreen actions remain available. The body store is session-scoped and not persisted: a tab and form dialog share drafts, pending writes survive unmount, and successful updates publish a revision so remounted details reload. Success navigation targets the original tab occurrence only while its signal is active. Draft clearing compares the submitted snapshot; submitting locks editors. Runtime model declarations supply layout metadata, while `/fields` gates form visibility and selectable active options. Record writes still use the platform's authorization and row-version checks; masked and readonly columns are omitted from updates.

The notification entry contains no invented messages and no delivery backend. Profile identity comes from `/auth/session`; company role and access remain server-owned.

## Conversation and business emphasis

Workspaces retain the original main Conversation and its session navigation. A new structured successful `record_create` or `record_update` opens that session's records in the original right pane; initial/replayed history does not open panes. In the global Business entry, published records take the main area, form entry stays beside them, and AI is closed until requested. The AI host instantiates the original `conversation.content` Factory with `variant: embedded` and a fixed Chat view. It does not redeclare the main Conversation slot, import another plugin's component, or provide a separate model/send path.

The main business renderer, workspace resources and write observer share one session-scoped store handle. Successful writes invalidate the asset's visible records/details. Main-page navigation also checks the address captured when submitting so a late result does not pull a user back from a different page. The data renderer does not subscribe to token-by-token Conversation snapshots.

Business-to-workspace association currently requires exactly one workspace whose title is the published name, asset code, or name plus 系统. A current main session is reused only if it belongs to that workspace; otherwise the existing `uiWorkspace.connectWorkspace` API reuses/creates a blank session in that workspace. The retained reference is released when leaving/switching the business. Missing or ambiguous associations keep the authenticated standalone forms available and disable AI with a short explanation. Title association is presentation routing, not authorization; every business read/write is still checked by the platform.

Multi-form groups, dashboards/reports, schema design and business create/rename/delete from the 7506 mock are not supplied by these published-system endpoints. This integration does not copy its sample GAD records, fake role selector or instant-rule AI. Existing owner administration stays in the original overlay.

## The closed renderer

A published system carries one `view-schema`, whose `componentsTree` is **data**. The renderer draws it through one explicit table (`src/client/registry.tsx`) whose 23 keys are the names the platform's `COMPONENT_REGISTRY` declares, each with the same `viewTypes`. Everything else about a tree is refused:

| Condition | Result |
|---|---|
| `componentName` not in the table | `KVVI_COMPONENT_NOT_REGISTERED` — nothing is drawn |
| component not allowed in this `view_type` | `KVVI_COMPONENT_WRONG_VIEW_TYPE` — nothing is drawn |
| field component without `fieldBinding` | `KVVI_COMPONENT_FIELD_UNBOUND` — nothing is drawn |
| `Table` (`DataBindingRef`) | `KVVI_TABLE_QUERY_UNSUPPORTED` — see below |

The tree is validated **completely** before anything is drawn, so a contract either appears whole or is refused whole. A half-drawn form reads as a rendering bug, and the employee fills in the rest before discovering the submit cannot work.

`fieldVisibility` is not decided here. The platform computes it from the session and sends it; `HIDDEN` is filtered twice — at render and again when the payload is built, because a form that renders without a field but submits it anyway has carried the hidden value out of the browser. `READONLY` and `MASKED` render as read-only controls, and a `MASKED` value is omitted from the update payload rather than posting the mask back.

## Data sources

| Panel view | Endpoint |
|---|---|
| 我的系统 | `GET /api/v1/systems` |
| the open system's form | `GET /api/v1/systems/:assetId/runtime` |
| 记录 | `GET /api/v1/systems/:assetId/records` |
| one record | `GET`/`PATCH /api/v1/systems/:assetId/records/:recordId` |
| 填单 submit | `POST /api/v1/systems/:assetId/records` |
| 企业管理的品牌页签 | `GET`/`PUT /api/v1/company/branding` |

Failures stay distinguishable: the platform's stable code, a network failure, and "there is nothing" are three separate states, because one shared empty state would report them as the same fact. An update always sends the `rowVersion` it was rendered from, and `KVVI_ROW_VERSION_CONFLICT` is reported as its own state — a conflict needs a reload, a failure needs a retry.

## The brand tab

企业管理 gains a 品牌 half, shown only to an owner (reading the brand is open to
any session — employees see it — while writing is owner-only, and the platform
re-judges both).

`PUT /api/v1/company/branding` leaves any key it is not given **untouched**, so a
save sends only the fields the owner actually changed: sending all three would
clear the two that were not edited, and the platform would report success because
the request itself is well formed. `brandingPatch` is the function that decides
which keys travel, and its spec is the one that keeps a rename from wiping the
logo and the tagline.

A failed read draws the reason and a retry, and no form at all: with no current
values there is no way to compute which keys changed, and a save from that state
could clear all three.

## Known Limitations and Deferred Work

- **A published `LIST` view's `Table` cannot be drawn.** Its `DataBindingRef` names a query the platform has no endpoint for, so the node is refused with `KVVI_TABLE_QUERY_UNSUPPORTED` rather than drawn empty. Drawing an empty table would report "no data" for "no data source". The 记录 half of the panel is the served substitute: it lists the records of the system from the endpoint that exists.
- **The production component registry is still a golden-sample fixture.** The repository carries `COMPONENT_REGISTRY` only inside `样例/黄金样例/*/context.json`. Until a real registry asset exists, this table is hand-kept in step with those samples, and a name added there but not here becomes a refusal rather than a feature.
- **The 记录 table shows model fields, not record metadata.** The record number is a per-row leading cell; `state` and `rowVersion` are not columns. A system that wants to show either in a list needs the `LIST` `Table` binding, which is the item above.
- **The detail view offers no transition button yet.** The platform now serves `GET .../records/:id/actions` and `POST .../records/:id/transitions`, and the detail view shows the current state's label, but it does not yet render the available actions. The Worker Agent does offer them (`workflow_available_actions` / `workflow_act`), so an employee can move a record by asking the agent and not yet by clicking.
- **Copy is locale-owned and English is machine-checked only for key parity.** The dictionaries agree on their key set; the English sentences themselves have had no native review.

**Runtime invariant:** No companion is published. Every panel read goes to the KVVI platform service over HTTP, and the registry table it renders from is a frozen local constant rather than a runtime relationship.

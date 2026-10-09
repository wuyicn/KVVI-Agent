# @deepseek-ai/dsh-client-kvvi-panel

KVVI's business page, authenticated account area and session-bound business tabs for the DSH web client.

## Model Experience

This package contributes browser presentation only; it adds no model-visible input, no session event, and no prompt section. The overlay reads KVVI business data over HTTP from the KVVI platform service, which is outside the session log by design: nothing it displays reaches a model request, so nothing about it needs to be reconstructable from the log.

## Contribution

The package uses the original shell and right-sidebar resource controller. Business navigation appears before plugins; the account contribution opens the original settings dialog. Without an account occupant, the shell keeps its original settings trigger.

| Slot | Contribution |
|---|---|
| `sidebar.panellist` / `main` | Global business entry, grouped form directory and records-first workbench |
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

Business-to-workspace association first checks the asset marker. Without a marker,
automatic association requires a unique legacy title match across the full visible
form catalogue. Explicit selection cannot override a conflicting or unreadable
marker. An unmarked workspace gets a new conversation rather than adopting another
form's conversation or unsent draft; a marked workspace can reuse a session unless
this UI already bound it to another asset. The retained reference is released when
leaving or switching Business. Missing or ambiguous associations keep the same
records-first renderer and navigation available with a separate root-scoped store;
AI stays disabled until a valid workspace is selected. Association grants no record
access; the platform still checks every read and write.

The company directory comes from `/api/v1/business-directory`. Active builders create, rename and dissolve groups, move forms, and archive or restore forms through versioned, idempotent platform APIs. Dissolving a group retains its forms and records. Archiving retains data but stops ordinary use. Employees see only the server-filtered directory; create-only access opens the fill form without listing records. Group membership grants no record permission. Conflicts reload server metadata and require renewed confirmation. Company/login changes clear local drafts and management dialogs. No sample GAD records, fake role selector or instant-rule AI is imported; owner administration stays in the original overlay.

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
| Grouped forms | `GET /api/v1/business-directory` |
| Legacy workspace catalogue | `GET /api/v1/systems` |
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

## Harness business layout (2026-10-08)

The Business main slot opens the first available form directly, with a searchable, collapsible single-level group directory, record table and optional original Conversation pane.
New record opens the authorized form in a modal, posts to the platform and refreshes
records without moving the business page. Search/filter/selection act on returned
rows only; HIDDEN columns are omitted, and masked fields cannot become filters.
The endpoint currently returns at most 50 rows. The footer reports loaded/shown
counts rather than claiming a tenant-wide total or inventing pagination.

`/auth/session.allowedGateways` determines whether New business is discoverable.
An eligible builder currently in USER mode enters the official builder login before
creation. Active `gateway=BUILDER` is still required by every builder callback;
discovery never grants tools or creates resources in USER mode. Starting a business
collects its name, requirements and parent folder; the original Host directory,
Workspace and Session APIs create its builder workspace and send its first request.
The selected group is stored in a server build intent before opening the original
builder conversation. Its logged request gives the intent ID to `publish_submit`;
the platform binds it to the submitted draft, without approving it. Owner-approved
publication queues durable initial placement. A deleted group falls back to
Ungrouped; existing manual placement and archived state win over delayed placement.
It is listed as a published business only after the actual publish flow succeeds.
Within the current page lifetime, a failed start retries only its unfinished
directory, workspace, session or prompt step; prompt retries reuse the submission
identity. Reloading the page does not recover this local setup checkpoint. Existing
same-named folders are never adopted automatically.
Design form resolves a unique matching `.kvvi-system.json` asset marker, never a
workspace title. Otherwise it requires an explicit unmarked workspace selection;
unreadable and mismatching markers refuse. The new conversation edits a draft, not
the employee's currently published version, and still requires owner approval.
No prototype role switch, fake AI reply, sample records or client-only publish state
is imported. Dashboards/reports and permanent record deletion are not exposed by the directory controls.

## Workspace binding and contextual AI

The UI reads `.kvvi-system.json` through the session's original workspace-file
gateway and resolves its `assetId` against the current published catalogue. This
matches the Worker's source of business identity even when the folder and system
names differ. A missing marker permits only a unique legacy name match; malformed,
truncated, inaccessible or unknown markers do not fall back. Binding chooses a
workspace for Conversation and never grants record access. Navigation aborts late
associations and releases any retained session that no longer belongs to the page.
An archived-write refusal closes editing, refreshes the directory and retains the
unsent draft. Read-only retry can reload the form after an authorized restore.

The optional Business assistant shows the current published form and selected
record references. Its question button inserts these references into the visible
original composer and preserves the existing draft; it does not send a message or
inject hidden model input. Only selection identifiers live in the session store,
and a records reload clears selection. Original submission, model blocks, logs,
permissions and the main Workspace welcome screen remain owned by Conversation.

# @deepseek-ai/dsh-client-kvvi-panel

KVVI's business panel for the DSH web client: one sidebar entry plus one overlay page that renders the company's published systems.

## Model Experience

This package contributes browser presentation only; it adds no model-visible input, no session event, and no prompt section. The overlay reads KVVI business data over HTTP from the KVVI platform service, which is outside the session log by design: nothing it displays reaches a model request, so nothing about it needs to be reconstructable from the log.

## Contribution

Two upstream-declared `list` slots are filled, so both registrations append rather than replace another plugin's occupant. Both declare `locale: kvviPanel`, which is what puts the typed `t` seat on their components.

| Slot | Declared by | Contribution |
|---|---|---|
| `sidebar.footer.action` | `ui-sidebar` | the entry at the sidebar foot |
| `shell.overlay` | `ui-layout` | the panel itself |

The two occupy different slots, so neither can render the other. They communicate through one namespaced DOM event (`kvvi-panel:open`) rather than a module-level mutable shared by every consumer.

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

Failures stay distinguishable: the platform's stable code, a network failure, and "there is nothing" are three separate states, because one shared empty state would report them as the same fact. An update always sends the `rowVersion` it was rendered from, and `KVVI_ROW_VERSION_CONFLICT` is reported as its own state — a conflict needs a reload, a failure needs a retry.

## Known Limitations and Deferred Work

- **A published `LIST` view's `Table` cannot be drawn.** Its `DataBindingRef` names a query the platform has no endpoint for, so the node is refused with `KVVI_TABLE_QUERY_UNSUPPORTED` rather than drawn empty. Drawing an empty table would report "no data" for "no data source". The 记录 half of the panel is the served substitute: it lists the records of the system from the endpoint that exists.
- **The production component registry is still a golden-sample fixture.** The repository carries `COMPONENT_REGISTRY` only inside `样例/黄金样例/*/context.json`. Until a real registry asset exists, this table is hand-kept in step with those samples, and a name added there but not here becomes a refusal rather than a feature.
- **The 记录 table shows model fields, not record metadata.** The record number is a per-row leading cell; `state` and `rowVersion` are not columns. A system that wants to show either in a list needs the `LIST` `Table` binding, which is the item above.
- **The detail view offers no transition button yet.** The platform now serves `GET .../records/:id/actions` and `POST .../records/:id/transitions`, and the detail view shows the current state's label, but it does not yet render the available actions. The Worker Agent does offer them (`workflow_available_actions` / `workflow_act`), so an employee can move a record by asking the agent and not yet by clicking.
- **Copy is locale-owned and English is machine-checked only for key parity.** The dictionaries agree on their key set; the English sentences themselves have had no native review.

**Runtime invariant:** No companion is published. Every panel read goes to the KVVI platform service over HTTP, and the registry table it renders from is a frozen local constant rather than a runtime relationship.

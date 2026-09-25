# Stage 9 Runnable System Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn approved MetaSchema contracts into a runnable employee system with forms, lists, details, workflow actions, and dashboards.

**Architecture:** Add an authenticated `/api/v1` router to the plugin-free platform service. Load only published, digest-verified contracts, compile them into a closed runtime projection, and let the DSH client panel render registered components without evaluating generated code.

**Tech Stack:** Node.js 22 ESM, PostgreSQL 17, React 18, DSH client slots, existing MetaSchema validators and command modules.

**Spec:** `KVVI-Agent 私有化发行版与产品闭环补充需求-v1.0.md` sections 7–8 and Stage 9.

## Global Constraints

- Only published contracts can serve employee traffic.
- Contract digest mismatch, missing required contract, or unknown component fails closed.
- Renderer uses a closed component registry; no `eval`, script URL, or arbitrary JSX.
- Every write goes through the existing authorization, risk, workflow, and audit execution point.
- Company and user identity always come from the verified session.

## Review Focus

- Missing `permission-spec` does not fall back to open access.
- A view references a field absent from `business-schema`: publication/runtime refuses before rendering.
- Hidden/read-only fields remain protected when a caller sends a handcrafted request.
- A stale `rowVersion` returns a conflict and does not overwrite a newer record.
- A published contract digest changed in storage is detected before any data response.

---

### Task 1: Add an Authenticated Product API Router

**Files:**
- Create: `services/platform/src/api-router.mjs`
- Modify: `services/platform/src/server.mjs`
- Modify: `services/platform/src/gate.mjs`
- Create: `services/platform/tests/api-router.test.mjs`

**Interfaces:**
- Consumes: `tokenFromCookie`, `handleAuth('/auth/session')`.
- Produces: `handleApi({method,path,query,body,headers,session}) -> {status,body}` for `/api/v1/*`.

- [ ] **Step 1: Write failing authentication and tenant-source tests**

```js
test('API rejects missing session', async () => {
  assert.equal((await request('GET', '/api/v1/systems')).status, 401)
})
test('API ignores caller companyId', async () => {
  const r = await authed('GET', '/api/v1/systems?companyId=' + B.company, alice)
  assert.ok(r.body.items.every(x => x.companyId !== B.company))
})
```

- [ ] **Step 2: Run the focused test and verify 404/proxy failure**

Run: `cd services/platform && node --test --test-concurrency=1 tests/api-router.test.mjs`  
Expected: FAIL because `/api/v1` is not owned by the platform service.

- [ ] **Step 3: Implement router ownership, JSON parsing, and verified session injection**

Reserve `/api/v1/` before the runtime proxy. Strip identity-like body keys (`companyId`, `tenant`, `actor`, `roles`, `gateway`) using the same recursive guard as command execution.

- [ ] **Step 4: Run API, auth, and proxy tests**

Run: `cd services/platform && node --test --test-concurrency=1 tests/api-router.test.mjs tests/auth.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit the API router**

```bash
git add services/platform/src/api-router.mjs services/platform/src/server.mjs services/platform/src/gate.mjs services/platform/tests/api-router.test.mjs
git commit -m "feat: add authenticated product API router"
```

### Task 2: Compile Published Contracts into a Closed Runtime Projection

**Files:**
- Create: `services/platform/src/runtime-projection.mjs`
- Modify: `services/platform/src/contracts.mjs`
- Create: `services/platform/tests/runtime-projection.test.mjs`
- Create: `services/platform/tests/fixtures/published-system.mjs`

**Interfaces:**
- Consumes: `contractsOfSystem(companyId, assetId)` and existing validators.
- Produces: `runtimeProjection(companyId, assetId) -> {system,models,views,workflows,permissions,tools}`.

- [ ] **Step 1: Add failing complete/missing/tampered projection tests**

```js
test('missing required contract fails closed', async () => {
  await assert.rejects(() => runtimeProjection(A.company, 'leave'),
    e => e.code === 'KVVI_RUNTIME_CONTRACT_INCOMPLETE')
})
test('tampered contract fails before projection', async () => {
  await tamperPublishedContract(A.company, 'leave', 'view-schema')
  await assert.rejects(() => runtimeProjection(A.company, 'leave'),
    /KVVI_CONTRACT_CONTENT_TAMPERED/)
})
```

- [ ] **Step 2: Run the test and confirm missing implementation**

Run: `cd services/platform && node --test --test-concurrency=1 tests/runtime-projection.test.mjs`  
Expected: FAIL with missing export.

- [ ] **Step 3: Implement validation and cross-contract binding**

Require `business-schema`, form/list `view-schema`, `permission-spec`, `workflow-spec`, `tool-spec`, and `app-model-command`. Verify every rendered field exists, every workflow state belongs to the model, every tool command is declared, and every component exists in the production component registry.

- [ ] **Step 4: Run projection and contract suites**

Run: `cd services/platform && node --test --test-concurrency=1 tests/contracts.test.mjs tests/runtime-projection.test.mjs`  
Expected: PASS for valid fixture and named errors for incomplete/tampered fixtures.

- [ ] **Step 5: Commit the runtime projection**

```bash
git add services/platform/src/runtime-projection.mjs services/platform/src/contracts.mjs services/platform/tests/runtime-projection.test.mjs services/platform/tests/fixtures/published-system.mjs
git commit -m "feat: compile published contracts for runtime"
```

### Task 3: Expose Systems, Views, Records, and Workflow APIs

**Files:**
- Create: `services/platform/src/system-api.mjs`
- Modify: `services/platform/src/api-router.mjs`
- Modify: `services/platform/src/business.mjs`
- Modify: `services/platform/src/commands.mjs`
- Create: `services/platform/tests/system-api.test.mjs`

**Interfaces:**
- Consumes: `runtimeProjection`, `handleCommand`, `readRecord`, `createRecord`, `updateRecord`, `step`.
- Produces: `GET /api/v1/systems`; `GET /api/v1/systems/:assetId/runtime`; record list/get/create/update; workflow actions.

- [ ] **Step 1: Add failing employee journey API tests**

```js
test('read-only employee cannot update', async () => {
  const before = await recordOf(ID)
  const r = await authed('PATCH', `/api/v1/systems/leave/records/${ID}`,
    { rowVersion: before.rowVersion, data: { reason: 'changed' } }, readonlyUser)
  assert.equal(r.status, 403)
  assert.deepEqual(await recordOf(ID), before)
})
test('stale row version is a conflict', async () => {
  const r = await authed('PATCH', `/api/v1/systems/leave/records/${ID}`,
    { rowVersion: 1, data: { reason: 'late' } }, editor)
  assert.equal(r.status, 409)
})
```

- [ ] **Step 2: Run and verify routes are absent**

Run: `cd services/platform && node --test --test-concurrency=1 tests/system-api.test.mjs`  
Expected: FAIL with 404.

- [ ] **Step 3: Implement routes as thin adapters over existing execution modules**

Do not duplicate authorization in `system-api.mjs`. Map HTTP inputs to typed commands, call the shared execution point, then map stable domain error codes to 400/403/404/409 responses.

- [ ] **Step 4: Run system, permission, workflow, and differential tests**

Run: `cd services/platform && node --test --test-concurrency=1 tests/system-api.test.mjs tests/permissions.test.mjs tests/workflow.test.mjs tests/diff.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit runtime APIs**

```bash
git add services/platform/src/system-api.mjs services/platform/src/api-router.mjs services/platform/src/business.mjs services/platform/src/commands.mjs services/platform/tests/system-api.test.mjs
git commit -m "feat: expose published system runtime APIs"
```

### Task 4: Render Published Systems in the DSH Client

**Files:**
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/api.ts`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/SystemShell.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/FormView.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/ListView.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/RecordDetail.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/registry.tsx`
- Modify: `forks/dsh/变更/packages/client/kvvi-panel/src/client/Panel.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/tests/runtime-ui.spec.tsx`

**Interfaces:**
- Consumes: Stage 9 API JSON and registered `view-schema` components.
- Produces: clickable “我的系统”, form/list/detail/workflow UI inside DSH overlay.

- [ ] **Step 1: Add failing renderer tests for allowed and unknown components**

```tsx
it('refuses an unregistered component', async () => {
  render(<FormView spec={viewWith('RemoteScript')} />)
  expect(screen.getByText('KVVI_COMPONENT_NOT_REGISTERED')).toBeVisible()
})
it('does not submit hidden fields', async () => {
  render(<FormView spec={hiddenSalaryView} />)
  expect(screen.queryByLabelText('salary')).toBeNull()
})
```

- [ ] **Step 2: Run the client test and confirm components are missing**

Run: `cd vendor/dsh && pnpm vitest run packages/client/kvvi-panel/tests/runtime-ui.spec.tsx`  
Expected: FAIL with missing modules.

- [ ] **Step 3: Implement a closed renderer and API client**

Registry keys are explicit imports such as `TextInput`, `NumberInput`, `Select`, `DateInput`, `Table`, and `FormPage`. Unknown keys render a blocking error. System rows become buttons that load the runtime projection; writes include `rowVersion` and display stable server errors.

- [ ] **Step 4: Run client tests and bundle**

Run: `cd vendor/dsh && pnpm vitest run packages/client/kvvi-panel/tests/runtime-ui.spec.tsx && pnpm --filter @deepseek-ai/dsh-client-kvvi-panel bundle`  
Expected: PASS.

- [ ] **Step 5: Commit the runtime UI**

```bash
git add forks/dsh/变更/packages/client/kvvi-panel
git commit -m "feat: render published systems in DSH workbench"
```

### Task 5: Add G7 End-to-End Publication Evidence

**Files:**
- Create: `工具/check_stage9.py`
- Create: `services/platform/tests/publish-runtime-e2e.test.mjs`
- Modify: `工具/验收证据包.py`
- Modify: `进度.md`
- Create: `docs/阶段九-系统运行闭环-取证.md`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: G7 verdict from draft contracts through first employee record.

- [ ] **Step 1: Write the failing e2e test**

Create a generic request system fixture, submit/approve/publish it, fetch its runtime projection as an employee, create a record, and read it back through the list endpoint.

- [ ] **Step 2: Run before evidence wiring**

Run: `cd services/platform && node --test --test-concurrency=1 tests/publish-runtime-e2e.test.mjs`  
Expected: PASS only after Tasks 1–4; `python3 工具/check_stage9.py` still FAILS until evidence is registered.

- [ ] **Step 3: Register the G7 commands and UI bundle evidence**

Include contract completeness, runtime APIs, client renderer bundle, and end-to-end record creation.

- [ ] **Step 4: Run G7 and progress consistency**

Run: `python3 工具/check_stage9.py && python3 工具/进度.py --check`  
Expected: PASS.

- [ ] **Step 5: Commit Stage 9 evidence**

```bash
git add 工具/check_stage9.py 工具/验收证据包.py services/platform/tests/publish-runtime-e2e.test.mjs 进度.md docs/阶段九-系统运行闭环-取证.md 交付/证据
git commit -m "test: add G7 runnable system evidence"
```


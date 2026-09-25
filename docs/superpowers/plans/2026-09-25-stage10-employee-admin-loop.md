# Stage 10 Employee and Administration Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let owners manage accounts and permissions, and let employees use UI or Worker Agent through the same business execution point.

**Architecture:** Add owner-only administration APIs and DSH UI pages over existing identity/authorization tables. Expose a narrow platform contract client to the Worker preset; each Agent tool maps to the same typed command functions used by Stage 9 HTTP APIs.

**Tech Stack:** Node.js 22 ESM, PostgreSQL 17, React 18, DSH/Cordis tools, Node test runner.

**Spec:** `KVVI-Agent 私有化发行版与产品闭环补充需求-v1.0.md` sections 5, 8 and Stage 10.

## Global Constraints

- Only owner can grant/revoke Builder access or approve security-sensitive changes.
- Builder may configure employee business permissions only within delegated scope and never for self/associated accounts.
- Worker tools accept business identifiers and values, never authoritative identity or tenant fields.
- UI and Agent map the same domain error to the same stable product code.
- Account suspension revokes sessions before reassignment work begins.

## Review Focus

- Owner attempts to create a duplicate login: stable conflict, no partial membership.
- Builder targets self in a permission change: reject and audit.
- Worker tool receives nested `tenant`/`actor` fields: reject before command execution.
- UI and Agent race on the same row version: one succeeds and one receives conflict.
- Suspended employee's open browser and Agent session both lose access immediately.

---

### Task 1: Add Transactional Owner Administration APIs

**Files:**
- Create: `services/platform/src/admin-api.mjs`
- Modify: `services/platform/src/api-router.mjs`
- Modify: `services/platform/src/identity.mjs`
- Modify: `services/platform/src/authorization.mjs`
- Create: `services/platform/tests/admin-api.test.mjs`

**Interfaces:**
- Consumes: `isPlatformAdmin`, mode grants, role/policy tables, lifecycle suspension.
- Produces: company members, account create/suspend, role create/member assign, policy replace, Builder grant/revoke endpoints.

- [ ] **Step 1: Add failing owner/non-owner/atomicity tests**

```js
test('non-owner cannot grant builder access', async () => {
  const r = await authed('POST', `/api/v1/admin/members/${A.bob}/builder`, {}, builder)
  assert.equal(r.status, 403)
})
test('duplicate login creates no orphan membership', async () => {
  await createMember(owner, { login: 'staff1', password: 'secret' })
  await assert.rejects(() => createMember(owner, { login: 'staff1', password: 'other' }))
  assert.equal(await membershipsForLogin('staff1'), 1)
})
```

- [ ] **Step 2: Run and verify missing routes**

Run: `cd services/platform && node --test --test-concurrency=1 tests/admin-api.test.mjs`  
Expected: FAIL with 404.

- [ ] **Step 3: Implement transactional admin operations**

Create account plus membership in one platform transaction. Replace a role's policies atomically. Reuse existing self-grant, admin, audit, and authorization-version functions; do not add a second policy engine.

- [ ] **Step 4: Run admin, lifecycle, and authorization suites**

Run: `cd services/platform && node --test --test-concurrency=1 tests/admin-api.test.mjs tests/admin.test.mjs tests/lifecycle.test.mjs tests/permissions.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit administration APIs**

```bash
git add services/platform/src/admin-api.mjs services/platform/src/api-router.mjs services/platform/src/identity.mjs services/platform/src/authorization.mjs services/platform/tests/admin-api.test.mjs
git commit -m "feat: add owner administration APIs"
```

### Task 2: Add Owner Administration UI to DSH

**Files:**
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/AdminShell.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/MemberAdmin.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/RoleAdmin.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/PolicyEditor.tsx`
- Modify: `forks/dsh/变更/packages/client/kvvi-panel/src/client/Panel.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/tests/admin-ui.spec.tsx`

**Interfaces:**
- Consumes: Task 1 admin APIs and current session capabilities.
- Produces: owner-only member, role, policy, and Builder-access screens.

- [ ] **Step 1: Add failing visibility and self-grant UI tests**

```tsx
it('does not render admin entry for employee', () => {
  render(<Panel session={employeeSession} />)
  expect(screen.queryByText('企业管理')).toBeNull()
})
it('shows server refusal instead of optimistic success', async () => {
  api.rejectNext('KVVI_SELF_GRANT_FORBIDDEN')
  await user.click(screen.getByText('保存权限'))
  expect(await screen.findByText('不能为自己配置权限')).toBeVisible()
})
```

- [ ] **Step 2: Run client tests and confirm missing UI**

Run: `cd vendor/dsh && pnpm vitest run packages/client/kvvi-panel/tests/admin-ui.spec.tsx`  
Expected: FAIL.

- [ ] **Step 3: Implement owner-only screens**

The client may hide navigation for clarity, but every API remains server-protected. Policy editor exposes FORM/FIELD/FLOW/DATA dimensions and the five existing scopes without inventing new permission semantics.

- [ ] **Step 4: Run tests and bundle**

Run: `cd vendor/dsh && pnpm vitest run packages/client/kvvi-panel/tests/admin-ui.spec.tsx && pnpm --filter @deepseek-ai/dsh-client-kvvi-panel bundle`  
Expected: PASS.

- [ ] **Step 5: Commit administration UI**

```bash
git add forks/dsh/变更/packages/client/kvvi-panel
git commit -m "feat: add owner administration UI"
```

### Task 3: Add Worker Contract Client and Typed Agent Tools

**Files:**
- Create: `forks/dsh/变更/packages/tool/kvvi-business/package.json`
- Create: `forks/dsh/变更/packages/tool/kvvi-business/src/client.ts`
- Create: `forks/dsh/变更/packages/tool/kvvi-business/src/index.ts`
- Create: `forks/dsh/变更/packages/tool/kvvi-business/tests/tools.spec.ts`
- Modify: `forks/dsh/变更/packages/preset/agent-presets/presets/kvvi-worker/agent.cordis.yml`
- Modify: `forks/dsh/改造点清单.md`

**Interfaces:**
- Consumes: Stage 9 `/api/v1` system and command endpoints plus signed internal session context.
- Produces: `record_list`, `record_get`, `record_create`, `record_update`, `workflow_available_actions`, `workflow_act`, `aggregate_read`.

- [ ] **Step 1: Add failing tool-schema and authorization tests**

```ts
it('strips identity claims from tool arguments', async () => {
  await expect(call('record_update', { system: 'leave', id: ID,
    data: { reason: 'x', tenant: 'other' } })).rejects.toMatchObject({ code: 'KVVI_IDENTITY_FIELD_FORBIDDEN' })
})
it('surfaces platform denial unchanged', async () => {
  platform.reply(403, { error: 'KVVI_FIELD_READONLY' })
  await expect(call('record_update', request)).rejects.toMatchObject({ code: 'KVVI_FIELD_READONLY' })
})
```

- [ ] **Step 2: Run the DSH tool tests and verify missing package**

Run: `cd vendor/dsh && pnpm vitest run packages/tool/kvvi-business/tests/tools.spec.ts`  
Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement the narrow contract client and register tools only in Worker**

Use the trusted session context supplied by the mode router, not model arguments. Define closed JSON schemas for each tool. Do not include shell, filesystem, Builder skills, or arbitrary URL tools in the Worker preset.

- [ ] **Step 4: Run tool tests, preset composition dump, and fork rebuild**

Run: `python3 工具/fork.py --rebuild --into /tmp/kvvi-stage10-fork`  
Run: `cd /tmp/kvvi-stage10-fork && pnpm vitest run packages/tool/kvvi-business/tests/tools.spec.ts`  
Expected: PASS; Worker config lists business tools and no Builder tools.

- [ ] **Step 5: Commit Worker tools**

```bash
git add forks/dsh/变更/packages/tool/kvvi-business forks/dsh/变更/packages/preset/agent-presets/presets/kvvi-worker/agent.cordis.yml forks/dsh/改造点清单.md
git commit -m "feat: connect Worker Agent to business commands"
```

### Task 4: Prove UI and Agent Differential Equivalence

**Files:**
- Create: `services/platform/tests/ui-agent-e2e.test.mjs`
- Create: `工具/check_stage10.py`
- Modify: `工具/验收证据包.py`
- Modify: `进度.md`
- Create: `docs/阶段十-员工与管理闭环-取证.md`

**Interfaces:**
- Consumes: Tasks 1–3 and Stage 9 system API.
- Produces: G8 verdict.

- [ ] **Step 1: Write table-driven allow/deny differential tests**

```js
for (const vector of vectors) {
  test(`${vector.name}: UI and Agent agree`, async () => {
    const ui = await throughHttp(vector)
    const agent = await throughWorkerTool(vector)
    assert.equal(agent.code, ui.code)
    assert.deepEqual(agent.result, ui.result)
  })
}
```

Include allowed create, hidden field, read-only field, out-of-scope row, illegal transition, stale row version, and suspended account.

- [ ] **Step 2: Run the differential test and inspect any mismatched codes**

Run: `cd services/platform && node --test --test-concurrency=1 tests/ui-agent-e2e.test.mjs`  
Expected: PASS only when both channels use the shared command path.

- [ ] **Step 3: Add G8 checker and evidence entries**

Checker requires admin API/UI, Worker tool package, preset composition, and differential vectors.

- [ ] **Step 4: Run G8 and progress consistency**

Run: `python3 工具/check_stage10.py && python3 工具/进度.py --check`  
Expected: PASS.

- [ ] **Step 5: Commit Stage 10 evidence**

```bash
git add services/platform/tests/ui-agent-e2e.test.mjs 工具/check_stage10.py 工具/验收证据包.py 进度.md docs/阶段十-员工与管理闭环-取证.md 交付/证据
git commit -m "test: add G8 UI and Agent equivalence evidence"
```


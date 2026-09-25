# Stage 8 Identity and Mode Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind every session to a server-authorized `USER` or `BUILDER` mode and automatically load the matching DSH preset and navigation.

**Architecture:** Add a dedicated platform-mode grant table and a single policy function that computes eligible gateways. Separate worker and builder login entries, validate requested mode server-side, and pass the resulting immutable gateway to a DSH runtime router over the private platform-to-runtime hop.

**Tech Stack:** Node.js 22 ESM, PostgreSQL 17, Node test runner, React 18, DSH/Cordis host plugin, Docker Compose.

**Spec:** `KVVI-Agent 私有化发行版与产品闭环补充需求-v1.0.md` sections 5–6 and Stage 8.

## Global Constraints

- Membership always implies `USER`; only owner or an explicit owner-issued grant implies `BUILDER`.
- Request bodies and query strings are non-authoritative mode hints.
- Gateway and company are immutable after session creation.
- Revoking builder access invalidates existing Builder sessions and tokens.
- Employee responses must not include the names of Builder tools or presets.

## Review Focus

- Forged Builder login by an employee returns `KVVI_BUILDER_ACCESS_REQUIRED` without tool disclosure.
- A multi-company account may be Builder in company A and employee-only in company B.
- A revoked Builder session fails on its next request even if its cookie remains present.
- Direct runtime access cannot inject a trusted gateway header because runtime has no host port.
- Browser navigation and runtime preset agree with the server-bound gateway.

---

### Task 1: Persist and Evaluate Builder Access

**Files:**
- Modify: `services/platform/sql/10-platform.sql`
- Create: `services/platform/src/mode-policy.mjs`
- Create: `services/platform/tests/mode-policy.test.mjs`
- Modify: `services/platform/tests/harness.mjs`

**Interfaces:**
- Consumes: `holdsPlatformRole(companyId, userId, roleCode)` from `authorization.mjs`.
- Produces: `allowedGateways(companyId, userId) -> Promise<('USER'|'BUILDER')[]>`; `grantBuilderAccess(actor, userId)`; `revokeBuilderAccess(actor, userId)`.

- [ ] **Step 1: Write the failing eligibility tests**

```js
test('employee cannot enter BUILDER', async () => {
  assert.deepEqual(await allowedGateways(A.company, A.bob), ['USER'])
})
test('owner and explicit grantee can enter BUILDER', async () => {
  await grantPlatformRole(A.alice, 'owner')
  await grantBuilderAccess(ownerCtx, A.bob)
  assert.deepEqual(await allowedGateways(A.company, A.alice), ['USER', 'BUILDER'])
  assert.deepEqual(await allowedGateways(A.company, A.bob), ['USER', 'BUILDER'])
})
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `cd services/platform && node --test --test-concurrency=1 tests/mode-policy.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `mode-policy.mjs`.

- [ ] **Step 3: Add the grant table and policy implementation**

```sql
CREATE TABLE IF NOT EXISTS platform_mode_grants (
  company_id uuid NOT NULL REFERENCES companies(company_id),
  user_id uuid NOT NULL REFERENCES users(user_id),
  gateway text NOT NULL CHECK (gateway = 'BUILDER'),
  granted_by uuid NOT NULL REFERENCES users(user_id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, gateway),
  FOREIGN KEY (company_id, user_id) REFERENCES memberships(company_id, user_id)
);
```

Implement `allowedGateways` so `USER` is implicit, `owner` is Builder-capable, and the grant row is the only other Builder source. Grant/revoke must require `owner`, increment `users.authz_version`, end matching Builder sessions, and append an audit entry.

- [ ] **Step 4: Run the focused and existing authorization tests**

Run: `cd services/platform && node --test --test-concurrency=1 tests/mode-policy.test.mjs tests/admin.test.mjs tests/auth.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit the mode policy**

```bash
git add services/platform/sql/10-platform.sql services/platform/src/mode-policy.mjs services/platform/tests/mode-policy.test.mjs services/platform/tests/harness.mjs
git commit -m "feat: enforce server-side builder access"
```

### Task 2: Enforce Mode at Login

**Files:**
- Modify: `services/platform/src/auth.mjs`
- Modify: `services/platform/src/identity.mjs`
- Modify: `services/platform/src/gate.mjs`
- Modify: `services/platform/tests/auth.test.mjs`
- Create: `services/platform/tests/login-gate.test.mjs`

**Interfaces:**
- Consumes: `allowedGateways(companyId, userId)` from Task 1.
- Produces: `POST /auth/login` with server-validated `requestedGateway`; `/kvvi/login` for worker and `/kvvi/builder/login` for builder.

- [ ] **Step 1: Add failing forged-mode and route tests**

```js
test('employee cannot self-select BUILDER', async () => {
  const r = await post('/auth/login', { login: 'bob', password: PASSWORD,
    companyId: A.company, requestedGateway: 'BUILDER' })
  assert.equal(r.status, 403)
  assert.deepEqual(await r.json(), { error: 'KVVI_BUILDER_ACCESS_REQUIRED' })
})
test('builder login entry creates a BUILDER session', async () => {
  const out = await submitGate('/kvvi/builder/login', credentials)
  assert.equal(out.headers.location, '/')
  assert.equal(await gatewayOfCookie(out.headers['set-cookie']), 'BUILDER')
})
```

- [ ] **Step 2: Run tests and confirm the current hard-coded USER behavior fails them**

Run: `cd services/platform && node --test --test-concurrency=1 tests/auth.test.mjs tests/login-gate.test.mjs`  
Expected: FAIL because `gate.mjs` always passes `gateway: 'USER'` and auth trusts a supplied gateway.

- [ ] **Step 3: Replace caller-selected gateway with authorized requested gateway**

Use `requestedGateway` only as an intent. After authentication and company selection, compute `allowedGateways`; reject unavailable Builder access before `createSession`. Render separate worker/builder login titles and preserve the intended route through multi-company selection using a hidden `requestedGateway` field.

- [ ] **Step 4: Run login, isolation, and token tests**

Run: `cd services/platform && node --test --test-concurrency=1 tests/auth.test.mjs tests/login-gate.test.mjs tests/isolation.test.mjs tests/token.test.mjs`  
Expected: PASS; employee response contains no Builder tool names.

- [ ] **Step 5: Commit login enforcement**

```bash
git add services/platform/src/auth.mjs services/platform/src/identity.mjs services/platform/src/gate.mjs services/platform/tests/auth.test.mjs services/platform/tests/login-gate.test.mjs
git commit -m "feat: bind login entry to authorized mode"
```

### Task 3: Bind DSH Runtime Sessions to KVVI Mode

**Files:**
- Create: `forks/dsh/变更/packages/host/kvvi-mode-router/package.json`
- Create: `forks/dsh/变更/packages/host/kvvi-mode-router/src/index.ts`
- Create: `forks/dsh/变更/packages/host/kvvi-mode-router/tests/mode-router.spec.ts`
- Modify: `forks/dsh/变更/packages/bundle/kvvi-app/cordis.patch.yml`
- Modify: `services/platform/src/proxy.mjs`
- Modify: `services/platform/src/runtime-auth.mjs`
- Modify: `forks/dsh/改造点清单.md`

**Interfaces:**
- Consumes: verified KVVI session from the platform cookie.
- Produces: signed internal headers `x-kvvi-session`, `x-kvvi-gateway`, `x-kvvi-company`; preset mapping `BUILDER -> kvvi-builder`, `USER -> kvvi-worker`.

- [ ] **Step 1: Add failing router tests**

```ts
it('maps only trusted gateways to fixed presets', () => {
  expect(presetFor('BUILDER')).toBe('kvvi-builder')
  expect(presetFor('USER')).toBe('kvvi-worker')
  expect(() => presetFor('admin')).toThrow('KVVI_GATEWAY_INVALID')
})
```

Add an integration test that a browser-supplied `x-kvvi-gateway: BUILDER` is stripped and replaced by the platform-derived value.

- [ ] **Step 2: Run the DSH package test and verify failure**

Run: `cd vendor/dsh && pnpm vitest run packages/host/kvvi-mode-router/tests/mode-router.spec.ts`  
Expected: FAIL because the package and router do not exist.

- [ ] **Step 3: Implement the router and proxy header replacement**

The platform removes all incoming `x-kvvi-*` headers, verifies the cookie, then injects signed internal context. The host plugin verifies the internal signature and selects a fixed preset; invalid or absent context fails closed rather than defaulting to Builder.

- [ ] **Step 4: Build the affected DSH packages and run integration tests**

Run: `python3 工具/fork.py --rebuild --into /tmp/kvvi-stage8-fork`  
Run: `cd /tmp/kvvi-stage8-fork && pnpm --filter @deepseek-ai/dsh-host-kvvi-mode-router test && pnpm --filter @deepseek-ai/dsh-kvvi-app bundle`  
Expected: PASS; rebuilt fork fingerprint check passes after registering the new files.

- [ ] **Step 5: Commit runtime mode binding**

```bash
git add forks/dsh/变更/packages/host/kvvi-mode-router forks/dsh/变更/packages/bundle/kvvi-app/cordis.patch.yml services/platform/src/proxy.mjs services/platform/src/runtime-auth.mjs forks/dsh/改造点清单.md
git commit -m "feat: bind DSH preset to KVVI session mode"
```

### Task 4: Add the G6 Gate and Evidence

**Files:**
- Create: `工具/check_stage8.py`
- Modify: `工具/验收证据包.py`
- Modify: `进度.md`
- Create: `docs/阶段八-身份入口闭环-取证.md`

**Interfaces:**
- Consumes: Tasks 1–3 tests and topology probe.
- Produces: G6 machine verdict and evidence entry.

- [ ] **Step 1: Write a checker that requires four evidence classes**

```python
CHECKS = {
    'role_policy': ['mode-policy.test.mjs'],
    'login_api': ['auth.test.mjs', 'login-gate.test.mjs'],
    'runtime_preset': ['mode-router.spec.ts'],
    'topology': ['check_topology.py'],
}
```

The checker must fail if any command is skipped, if an employee can obtain Builder, or if UI gateway and runtime preset differ.

- [ ] **Step 2: Run the checker before wiring evidence**

Run: `python3 工具/check_stage8.py`  
Expected: FAIL because the evidence manifest does not yet contain Stage 8.

- [ ] **Step 3: Wire Stage 8 into the append-only evidence generator and progress board**

Append G6 without rewriting stages 1–7. Record exact commands, exit codes, commit, and file digests.

- [ ] **Step 4: Run G6 and the progress consistency check**

Run: `python3 工具/check_stage8.py && python3 工具/进度.py --check`  
Expected: PASS with G6 complete and stages 1–7 unchanged.

- [ ] **Step 5: Commit Stage 8 evidence**

```bash
git add 工具/check_stage8.py 工具/验收证据包.py 进度.md docs/阶段八-身份入口闭环-取证.md 交付/证据
git commit -m "test: add G6 identity routing evidence"
```


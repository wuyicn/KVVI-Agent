# Stage 12 Offline Extension Ecosystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let private KVVI instances safely import, approve, install, enable, upgrade, roll back, and uninstall signed offline Skill, Plugin, and industry packages.

**Architecture:** Define one stable archive/manifest protocol shared by future online distribution. Verify archive structure, digests, Ed25519 publisher signature, compatibility, and permissions before extraction; keep installation and activation as separate audited states controlled by owners.

**Tech Stack:** Node.js 22 ESM crypto, PostgreSQL 17, JSON Schema, React 18, DSH plugin/Skill directories, Node test runner.

**Spec:** `KVVI-Agent 私有化发行版与产品闭环补充需求-v1.0.md` section 10 and Stage 12.

## Global Constraints

- Offline archive is the first-release distribution format; no online marketplace or payment.
- Verification completes before executable content is extracted into the active runtime.
- Install, enable, upgrade, rollback, disable, and uninstall are distinct audited transitions.
- Skill and Plugin types are explicit; combined industry packages inherit the highest requested permission.
- Only owner may approve code-bearing Plugin activation.

## Review Focus

- Zip-slip/symlink path escapes are rejected before extraction.
- Valid signature with mismatched file digest is rejected.
- Package compatible with DSH but not KVVI, or vice versa, is rejected.
- Install succeeds but activation fails: old active version remains in service.
- Plugin claims to reclassify a USER tool as BUILDER or vice versa: policy rejects it.

---

### Task 1: Define and Validate the Extension Package Protocol

**Files:**
- Create: `contracts/extensions/extension-manifest.schema.json`
- Create: `services/platform/src/extension-manifest.mjs`
- Create: `services/platform/tests/extension-manifest.test.mjs`
- Create: `samples/extensions/skill-example/manifest.json`
- Create: `samples/extensions/plugin-example/manifest.json`

**Interfaces:**
- Produces: `validateExtensionManifest(input, runtimeVersions) -> normalized manifest`; types `SKILL|PLUGIN|INDUSTRY_PACK`.

- [ ] **Step 1: Add failing closed-schema and compatibility tests**

```js
test('unknown permission is rejected', () => {
  assert.throws(() => validateExtensionManifest({ ...base, permissions: ['root.shell'] }),
    /KVVI_EXTENSION_PERMISSION_UNKNOWN/)
})
test('incompatible KVVI version is rejected', () => {
  assert.throws(() => validateExtensionManifest({ ...base, compatibility: { kvvi: '>=9' } }, current),
    /KVVI_EXTENSION_INCOMPATIBLE/)
})
```

- [ ] **Step 2: Run and verify missing validator**

Run: `cd services/platform && node --test tests/extension-manifest.test.mjs`  
Expected: FAIL with missing module.

- [ ] **Step 3: Implement the closed manifest schema**

Require ID, version, publisher, type, KVVI/DSH ranges, file list and hashes, permissions, migrations, lifecycle entrypoints, license, and signature metadata. Reject unknown root keys and unrecognized permissions.

- [ ] **Step 4: Run manifest tests and validate samples**

Run: `cd services/platform && node --test tests/extension-manifest.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit the protocol**

```bash
git add contracts/extensions services/platform/src/extension-manifest.mjs services/platform/tests/extension-manifest.test.mjs samples/extensions
git commit -m "feat: define offline extension package protocol"
```

### Task 2: Verify Signature and Archive Safety Before Extraction

**Files:**
- Create: `services/platform/src/extension-verify.mjs`
- Create: `services/platform/tests/extension-verify.test.mjs`
- Create: `services/platform/tests/fixtures/extensions/README.md`
- Modify: `services/platform/src/signing.mjs`

**Interfaces:**
- Consumes: archive bytes, trusted publisher public keys, Task 1 manifest.
- Produces: `verifyExtensionArchive(path) -> {manifest,stagingPath,digest}` with no active-runtime writes.

- [ ] **Step 1: Add failing tamper, signature, traversal, and symlink tests**

```js
for (const fixture of ['bad-signature.kvx', 'bad-digest.kvx', 'zip-slip.kvx', 'symlink-escape.kvx']) {
  test(`rejects ${fixture}`, async () => {
    await assert.rejects(() => verifyExtensionArchive(fixturePath(fixture)), /KVVI_EXTENSION_/)
  })
}
```

- [ ] **Step 2: Run and confirm verifier absence**

Run: `cd services/platform && node --test tests/extension-verify.test.mjs`  
Expected: FAIL.

- [ ] **Step 3: Implement streaming verification into a non-executable staging directory**

Verify archive total size, entry count, normalized relative paths, no symlinks/devices, exact manifest inventory, per-file SHA-256, and Ed25519 signature. Create staging only after manifest parsing; remove staging on every failure.

- [ ] **Step 4: Run the verifier tests**

Run: `cd services/platform && node --test tests/extension-verify.test.mjs`  
Expected: PASS; active extension directory remains unchanged for all negative fixtures.

- [ ] **Step 5: Commit verification**

```bash
git add services/platform/src/extension-verify.mjs services/platform/src/signing.mjs services/platform/tests/extension-verify.test.mjs services/platform/tests/fixtures/extensions
git commit -m "feat: verify signed extension archives"
```

### Task 3: Persist the Extension Lifecycle and Owner Approval

**Files:**
- Create: `services/platform/sql/22-extensions.sql`
- Create: `services/platform/src/extensions.mjs`
- Create: `services/platform/src/extension-api.mjs`
- Modify: `services/platform/src/api-router.mjs`
- Create: `services/platform/tests/extensions.test.mjs`

**Interfaces:**
- Consumes: verified staging result and owner/admin identity.
- Produces: states `IMPORTED -> APPROVED -> INSTALLED -> ENABLED`, plus `DISABLED`, `ROLLED_BACK`, `UNINSTALLED`, `FAILED`.

- [ ] **Step 1: Add failing state-machine and owner tests**

```js
test('install does not imply enable', async () => {
  const x = await install(owner, approvedPackage)
  assert.equal(x.state, 'INSTALLED')
})
test('builder cannot approve plugin', async () => {
  await assert.rejects(() => approve(builder, pluginId), /KVVI_NOT_A_PLATFORM_ADMIN/)
})
```

- [ ] **Step 2: Run and verify lifecycle absence**

Run: `cd services/platform && node --test --test-concurrency=1 tests/extensions.test.mjs`  
Expected: FAIL.

- [ ] **Step 3: Implement transactional state transitions and immutable version history**

Record manifest, archive digest, requested permissions, approver, active version, previous version, failure reason, and timestamps. Reject skipped transitions and self-approval for code-bearing packages. Append an audit entry for allow and deny.

- [ ] **Step 4: Run lifecycle, admin, and audit tests**

Run: `cd services/platform && node --test --test-concurrency=1 tests/extensions.test.mjs tests/admin.test.mjs tests/audit.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit lifecycle service**

```bash
git add services/platform/sql/22-extensions.sql services/platform/src/extensions.mjs services/platform/src/extension-api.mjs services/platform/src/api-router.mjs services/platform/tests/extensions.test.mjs
git commit -m "feat: add approved extension lifecycle"
```

### Task 4: Activate Skills and Plugins Without Collapsing Gateways

**Files:**
- Create: `services/platform/src/extension-activate.mjs`
- Create: `services/platform/tests/extension-activate.test.mjs`
- Create: `forks/dsh/变更/packages/host/kvvi-extension-loader/package.json`
- Create: `forks/dsh/变更/packages/host/kvvi-extension-loader/src/index.ts`
- Create: `forks/dsh/变更/packages/host/kvvi-extension-loader/tests/loader.spec.ts`
- Modify: `forks/dsh/变更/packages/bundle/kvvi-app/cordis.patch.yml`
- Modify: `forks/dsh/改造点清单.md`

**Interfaces:**
- Consumes: approved installed version and declared gateway/tool ownership.
- Produces: atomic versioned activation pointer consumed by DSH loader.

- [ ] **Step 1: Add failing activation and rollback tests**

```js
test('failed new version keeps old version active', async () => {
  await enable(owner, 'plugin.demo', '1.0.0')
  await assert.rejects(() => enable(owner, 'plugin.demo', '2.0.0-broken'))
  assert.equal(await activeVersion('plugin.demo'), '1.0.0')
})
test('extension cannot reclassify built-in gateway', async () => {
  await assert.rejects(() => enable(owner, gatewayOverridePackage), /KVVI_GATEWAY_CLASSIFICATION_IMMUTABLE/)
})
```

- [ ] **Step 2: Run platform and loader tests and confirm failure**

Run: `cd services/platform && node --test tests/extension-activate.test.mjs`  
Run: `cd vendor/dsh && pnpm vitest run packages/host/kvvi-extension-loader/tests/loader.spec.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement versioned directories and atomic activation**

Install under immutable `<extension-id>/<version>` directories. Validate load in an isolated probe process, then atomically replace the active pointer. Skills append only to declared preset directories; Plugins load only declared components. Built-in gateway classifications remain frozen.

- [ ] **Step 4: Run activation tests, fork rebuild, and bundle build**

Run: `python3 工具/fork.py --rebuild --into /tmp/kvvi-stage12-fork`  
Run: `cd services/platform && node --test tests/extension-activate.test.mjs`  
Run: `cd /tmp/kvvi-stage12-fork && pnpm vitest run packages/host/kvvi-extension-loader/tests/loader.spec.ts`  
Expected: PASS.

- [ ] **Step 5: Commit activation**

```bash
git add services/platform/src/extension-activate.mjs services/platform/tests/extension-activate.test.mjs forks/dsh/变更/packages/host/kvvi-extension-loader forks/dsh/变更/packages/bundle/kvvi-app/cordis.patch.yml forks/dsh/改造点清单.md
git commit -m "feat: activate offline extensions with rollback"
```

### Task 5: Add Extension Management UI

**Files:**
- Create: `forks/dsh/变更/packages/client/kvvi-panel/src/client/ExtensionAdmin.tsx`
- Modify: `forks/dsh/变更/packages/client/kvvi-panel/src/client/AdminShell.tsx`
- Create: `forks/dsh/变更/packages/client/kvvi-panel/tests/extension-ui.spec.tsx`

**Interfaces:**
- Consumes: Task 3 extension APIs.
- Produces: offline upload/import, permission review, approval, install, enable, rollback, disable, and uninstall UI.

- [ ] **Step 1: Add failing permission-review and state-label tests**

```tsx
it('shows requested network and data permissions before approve', async () => {
  render(<ExtensionAdmin package={pluginRequestingNetworkAndData} />)
  expect(screen.getByText('网络访问')).toBeVisible()
  expect(screen.getByText('业务数据读取')).toBeVisible()
})
it('does not label installed as enabled', () => {
  render(<ExtensionAdmin package={{ state: 'INSTALLED' }} />)
  expect(screen.getByText('已安装，未启用')).toBeVisible()
})
```

- [ ] **Step 2: Run and verify UI absence**

Run: `cd vendor/dsh && pnpm vitest run packages/client/kvvi-panel/tests/extension-ui.spec.tsx`  
Expected: FAIL.

- [ ] **Step 3: Implement owner-only extension management**

Each action displays current/target version, permissions, migrations, and rollback implications. No optimistic enabled state; refresh from server after each transition.

- [ ] **Step 4: Run UI tests and bundle**

Run: `cd vendor/dsh && pnpm vitest run packages/client/kvvi-panel/tests/extension-ui.spec.tsx && pnpm --filter @deepseek-ai/dsh-client-kvvi-panel bundle`  
Expected: PASS.

- [ ] **Step 5: Commit extension UI**

```bash
git add forks/dsh/变更/packages/client/kvvi-panel
git commit -m "feat: add offline extension management UI"
```

### Task 6: Add G10 Offline Extension Evidence

**Files:**
- Create: `工具/扩展包.py`
- Create: `工具/check_stage12.py`
- Modify: `工具/验收证据包.py`
- Modify: `进度.md`
- Modify: `docs/操作手册.md`
- Modify: `docs/交付文档.md`
- Create: `docs/阶段十二-离线扩展生态-取证.md`
- Create: `samples/extensions/industry-example/manifest.json`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: signed test `.kvx` packages and G10 verdict.

- [ ] **Step 1: Build deterministic Skill, Plugin, and industry fixtures**

`工具/扩展包.py --build <dir> --key <test-key>` sorts entries, normalizes timestamps, writes per-file hashes, signs the manifest, and emits a reproducible `.kvx`. Test keys live only under test fixtures.

- [ ] **Step 2: Run one complete lifecycle per package type**

Run: `python3 工具/check_stage12.py --fixtures`  
Expected: import/install/enable for Skill; install/enable/upgrade/rollback/uninstall for UI Plugin; combined permission review for industry pack.

- [ ] **Step 3: Add negative archive corpus to G10**

Require invalid signature, digest mismatch, traversal, symlink, incompatible version, undeclared permission, gateway override, and failed activation with old-version preservation.

- [ ] **Step 4: Run G10 and progress consistency**

Run: `python3 工具/check_stage12.py && python3 工具/进度.py --check`  
Expected: PASS with every lifecycle transition audited.

- [ ] **Step 5: Commit Stage 12 evidence**

```bash
git add 工具/扩展包.py 工具/check_stage12.py 工具/验收证据包.py 进度.md docs/操作手册.md docs/交付文档.md docs/阶段十二-离线扩展生态-取证.md samples/extensions 交付/证据
git commit -m "test: add G10 offline extension evidence"
```


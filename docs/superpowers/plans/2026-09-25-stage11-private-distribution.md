# Stage 11 Private Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a versioned Linux/Docker distribution that a new customer can install, initialize, back up, restore, upgrade, and roll back without a development checkout.

**Architecture:** Build a self-contained release archive with immutable images, manifests, and a small `kvvi-admin` command. Separate initial bootstrap from development seeding; encode every state-changing operation as a previewable plan followed by explicit apply, and prove it on a fresh Ubuntu runner.

**Tech Stack:** Docker Compose, Bash, Python 3, Node.js 22, PostgreSQL 17, GitHub Actions Ubuntu 24.04.

**Spec:** `KVVI-Agent 私有化发行版与产品闭环补充需求-v1.0.md` section 9 and Stage 11.

## Global Constraints

- Release archive contains no development accounts, private keys, or fixed production passwords.
- Installation is Linux + Docker Compose only in first release.
- Destructive reset flags remain development-only and never appear in production commands.
- Every apply command has a read-only preview and explicit confirmation/noninteractive flag.
- Backup/restore covers platform, business, audit, runtime state, versions, and checksums.

## Review Focus

- Existing port or insufficient disk is reported before containers or files are changed.
- Interrupted first-owner bootstrap cannot leave two owners or a half-created company.
- Backup digest mismatch refuses restore before databases are replaced.
- Irreversible database migration is labeled before apply and never advertised as automatically reversible.
- Fresh-host acceptance uses the release archive, not the repository working tree.

---

### Task 1: Define Release Layout and Preflight

**Files:**
- Create: `distribution/manifest.json`
- Create: `distribution/bin/kvvi-admin`
- Create: `distribution/lib/preflight.py`
- Create: `distribution/tests/test_preflight.py`
- Modify: `工具/交付包.py`

**Interfaces:**
- Consumes: current delivery manifest and Docker Compose baseline.
- Produces: `kvvi-admin preflight --config <path> -> JSON report`; release archive layout.

- [ ] **Step 1: Write failing preflight tests**

```python
def test_port_collision_fails_without_writes(tmp_path, occupied_port):
    result = preflight(config(port=occupied_port), root=tmp_path)
    assert result['ok'] is False
    assert result['errors'][0]['code'] == 'KVVI_PORT_IN_USE'
    assert list(tmp_path.iterdir()) == []

def test_disk_floor_is_enforced(tmp_path, fake_free_bytes):
    fake_free_bytes.return_value = 5 * 1024**3
    assert preflight(config(min_disk_gib=20), root=tmp_path)['ok'] is False
```

- [ ] **Step 2: Run tests and confirm missing module**

Run: `python3 -m unittest distribution.tests.test_preflight -v`  
Expected: FAIL with missing `distribution.lib.preflight`.

- [ ] **Step 3: Implement release manifest and read-only checks**

Check Linux architecture, Docker/Compose versions, CPU, memory, disk, ports, writable target directory, and clock sanity. Emit stable codes and human text; do not create config during preflight.

- [ ] **Step 4: Run tests and rebuild release archive**

Run: `python3 -m unittest distribution.tests.test_preflight -v && python3 工具/交付包.py --build`  
Expected: PASS; archive includes `distribution/` and manifest digest updates.

- [ ] **Step 5: Commit release layout**

```bash
git add distribution 工具/交付包.py
git commit -m "feat: add release preflight and admin entrypoint"
```

### Task 2: Implement First-Run Bootstrap

**Files:**
- Create: `services/platform/src/bootstrap.mjs`
- Create: `services/platform/tests/bootstrap.test.mjs`
- Modify: `services/platform/src/server.mjs`
- Modify: `services/platform/sql/10-platform.sql`
- Create: `distribution/lib/install.py`
- Create: `distribution/tests/test_install.py`

**Interfaces:**
- Consumes: empty migrated platform database.
- Produces: one-time bootstrap token; `POST /bootstrap/owner`; `kvvi-admin install --plan|--apply`.

- [ ] **Step 1: Add failing one-time and atomic bootstrap tests**

```js
test('bootstrap creates exactly one owner and then closes', async () => {
  const first = await bootstrap({ token, company: 'Acme', login: 'owner', password: STRONG })
  assert.equal(first.status, 201)
  const second = await bootstrap({ token, company: 'Other', login: 'owner2', password: STRONG })
  assert.equal(second.status, 410)
})
```

Add installer tests proving `--plan` writes nothing and `--apply --yes` creates config with mode `0600`.

- [ ] **Step 2: Run tests and verify bootstrap does not exist**

Run: `cd services/platform && node --test --test-concurrency=1 tests/bootstrap.test.mjs`  
Run: `python3 -m unittest distribution.tests.test_install -v`  
Expected: FAIL.

- [ ] **Step 3: Implement transactional bootstrap and installer plan/apply**

Store a consumed bootstrap marker in the platform database. Company, owner account, membership, owner role, and marker commit in one transaction. Installer generates random secrets locally, writes restrictive files, launches Compose, waits for health, and prints the one-time bootstrap URL.

- [ ] **Step 4: Run bootstrap and install tests**

Run: `cd services/platform && node --test --test-concurrency=1 tests/bootstrap.test.mjs`  
Run: `python3 -m unittest distribution.tests.test_install -v`  
Expected: PASS.

- [ ] **Step 5: Commit bootstrap**

```bash
git add services/platform/src/bootstrap.mjs services/platform/src/server.mjs services/platform/sql/10-platform.sql services/platform/tests/bootstrap.test.mjs distribution/lib/install.py distribution/tests/test_install.py
git commit -m "feat: add production first-run bootstrap"
```

### Task 3: Add Backup, Restore, Upgrade, and Rollback

**Files:**
- Create: `distribution/lib/backup.py`
- Create: `distribution/lib/upgrade.py`
- Create: `distribution/tests/test_backup_restore.py`
- Create: `distribution/tests/test_upgrade.py`
- Create: `services/platform/sql/00-migration-ledger.sql`
- Modify: `services/platform/src/migrate.mjs`
- Modify: `distribution/bin/kvvi-admin`

**Interfaces:**
- Produces: `kvvi-admin backup`, `restore --plan|--apply`, `upgrade --plan|--apply`, `rollback --plan|--apply`; migration ledger entries with reversibility flag.

- [ ] **Step 1: Write failing digest, ledger, and interrupted-upgrade tests**

```python
def test_restore_rejects_tampered_archive(backup):
    backup.write_bytes(backup.read_bytes() + b'x')
    assert restore_plan(backup).error == 'KVVI_BACKUP_DIGEST_MISMATCH'

def test_irreversible_migration_blocks_automatic_rollback(plan):
    plan.migrations = [Migration('20260925_01', reversible=False)]
    assert plan.rollback_supported is False
```

- [ ] **Step 2: Run and verify missing lifecycle modules**

Run: `python3 -m unittest distribution.tests.test_backup_restore distribution.tests.test_upgrade -v`  
Expected: FAIL.

- [ ] **Step 3: Implement full-state archives and version ledger**

Backup three PostgreSQL databases separately, runtime volume state, instance config without decrypted secrets, release/version manifest, and per-file SHA-256. Upgrade always creates backup first, records each migration, and rolls image versions back automatically only when database compatibility remains valid.

- [ ] **Step 4: Run lifecycle tests and a local Compose rehearsal**

Run: `python3 -m unittest distribution.tests.test_backup_restore distribution.tests.test_upgrade -v`  
Run: `python3 工具/交付环境.py`  
Expected: PASS; restore reproduces record counts, contract digests, account membership, and audit chain.

- [ ] **Step 5: Commit lifecycle tooling**

```bash
git add distribution services/platform/sql/00-migration-ledger.sql services/platform/src/migrate.mjs
git commit -m "feat: add release backup restore and upgrade lifecycle"
```

### Task 4: Add a Constrained Installation Agent Skill

**Files:**
- Create: `distribution/skills/kvvi-install/SKILL.md`
- Create: `distribution/skills/kvvi-install/scripts/check.sh`
- Create: `distribution/skills/kvvi-install/scripts/plan.sh`
- Create: `distribution/skills/kvvi-install/scripts/apply.sh`
- Create: `distribution/tests/test_install_skill.py`

**Interfaces:**
- Consumes: `kvvi-admin` subcommands.
- Produces: an Agent-facing workflow that can inspect and plan freely but requires user confirmation before apply.

- [ ] **Step 1: Add failing allowlist tests**

Test that the Skill references only `preflight`, `install`, `backup`, `restore`, `upgrade`, `rollback`, `status`, and `logs`; reject `sh -c`, remote curl pipes, arbitrary paths, and implicit `--yes`.

- [ ] **Step 2: Run tests and confirm Skill absence**

Run: `python3 -m unittest distribution.tests.test_install_skill -v`  
Expected: FAIL.

- [ ] **Step 3: Implement the Skill and fixed wrappers**

The Skill must present the generated plan verbatim, ask for confirmation, then invoke the corresponding wrapper. Scripts validate their arguments and use explicit paths inside the release root.

- [ ] **Step 4: Run Skill tests and shell syntax checks**

Run: `python3 -m unittest distribution.tests.test_install_skill -v`  
Run: `bash -n distribution/skills/kvvi-install/scripts/*.sh`  
Expected: PASS.

- [ ] **Step 5: Commit installation Skill**

```bash
git add distribution/skills distribution/tests/test_install_skill.py
git commit -m "feat: add constrained installation Agent skill"
```

### Task 5: Prove the Release on a Non-Development Host

**Files:**
- Create: `.github/workflows/release-acceptance.yml`
- Create: `工具/check_stage11.py`
- Modify: `工具/验收证据包.py`
- Modify: `进度.md`
- Modify: `docs/操作手册.md`
- Modify: `docs/交付文档.md`
- Create: `docs/阶段十一-私有化发行版-取证.md`

**Interfaces:**
- Consumes: release archive only.
- Produces: G9 evidence from Ubuntu 24.04 runner.

- [ ] **Step 1: Add a workflow that starts from the release artifact**

Workflow checks out only long enough to build the archive, uploads it, then a separate job downloads the artifact into a clean directory and performs preflight, install, bootstrap, Stage 9 user journey, backup, restore, and health checks.

- [ ] **Step 2: Run workflow lint and local checker snapshot**

Run: `python3 工具/check_stage11.py --workflow-only`  
Expected: PASS only if the acceptance job never refers to the repository source tree after artifact download.

- [ ] **Step 3: Run the remote workflow and download immutable evidence**

Run: `gh workflow run release-acceptance.yml --ref main`  
Run: `gh run watch --exit-status`  
Expected: workflow PASS; archive digest and runner OS/image are present in the artifact.

- [ ] **Step 4: Verify G9 and documentation consistency**

Run: `python3 工具/check_stage11.py && python3 工具/进度.py --check`  
Expected: PASS; old N21 is closed with the new non-development-host evidence, not merely edited away.

- [ ] **Step 5: Commit Stage 11 evidence**

```bash
git add .github/workflows/release-acceptance.yml 工具/check_stage11.py 工具/验收证据包.py 进度.md docs/操作手册.md docs/交付文档.md docs/阶段十一-私有化发行版-取证.md 交付/证据
git commit -m "test: add G9 clean-host release evidence"
```


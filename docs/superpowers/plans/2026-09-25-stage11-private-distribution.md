# Stage 11 macOS Pilot Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A macOS user with Homebrew's PostgreSQL 17 installed runs one install command and reaches a working KVVI instance — three databases, three least-privilege roles, platform and runtime running, first owner created — then backs it up, restores it, and uninstalls without losing data.

**Architecture:** The Homebrew package supplies the PostgreSQL **binaries**; KVVI `initdb`s its **own cluster** in its own data directory on its own port, so the customer's existing databases are never touched. There is no Docker in the pilot: the platform and runtime run as two native Node processes supervised by `kvvi-admin`, with a launchd LaunchAgent for restart-on-login. Every state-changing operation is `--plan` then `--apply`, and every plan is printed verbatim before it runs.

**Tech Stack:** macOS 13+, Homebrew PostgreSQL 17, Node.js 24, Python 3 (installer only), Bash, launchd.

**Spec:** `KVVI-Agent 私有化发行版与产品闭环补充需求-v1.0.md` sections 9, 9.5 and 15, and Stage 11.

## Global Constraints

- **Fixed PostgreSQL major version (17).** The installer refuses any other major and names the one it found. Homebrew's `postgresql@17` formula is the precondition; the unversioned `postgresql` formula is not accepted, because it moves.
- **The customer's databases are never touched.** Separate cluster, separate data directory, separate port, separate socket directory. This is what makes "KVVI uses its own data directory and port" true at the same time as "PostgreSQL is preinstalled" — see the Dev Note.
- **No manual SQL for the customer.** The installer creates all three databases and all three roles.
- Release archive contains no development accounts, private keys, or fixed production passwords.
- Destructive reset flags remain development-only and never appear in production commands.
- Every apply command has a read-only preview and an explicit confirmation or noninteractive flag.
- **Uninstall keeps data by default.** Removing the cluster requires a second, explicitly named flag.
- Backup/restore covers platform, business, audit, runtime state, versions, and checksums.

## Review Focus

- PostgreSQL absent, at the wrong major, or installed at the other architecture's Homebrew prefix: each produces its own guidance, and nothing is written before the check passes.
- An interrupted first-owner bootstrap cannot leave two owners or a half-created company.
- Backup digest mismatch refuses restore before any database is replaced.
- A PostgreSQL major-version upgrade never runs in place, and never proceeds without a verified export.
- Fresh-user acceptance uses the release archive, not the repository working tree.

---

### Task 1: Define Release Layout and macOS Preflight

**Files:**
- Create: `distribution/manifest.json`
- Create: `distribution/bin/kvvi-admin`
- Create: `distribution/lib/preflight.py`
- Create: `distribution/tests/test_preflight.py`
- Modify: `工具/交付包.py`

**Interfaces:**
- Consumes: current delivery manifest, the frozen `KVVI_PG_MAJOR = 17`.
- Produces: `kvvi-admin preflight --config <path> -> JSON report`; release archive layout.

- [x] **Step 1: Write failing preflight tests**

```python
def test_wrong_postgres_major_names_both_versions(tmp_path):
    result = preflight(env_with(pg_major=16), root=tmp_path)
    assert result['ok'] is False
    assert result['errors'][0]['code'] == 'KVVI_PG_MAJOR_UNSUPPORTED'
    assert result['errors'][0]['found'] == 16 and result['errors'][0]['required'] == 17

def test_intel_homebrew_prefix_is_found(tmp_path, monkeypatch):
    monkeypatch.setattr(platform, 'machine', lambda: 'x86_64')
    assert brew_prefix() == '/usr/local'

def test_port_collision_fails_without_writes(tmp_path, occupied_port):
    result = preflight(config(pg_port=occupied_port), root=tmp_path)
    assert result['ok'] is False
    assert result['errors'][0]['code'] == 'KVVI_PORT_IN_USE'
    assert list(tmp_path.iterdir()) == []
```

- [x] **Step 2: Run tests and confirm missing module**

Run: `python3 -m unittest distribution.tests.test_preflight -v`
Expected: FAIL with missing `distribution.lib.preflight`.

- [x] **Step 3: Implement release manifest and read-only checks**

Check macOS version, CPU architecture, both Homebrew prefixes (`/opt/homebrew` for Apple Silicon, `/usr/local` for Intel), `pg_config` presence, PostgreSQL major version, memory, disk, the KVVI port and the PostgreSQL port, writable target directory, and clock sanity. Emit stable codes plus one line of human guidance per code. Create nothing during preflight.

- [x] **Step 4: Run tests and rebuild release archive**

Run: `python3 -m unittest distribution.tests.test_preflight -v && python3 工具/交付包.py --write && python3 工具/交付包.py --check && python3 工具/交付包.py --self-test`
Expected: PASS; the manifest lists a `distribution` component and the digest updates. Run `--write` before `--self-test`: the reverse test assumes a fresh manifest, and a stale one makes its positive case red for the wrong reason.

- [x] **Step 5: Commit release layout**

```bash
git add distribution 工具/交付包.py
git commit -m "feat: add macOS release preflight and admin entrypoint"
```

### Task 2: Implement Cluster Bring-Up and First-Run Bootstrap

**Files:**
- Create: `distribution/lib/pg.py`
- Create: `distribution/lib/install.py`
- Create: `distribution/lib/supervisor.py`
- Create: `distribution/tests/test_pg.py`
- Create: `distribution/tests/test_install.py`
- Create: `services/platform/src/bootstrap.mjs`
- Create: `services/platform/tests/bootstrap.test.mjs`
- Modify: `services/platform/src/server.mjs`
- Create: `services/platform/sql/19-instance-bootstrap.sql`

**Interfaces:**
- Consumes: an empty data directory and a working `pg_config`.
- Produces: `kvvi-admin install --plan|--apply`, `kvvi-admin start|stop|status`; one-time bootstrap token; `POST /bootstrap/owner`.

- [x] **Step 1: Write failing cluster and bootstrap tests**

```python
def test_cluster_is_its_own(tmp_path):
    plan = install_plan(pg_port=54329, home=tmp_path)
    assert plan.data_dir == tmp_path / 'pgdata'
    assert plan.pg_port == 54329
    assert plan.socket_dir == tmp_path / 'run'          # not /tmp, not the customer's
    assert plan.never_connects_to == ['the customer cluster']

def test_plan_writes_nothing(tmp_path):
    install_plan(home=tmp_path)
    assert list(tmp_path.iterdir()) == []
```

```js
test('bootstrap creates exactly one owner and then closes', async () => {
  const first = await bootstrap({ token, company: 'Acme', login: 'owner', password: STRONG })
  assert.equal(first.status, 201)
  const second = await bootstrap({ token, company: 'Other', login: 'owner2', password: STRONG })
  assert.equal(second.status, 410)
})
```

- [x] **Step 2: Run tests and confirm the modules do not exist**

Run: `python3 -m unittest distribution.tests.test_pg distribution.tests.test_install -v`
Run: `cd services/platform && node --test --test-concurrency=1 tests/bootstrap.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement `initdb`, databases, roles, and transactional bootstrap**

`initdb` into `$KVVI_HOME/pgdata` with `--auth-local=peer --auth-host=scram-sha-256`, listening on `127.0.0.1:$KVVI_PG_PORT` only, socket in `$KVVI_HOME/run`. Create the three databases and the roles `services/platform/sql` expects (`kvvi_platform`, `kvvi_business`, `kvvi_audit_writer`, `kvvi_audit_reader`), then run `migrate.mjs`. Generate all secrets locally with `secrets.token_urlsafe` and write config `0600`. Start platform then runtime as separate processes; a launchd LaunchAgent restarts them at login. Store a consumed bootstrap marker in the platform database: company, owner account, membership, owner role, and marker commit in one transaction.

- [x] **Step 4: Run cluster, bootstrap, and isolation tests**

Run: `python3 -m unittest distribution.tests.test_pg distribution.tests.test_install -v`
Run: `cd services/platform && node --test --test-concurrency=1 tests/bootstrap.test.mjs tests/isolation.test.mjs`
Expected: PASS. `isolation.test.mjs` is included because the cluster bring-up must not weaken the three-database role separation it asserts.

- [x] **Step 5: Commit cluster bring-up and bootstrap**

```bash
git add distribution/lib/pg.py distribution/lib/install.py distribution/lib/supervisor.py distribution/tests services/platform/src/bootstrap.mjs services/platform/src/server.mjs services/platform/tests/bootstrap.test.mjs
git commit -m "feat: add local cluster bring-up and production bootstrap"
```

### Task 3: Add Backup, Restore, and Version Upgrade

**Files:**
- Create: `distribution/lib/backup.py`
- Create: `distribution/lib/upgrade.py`
- Create: `distribution/tests/test_backup_restore.py`
- Create: `distribution/tests/test_upgrade.py`
- Create: `services/platform/sql/00-migration-ledger.sql` (deferred: the ledger already exists inline in `migrate.mjs`, and the `reversible` flag is read conservatively until a migration declares otherwise)
- Modify: `services/platform/src/migrate.mjs`
- Modify: `distribution/bin/kvvi-admin`

**Interfaces:**
- Produces: `kvvi-admin backup`, `restore --plan|--apply`, `upgrade --plan|--apply`, `rollback --plan|--apply`, `uninstall [--purge-data]`; migration ledger entries with a reversibility flag.

- [x] **Step 1: Write failing digest, ledger, and in-place-upgrade tests**

```python
def test_restore_rejects_tampered_archive(backup):
    backup.write_bytes(backup.read_bytes() + b'x')
    assert restore_plan(backup).error == 'KVVI_BACKUP_DIGEST_MISMATCH'

def test_irreversible_migration_blocks_automatic_rollback(plan):
    plan.migrations = [Migration('20260926_01', reversible=False)]
    assert plan.rollback_supported is False

def test_major_upgrade_never_uses_pg_upgrade(plan):
    assert 'pg_upgrade' not in ' '.join(plan.steps)
    assert plan.steps[0].startswith('pg_dump')

def test_uninstall_keeps_data_unless_named(tmp_path):
    assert 'pgdata' not in uninstall_plan(tmp_path).removes
    assert 'pgdata' in uninstall_plan(tmp_path, purge_data=True).removes
```

- [x] **Step 2: Run and verify the lifecycle modules are missing**

Run: `python3 -m unittest distribution.tests.test_backup_restore distribution.tests.test_upgrade -v`
Expected: FAIL.

- [x] **Step 3: Implement full-state archives, the ledger, and the export-based major upgrade**

Back up the three databases separately with `pg_dump -Fc`, plus runtime state and instance config without decrypted secrets, the release/version manifest, and per-file SHA-256. Upgrade always backs up first and records each migration. A PostgreSQL **major** upgrade is `pg_dump` → new cluster on the new major → `pg_restore` → row-count and digest recheck → switch. `pg_upgrade` is never used, because an in-place failure damages the only copy of the data.

- [x] **Step 4: Run lifecycle tests and a local rehearsal**

Run: `python3 -m unittest distribution.tests.test_backup_restore distribution.tests.test_upgrade -v`
Run: `python3 工具/交付环境.py`
Expected: PASS; restore reproduces record counts, contract digests, account membership, and audit chain.

- [x] **Step 5: Commit lifecycle tooling**

```bash
git add distribution services/platform/sql/00-migration-ledger.sql services/platform/src/migrate.mjs
git commit -m "feat: add release backup restore and version upgrade lifecycle"
```

### Task 4: Add a Constrained Installation Agent Skill

**Files:**
- Create: `distribution/skills/kvvi-install/SKILL.md`
- Create: `distribution/skills/kvvi-install/scripts/check.sh`
- Create: `distribution/skills/kvvi-install/scripts/plan.sh`
- Create: `distribution/skills/kvvi-install/scripts/apply.sh`
- Create: `distribution/tests/test_install_skill.py`

**Interfaces:**
- Consumes: `kvvi-admin` subcommands and the preflight report.
- Produces: an Agent-facing workflow that inspects and plans freely, states the precondition in plain language, and requires confirmation before apply.

- [ ] **Step 1: Add failing allowlist and guidance tests**

Test that the Skill references only `preflight`, `install`, `backup`, `restore`, `upgrade`, `rollback`, `status`, `logs`, and `uninstall`; reject `sh -c`, remote curl pipes, arbitrary paths, and implicit `--yes`. Test that a preflight report containing `KVVI_PG_NOT_FOUND` or `KVVI_PG_MAJOR_UNSUPPORTED` produces the formula-name guidance and **no** apply command.

- [ ] **Step 2: Run tests and confirm the Skill is absent**

Run: `python3 -m unittest distribution.tests.test_install_skill -v`
Expected: FAIL.

- [ ] **Step 3: Implement the Skill and fixed wrappers**

The Skill presents the generated plan verbatim, asks for confirmation, then invokes the corresponding wrapper. Scripts validate their arguments and use explicit paths inside the release root. Every preflight error code maps to one sentence naming what to install or fix.

- [ ] **Step 4: Run Skill tests and shell syntax checks**

Run: `python3 -m unittest distribution.tests.test_install_skill -v`
Run: `bash -n distribution/skills/kvvi-install/scripts/*.sh`
Expected: PASS.

- [ ] **Step 5: Commit installation Skill**

```bash
git add distribution/skills distribution/tests/test_install_skill.py
git commit -m "feat: add constrained installation Agent skill"
```

### Task 5: Prove G9 on a Machine That Never Ran KVVI

**Files:**
- Create: `工具/check_stage11.py`
- Modify: `工具/验收证据包.py`
- Modify: `进度.md`
- Modify: `docs/操作手册.md`
- Modify: `docs/交付文档.md`
- Create: `docs/阶段十一-macOS试点发行版-取证.md`

**Interfaces:**
- Consumes: release archive only.
- Produces: G9 evidence, and an explicit statement of what it does not prove.

- [ ] **Step 1: Build a clean-user harness that starts from the archive**

The harness creates a fresh macOS user (or uses one with no KVVI artifacts), extracts the archive into a directory outside the repository, and runs preflight → install → bootstrap → the Stage 9 and Stage 10 journeys → backup → restore → uninstall → reinstall. It fails if any command resolves inside the repository working tree.

- [ ] **Step 2: Run the checker and confirm it refuses an untested claim**

Run: `python3 工具/check_stage11.py --harness-only`
Expected: PASS only if every step runs from the extracted archive and the report records the host's OS version, CPU architecture, and PostgreSQL version.

- [ ] **Step 3: Run the harness on the clean user and capture evidence**

Run: `python3 工具/check_stage11.py`
Expected: PASS; the report states plainly that this is a **fresh user account on the development host**, not a second machine. That choice is the owner's (2026-09-26, spec §15.4): it proves the install, initialize, backup/restore and uninstall-keeps-data loop in an environment that never ran KVVI, and it does **not** prove a different macOS version, different hardware, or a genuinely offline host. A VM or real second machine is required before external delivery.

- [ ] **Step 4: Verify G9 and documentation consistency**

Run: `python3 工具/check_stage11.py && python3 工具/进度.py --check`
Expected: PASS. N21 is closed with the new clean-user evidence; the "not a separate machine" limitation is recorded, not edited away.

- [ ] **Step 5: Commit Stage 11 evidence**

```bash
git add 工具/check_stage11.py 工具/验收证据包.py 进度.md docs/操作手册.md docs/交付文档.md docs/阶段十一-macOS试点发行版-取证.md 交付/证据
git commit -m "test: add G9 macOS pilot release evidence"
```

---

## Dev Note

**Why "preinstalled PostgreSQL" and "its own data directory" are not a contradiction.** The Homebrew formula supplies `initdb`, `postgres`, `pg_dump`, `pg_restore` and `psql`; the installer uses those binaries to create a **separate cluster** under `$KVVI_HOME/pgdata` on `127.0.0.1:$KVVI_PG_PORT`. The customer's own cluster keeps its port, its `postgresql.conf` and its databases, and KVVI never connects to it. The precondition is therefore a set of binaries, not a running service, and requirement 3 of §9.5 holds literally.

**What degrades, stated once.** The pilot is weaker than the Linux enterprise edition on two axes, and neither is hidden:

1. **Three PostgreSQL instances → one instance with three databases.** The three databases share a `postgresql.conf`, a listening port, a socket directory and a superuser. Databases, roles, permissions, RLS and the audit-append rule are all preserved; instance-level failure containment is not. The Linux edition restores three instances.
2. **Two containers → two processes under one user.** `PRD §4.6.5` allows "different containers **or different system users**". The pilot satisfies neither literally: both processes run as the installing user. The internal token still authenticates every platform→runtime call and the runtime still listens on loopback only, but a local attacker who can read the installing user's files can reach both. Closing this needs either the Docker path or a second system user; the second system user is the cheaper fix and should land before the pilot leaves early access.

**Why no Electron in the pilot.** `apps/desktop` already packages a macOS `.app` with bundled Node, Python and pnpm, and it is the right vehicle for option A. The pilot deliberately does not use it: shipping a signed, notarized `.app` needs an Apple Developer certificate and a notarization round-trip, and neither exists yet. The pilot's installer is an interactive CLI plus the browser-based first-run page, which exercises the same install-and-initialize loop at a fraction of the cost. Bundling the `.app` is what turns the pilot into option A, together with moving PostgreSQL into the package.

**Why GitHub Actions is not the acceptance host.** The runner would be Linux, which the pilot no longer targets, and the repository is unreachable from this environment (`git ls-remote` times out), so a workflow could not be run to produce evidence anyway. The acceptance host is a fresh macOS user account on the development machine — genuinely "never installed KVVI", but **not a second machine**, and the evidence says so.

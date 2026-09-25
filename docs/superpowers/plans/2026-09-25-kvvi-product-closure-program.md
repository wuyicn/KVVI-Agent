# KVVI Product Closure Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the frozen v2.16 technical baseline into a privately deployable KVVI product whose builder, employee, distribution, and offline-extension journeys work end to end.

**Architecture:** Keep v2.16 unchanged as the security and contract baseline. Deliver five independently reviewable increments in dependency order: identity routing, runnable systems, employee/admin operations, private distribution, then offline extensions.

**Tech Stack:** Node.js 22 ESM, PostgreSQL 17, React 18 in DSH client plugins, DSH/Cordis presets and bundles, Docker Compose, Bash, Python verification tools, Node test runner.

**Spec:** `KVVI-Agent 私有化发行版与产品闭环补充需求-v1.0.md`

## Global Constraints

- The frozen `KVVI-Agent 开发文档 PRD.md` v2.16 remains unchanged.
- First release supports Linux servers with Docker Compose only.
- One customer receives one private instance; no hosted SaaS or cross-customer database.
- Builder-generated applications remain declarative contracts; they do not generate arbitrary server code.
- Browser/API input never supplies authoritative company, identity, role, or gateway state.
- UI and Agent commands share one server-side authorization and execution point.
- High-risk extension code requires owner approval, signature verification, audit, and rollback.
- Every milestone stores commands, exit codes, commit IDs, and artifact hashes separately from prose status.

## Review Focus

- An employee forges `gateway=BUILDER`: server refuses and discloses no builder tool names (Stage 8 Task 2).
- A published system omits or tampers with one contract: runtime fails closed instead of rendering a partial writable UI (Stage 9 Task 2).
- UI and Worker Agent submit the same unauthorized mutation: both return the same code and leave the record unchanged (Stage 10 Task 4).
- Upgrade fails after a database migration starts: backup and migration ledger preserve an explicit recoverable state (Stage 11 Task 3).
- An extension has a valid archive but invalid signature, excessive permission, or incompatible version: installation refuses before unpacking executable content (Stage 12 Tasks 1–2).

---

## Plan Set and Order

1. [Stage 8: Identity and Mode Routing](2026-09-25-stage8-identity-mode-routing.md) — produces trustworthy `USER`/`BUILDER` sessions and preset binding.
2. [Stage 9: Runnable System Runtime](2026-09-25-stage9-runnable-system-runtime.md) — turns published contracts into usable forms, records, workflows, and dashboards.
3. [Stage 10: Employee and Administration Loop](2026-09-25-stage10-employee-admin-loop.md) — adds owner administration and Worker Agent tools over the same command path.
4. [Stage 11: Private Distribution](2026-09-25-stage11-private-distribution.md) — adds bootstrap, backup/restore, upgrade/rollback, and clean-host evidence.
5. [Stage 12: Offline Extension Ecosystem](2026-09-25-stage12-offline-extension-ecosystem.md) — adds signed offline Skill/Plugin/industry packages.

Do not start a later plan until the preceding gate (`G6` through `G10`) passes and its evidence is committed. Existing stages 1–7 remain historical records; append stages 8–12 to `进度.md` only after each plan introduces its machine-checkable gate.

## Program Completion

- [ ] Run every plan's focused tests and gate checker.
- [ ] Run the complete platform suite with the documented PostgreSQL fixture.
- [ ] Run DSH fork build and client package tests.
- [ ] Run the non-development-host release workflow.
- [ ] Generate a new evidence bundle that includes G6–G10 without rewriting old evidence.
- [ ] Update `docs/操作手册.md`, `docs/交付文档.md`, and `进度.md` with verified facts and remaining boundaries.
- [ ] Commit the final evidence refresh separately from implementation commits.


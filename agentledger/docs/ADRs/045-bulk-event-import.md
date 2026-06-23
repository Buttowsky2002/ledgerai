# ADR-045 — Bulk event import API

**Date:** 2026-06-23
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 1 (CLAUDE.md — "connect a source, see value"); ADR-013 (analytics over ClickHouse MVs — reuses `ClickHouseService` + the `tenant_id`-from-principal isolation); security rules 2/3/4/5/10.

---

## Context

Onboarding a customer means getting their historical / offline AI activity into
the analytics store. The live front door (collector → Redpanda → ch-insert
worker, and the optional gateway) covers *ongoing* traffic, but there was **no
operator-facing way to backfill** a batch of past usage, outcomes, tool calls, or
risk signals through the control-plane API. A backfill must be **safe to retry**
— an operator re-running an import (after a timeout, a partial upload, a script
re-run) must not double-count spend or outcomes that feed ROI.

## Decision

Add `POST /v1/import/events` to a new `ImportModule` in the control-plane API.
The endpoint accepts a batch of flat rows, maps each to one or more canonical
ClickHouse rows, de-duplicates against prior imports, and bulk-inserts the fresh
events.

- **Flat row → canonical events (`import.mapper.ts`).** A row may carry usage,
  an outcome, a tool call, and/or a risk signal; each present signal becomes its
  own event in the matching table (`llm_calls` / `outcomes` / `agent_tool_calls`
  / `risk_events`). Per **rule 2** the row exposes **no content field** — only
  cost/usage/attribution dimensions and a categorical `risk_severity`. Field
  coercion is strict: a bad type/negative number/invalid timestamp/unknown
  `risk_severity` throws `ImportRowError`, and the service attaches the line number.
- **All-or-nothing validation.** A single malformed row rejects the **whole
  batch** with `400` and the offending line numbers — nothing is written, so a
  partial apply never surprises the caller.
- **Idempotency ledger (migration 011, `import_idempotency`).** Rows that carry an
  `idempotency_key` are recorded in a tenant-scoped, RLS-enforced Postgres table
  (`PRIMARY KEY (tenant_id, idempotency_key)`). A re-import with a seen key is
  **skipped** — no double counting. Keys repeated *within* one batch collapse to
  the first occurrence. Rows **without** a key are always imported (the operator
  opted out of dedup for that row).
- **Reserve-before-write ordering.** Inside one `withTenant` transaction the
  service (1) reads which keys already exist, (2) reserves the fresh keys
  (`createMany … skipDuplicates`), then (3) bulk-inserts to ClickHouse. If the CH
  insert throws, the transaction rolls back and **no keys are recorded**, so a
  retry re-imports cleanly. The only uncovered window is a transaction-commit
  failure *after* a successful CH write — at worst a single batch double-counts on
  retry; it never silently drops events.
- **Tenant isolation (rule 3).** `tenant_id` is stamped onto every ClickHouse row
  from the request principal (`getTenantId()`), never from request input — a
  caller-supplied `tenant_id` in a row is overwritten. ClickHouse has no RLS, so
  this stamp is the sole isolation, exactly as the analytics read path relies on.
- **Admin-only + audited (rules 5/10).** The route requires the `admin` role. The
  batch is capped (`@ArrayMaxSize`) within the API body limit, and each applied
  import writes an `audit_log` row (`action='import'`, counts) in the same
  transaction.

## Consequences

- **Positive:** operators can backfill historical activity and re-run safely; the
  data lands in the same canonical tables the live pipeline writes, so ROI / risk
  / FOCUS export see it with no special-casing. No new dependency (reuses
  `ClickHouseService.insertRows` + Prisma); one forward-only migration.
- **Trade-offs / accepted:** the ClickHouse insert runs *inside* the Prisma
  interactive transaction to keep reserve-then-write atomic, which holds a PG
  connection across an external HTTP call — bounded by the per-request row cap, so
  large imports are chunked by the caller (idempotency keys make chunked retries
  safe). Two concurrent imports of the *same* key in the same instant could both
  observe it as fresh and both insert (no `RETURNING`-based reservation); this is a
  narrow window and the typed `findMany`/`createMany` path was chosen over raw
  `INSERT … ON CONFLICT … RETURNING` to match codebase convention and avoid the
  `$queryRaw` data-modifying-CTE pitfall.
- **Verification:** unit tests for the mapper (each signal → table, coercion,
  rejection cases) and the service (fresh import, skip-existing, within-batch
  dedupe, dry-run, reserve-before-insert ordering, CH-failure propagation,
  validation-line reporting, no-tenant guard); an api e2e (`make e2e`, fresh PG
  volume for migration 011) imports usage+outcome+risk, asserts the rows in
  ClickHouse, idempotent re-import is a no-op, dry-run writes nothing, RBAC (viewer
  → 403), validation line reporting, and cross-tenant isolation.

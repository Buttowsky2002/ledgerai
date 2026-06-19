# ADR-025 — CRM outcome connector deferred

**Date:** 2026-06-19
**Status:** Accepted
**Deciders:** Platform team
**Relates to:** Phase 3 (CLAUDE.md); ADR-016 (outcome connectors); ADR-017 (Jira/Zendesk connectors)

---

## Context

Phase 3 lists outcome connectors for `github | jira | zendesk | crm` (the CRM
importing "qualified leads"). GitHub, Jira and Zendesk are implemented and
tested against the `OutcomeConnector` framework (ADR-016/017). A CRM connector is
not yet built.

The CRM is the weakest-fit of the four for the current acceptance bar: the
Phase 3 demo proves end-to-end attribution through an **agent-stamped merged PR**
(deterministic, confidence 1.0), which the GitHub path already delivers. A CRM
"qualified lead" is a probabilistic, identity-matched outcome that exercises the
same matcher code paths the other connectors already cover.

## Decision

**Defer the CRM outcome connector** to a follow-up. The `OutcomeConnector`
framework already supports it (cursor sync, rate limiting, retry, tenant
stamping, `OutcomeSink`), so adding one later is additive — mirror
`github.go`/`zendesk.go` with `outcome_type = qualified_lead` and register it in
`cmd/outcome-sync`.

When picked up, **HubSpot** is the default target: a private-app bearer token +
REST Search API matches the simple token/REST pattern of the existing
connectors, unlike Salesforce's heavier OAuth + SOQL.

## Consequences

- Phase 3 acceptance is met without CRM (proven via the GitHub PR path); the
  `crm` slot in the spec is explicitly tracked here rather than silently dropped.
- No framework changes are needed to add it later.
- `schemas/graph/` already models `source_system = crm` / `outcome_type =
  qualified_lead`, so the schema is forward-compatible.

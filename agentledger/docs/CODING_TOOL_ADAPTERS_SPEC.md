# BadgerIQ — Coding-Tool Ingestion Adapters Spec
### GitHub Copilot & Cursor, mapped to their real export schemas

<!--
HOW TO USE: This specs two new adapters under services/ingest/adapters/ (copilot/, cursor/),
following the same pattern as the existing litellm/ adapter. It expands Phase 1/2 ingestion
in CLAUDE_CODE_BUILD_SPEC.md. Hand to Claude Code:
"Read CODING_TOOL_ADAPTERS_SPEC.md. Build the copilot adapter first per §4, then cursor per §5,
then the comparability layer in §6. Honor the security rules in §8 and acceptance criteria in §9."
All 15 CLAUDE.md security rules apply.
-->

## 1. Why these two, and what the adapter must actually solve

A coworker already proved the demand: someone manually pasted Cursor data into ChatGPT to compare it against Copilot. They got a one-time report — and hit a wall the moment they tried to compare the two tools head-to-head, because **each vendor defines its metrics differently**. That incomparability is not a nuisance to work around; it is the product. A chat session can *notice* the metrics don't line up. Only a normalization layer with a canonical schema can *resolve* them into a clean, ongoing, apples-to-apples view. These adapters are that layer.

The single hardest correctness problem (and the source of the coworker's wall):
**completion-style assistance and agent-style assistance are fundamentally different events and must never be mixed in one ratio.**
- *Completion/Tab*: a suggest → accept flow. Acceptance rate (accepted ÷ suggested) is meaningful.
- *Agent/Composer/edit*: the tool writes directly into files; there is no "suggestion" denominator. In Copilot, agent edits land in `loc_added_sum` but contribute **zero** to `loc_suggested_to_add_sum`, so any naive acceptance rate is garbage (Copilot can show >100%; agent rates are undefined). Cursor sidesteps this by tracking Tab and Composer separately.

The normalization contract below enforces that separation. That is the thing ChatGPT-with-an-export structurally cannot do.

## 2. Where this slots

```
services/ingest/adapters/
  litellm/        # EXISTS — reference pattern
  copilot/        # NEW (§4)
  cursor/         # NEW (§5)
  _normalize/     # NEW (§6) — shared canonical mapping + comparability rules
```
Adapters pull from the vendor APIs (or accept an uploaded export file for the demo path), normalize to the canonical records in §3, and emit to Redpanda `events.raw` exactly like the litellm adapter. Commit-level attribution records additionally feed the **deterministic layer** of the attribution engine (see ATTRIBUTION_ENGINE_BUILD.md §3.1).

## 3. Canonical normalized records (the contract)

Three record types, all carrying `tenant_id`, `source_tool` (`copilot`|`cursor`), `source_record_id`, `ingested_at`. Defined in `schemas/events/` and versioned.

**(a) `coding_seat_cost`** — normalizes the cost model difference.
- Copilot is **seat-licensed**: cost is the monthly seat price × assigned seats, *not* usage-derived. Mark `cost_basis = "seat_license"`.
- Cursor is **usage/spend-based**: `spendCents` per member per cycle. Mark `cost_basis = "usage"`.
- Fields: `period_start`, `period_end`, `identity_email`, `cost_usd`, `cost_basis`, `seats` (nullable).
- *Why it matters:* never compare Copilot's seat cost to Cursor's usage spend as if they're the same number; the ROI engine must read `cost_basis` and treat them correctly. This is a comparability trap most naive analyses fall into.

**(b) `coding_activity_daily`** — per user, per day, per tool, per mode.
- Fields: `date`, `identity_email`, `mode` (`completion`|`agent`|`chat`), `model` (nullable), `language` (nullable),
  `lines_suggested`, `lines_accepted`, `lines_added`, `lines_deleted`,
  `suggestions_shown`, `suggestions_accepted`, `interactions`, `is_active`.
- **Rule:** `mode` is mandatory and acceptance-rate fields are only populated for `mode = completion`. For `mode = agent`, leave suggestion fields null and populate `lines_added`/`lines_deleted` only.

**(c) `coding_commit_attribution`** — per commit, the strongest ROI signal.
- Fields: `commit_hash`, `identity_email`, `repo`, `branch`, `committed_at`,
  `lines_total`, `lines_ai`, `ai_source` (`tab`|`composer`|`agent`|`copilot`|`mixed`), `ai_share_pct`, `is_production_branch`.
- Feeds the deterministic attribution layer: a commit with known AI lines is a ground-truth labeled link.

## 4. Adapter A — GitHub Copilot

**Source (current API; the legacy `/copilot/metrics` JSON endpoint sunset April 2, 2026):**
- `GET /enterprises/{enterprise}/copilot/metrics/reports/enterprise-28-day/latest` (or `/orgs/{org}/...`). Returns `{ download_links[], report_start_day, report_end_day }`. The `download_links` are **signed, expiring URLs** — fetch promptly.
- Each download link is an **NDJSON** file: one JSON object per line. Parse line-by-line, never as a single array.
- Also pull **PR lifecycle metrics** (PR creation/merge counts, median time to merge) at org/enterprise scope — these feed outcomes, not just activity.
- Adoption/recency: `last_activity_at` from the Copilot user-management API (90-day retention).

**Auth:** PAT/OAuth with `manage_billing:copilot`, `read:org`, or `read:enterprise`. Send `X-GitHub-Api-Version` header. Store the token per CLAUDE.md §4.1/§4.9 (env/secrets, never in repo).

**Field mapping (per-user NDJSON record → canonical):**

| Copilot field | Canonical | Notes |
|---|---|---|
| `report_start_day`/`report_end_day` | `coding_activity_daily.date` window | 28-day window per report |
| user identifier + `enterprise_id`/`organization_id` | `identity_email` (resolve via member API) | |
| `totals_by_feature[]` / `totals_by_language_feature[]` `feature` value | `mode` | `agent_edit`, `chat_panel_agent_mode` → `agent`/`chat`; inline completions → `completion` |
| `loc_suggested_to_add_sum` (+delete) | `lines_suggested` | **only for completion features** |
| `loc_added_sum` / `loc_deleted_sum` | `lines_added` / `lines_deleted` | includes agent edits — keep separate from suggested |
| `code_generation_activity_count` | `interactions` | |
| `code_acceptance_activity_count` | `suggestions_accepted` | completion modes only |
| `totals_by_model` `model` value | `model` | **Claude vs GPT split inside Copilot** — valuable |
| `totals_by_ide` | (drop or store as dim) | |

**The agent_edit handling (critical):** when `feature` is `agent_edit` or `chat_panel_agent_mode`, set `mode=agent`, populate only `lines_added`/`lines_deleted`, and leave all suggestion/acceptance fields null. Do **not** compute an acceptance rate for these rows. This is the fix for the >100% / undefined-rate problem.

**Constraints to surface to the user:** org needs ≥5 active Copilot users on a day to report; users must have IDE telemetry enabled or they're excluded; data lags ~1 day; up to 100 days history. Copilot does **not** natively attribute lines to specific commits — for commit attribution, derive `coding_commit_attribution` from the GitHub repo's `Co-Authored-By` trailer (deterministic layer) rather than from the metrics API.

## 5. Adapter B — Cursor

Two tiers — detect and degrade gracefully:

**Standard team (Admin/Usage API), auth = API key `key_xxx...` as basic-auth username:**
- `POST https://api.cursor.com/teams/daily-usage-data` body `{startDate, endDate}` (epoch **ms**) → per-user/day metrics.
- `POST /teams/spend` → `teamMemberSpend[]` (`spendCents`, `fastPremiumRequests`, `name`, `email`, `role`, `hardLimitOverrideDollars`), `subscriptionCycleStart`.
- `GET /teams/members` → `{name,email,role}` for identity resolution.

**Enterprise team (adds AI Code Tracking / Analytics API):**
- `/analytics/ai-code/commits` → per-commit records attributing lines to **TAB**, **COMPOSER**, and non-AI, with commit hash, user, repo/branch, line counts. This is the genuine commit-level signal (the "89% of committed code" number).
- `/analytics/ai-code/changes` → daily accepted AI changes grouped by `changeId`.
- CSV stream endpoints page 10,000 records server-side for large pulls.

**Field mapping:**

| Cursor field | Canonical | Notes |
|---|---|---|
| `spendCents` | `coding_seat_cost.cost_usd` (=/100) | `cost_basis="usage"` |
| `subscriptionCycleStart` | `period_start` | |
| daily `acceptedLinesAdded`/`acceptedLinesDeleted` | `lines_accepted` (added/deleted) | Tab/Composer accepts |
| daily `totalLinesAdded`/`totalLinesDeleted` | (total editor activity) | for AI-share math |
| `totalTabsShown` / tabs accepted | `suggestions_shown` / `suggestions_accepted` | `mode=completion` |
| chat message counts | `interactions` (`mode=chat`) | |
| model usage breakdown | `model` | |
| `isActive` | `is_active` | |
| commit record: hash/user/repo/branch | `coding_commit_attribution.*` | enterprise only |
| commit lines by TAB/COMPOSER | `lines_ai` + `ai_source` | TAB→`tab`, COMPOSER→`composer` |
| AI share of committed code | `ai_share_pct` | Cursor computes natively |

**Constraints to surface:** commit/analytics endpoints are **Enterprise-only**; AI detection is **on-device via diff signatures** and the commit must be scored on the same machine that authored it; **Background Agents and Cursor CLI are not yet tracked**; needs an internet connection (offline work doesn't log); production-branch detection falls back to `main`/`master`/`production`/`prod`; unresolved remotes show as `Unknown` repository.

## 6. The comparability layer (`_normalize/`) — the actual differentiator

This is what makes BadgerIQ answer the question ChatGPT couldn't. Rules:

1. **Never cross-compare across `mode`.** Acceptance rate is reported only for `completion` rows; agent contribution is reported as lines/commits, never as a rate. Surface both, clearly labeled, side by side.
2. **One canonical "AI share of committed code"** computed the same way for both: `lines_ai / lines_total` from `coding_commit_attribution`. Cursor supplies this natively; for Copilot, derive it from the repo's `Co-Authored-By` commits (deterministic). Now the two are genuinely comparable.
3. **Normalize cost honestly** via `cost_basis` (seat vs usage). Cost-per-AI-commit and cost-per-story-point are computed per tool with the correct basis; never divide Copilot seat cost by Cursor usage events.
4. **Unified model attribution** — both expose which model did the work; roll up Claude-vs-GPT-vs-other across both tools in one view.
5. Mark every metric with its **source definition** so the audit UI can explain "this rate excludes agent edits because the vendor doesn't count them as suggestions."

Output: the **Tool Comparison view** (spend, AI code share, acceptance rate where defined, cost per AI commit, model mix — per tool, normalized). This is the demo that visibly does what the coworker's ChatGPT session could not.

## 7. Architecture fit
Both adapters use the connector framework: cursor-based incremental sync (store last `report_end_day` / `endDate` watermark in Postgres `connectors`), per-connector rate limiting (Cursor's GitHub-repo endpoints are very strict — 1 req/min/user), retry with jitter, signed-URL-expiry awareness for Copilot. Normalized records → `events.raw` → ClickHouse via the existing insert worker. `coding_commit_attribution` → attribution engine deterministic layer. A **file-upload path** (drop a Copilot NDJSON or Cursor CSV) reuses the same normalizer — that's your design-partner/demo on-ramp before API credentials are wired.

## 8. Security & privacy (additional to CLAUDE.md §4)
- API tokens (GitHub PAT, Cursor `key_xxx`) live in secrets, referenced by name; never in repo or logs. Use least-privilege scopes.
- These APIs return **metrics, not source code** — good. Do not request, store, or log any code content. If the file-upload path receives an export, validate it against the expected schema before parsing (untrusted input, §4.15) and reject anything containing unexpected free-text/code fields.
- Identity emails are PII: store per §4.14, support tenant deletion.
- Per-tenant isolation on every normalized record; the cross-tenant read test covers these tables too.

## 9. Acceptance criteria & test fixtures
- Synthetic fixtures committed (no real data, §4.1): a Copilot NDJSON file including an `agent_edit` row with `loc_added_sum>0` and `loc_suggested_to_add_sum=0`; a Cursor `daily-usage-data` JSON and a `commits` CSV with TAB+COMPOSER lines.
- **Agent-edit test (the headline):** the Copilot `agent_edit` row produces a canonical `agent` record with null suggestion fields and a populated `lines_added`; the normalizer never emits an acceptance rate for it; no metric exceeds 100%.
- Cost-basis test: Copilot seat cost and Cursor usage spend land with correct `cost_basis` and are never summed into one "spend per suggestion" figure.
- Comparability test: given both tools' fixtures, the Tool Comparison view yields a single normalized "AI share of committed code" per tool that is computed identically.
- Incremental test: re-running an adapter from its watermark produces no duplicate records (ReplacingMergeTree dedup verified).
- Enterprise-degradation test: a Cursor standard-tier key yields activity+spend records and cleanly omits commit attribution without erroring.

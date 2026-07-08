-- BadgerIQ Postgres migration 023 — Postgres-only analytics backend (MVP)
--
-- Cloud Run MVP consolidation: with BADGERIQ_ANALYTICS_BACKEND=postgres the
-- API serves analytics from Postgres instead of ClickHouse (no ClickHouse /
-- Redpanda in the deployment). This migration mirrors the ClickHouse schema
-- (deploy/clickhouse/001..017) as ordinary tables + views:
--
--   * ReplacingMergeTree tables → tables with a PRIMARY KEY on the ClickHouse
--     ordering key; the API upserts (latest row wins), so FINAL semantics hold.
--   * SummingMergeTree MV targets (spend_daily, spend_hourly_by_key,
--     risk_daily, spend_daily_by_user) → plain VIEWS over llm_calls. The MVs
--     existed for ClickHouse insert-time aggregation; at MVP volume Postgres
--     aggregates at read time.
--   * coding_agent_daily (SummingMergeTree) → table; the API sums on conflict.
--   * v_roi / v_unit_economics / v_outcome_graph / etc. → ported views.
--
-- Tenant isolation: every table gets the standard RLS policy
-- (tenant_id = app_current_tenant()::text — analytics tenant ids are text to
-- match the ClickHouse contract). Views use security_invoker so the caller's
-- RLS context applies. This migration is additive and harmless for
-- ClickHouse-backed deployments.
--
-- Forward-only; never edit an applied migration.

BEGIN;

-- ============================================================
-- Raw LLM call events (mirrors clickhouse/001 + 016 + 017)
-- ============================================================
CREATE TABLE IF NOT EXISTS llm_calls (
    call_id            text NOT NULL,
    ts                 timestamptz NOT NULL,

    tenant_id          text NOT NULL,
    team_id            text NOT NULL DEFAULT '',
    user_id            text NOT NULL DEFAULT '',
    app_id             text NOT NULL DEFAULT '',
    environment        text NOT NULL DEFAULT '',
    virtual_key_id     text NOT NULL DEFAULT '',

    agent_id           text NOT NULL DEFAULT '',
    run_id             text NOT NULL DEFAULT '',
    step_id            text NOT NULL DEFAULT '',

    provider           text NOT NULL DEFAULT '',
    request_model      text NOT NULL DEFAULT '',
    response_model     text NOT NULL DEFAULT '',
    operation_name     text NOT NULL DEFAULT '',

    input_tokens       bigint NOT NULL DEFAULT 0,
    output_tokens      bigint NOT NULL DEFAULT 0,
    cache_read_tokens  bigint NOT NULL DEFAULT 0,
    cache_write_tokens bigint NOT NULL DEFAULT 0,
    cost_usd           double precision NOT NULL DEFAULT 0,

    latency_ms         bigint NOT NULL DEFAULT 0,
    status_code        integer NOT NULL DEFAULT 0,
    status             text NOT NULL DEFAULT '',

    prompt_hash        text NOT NULL DEFAULT '',
    dlp_action         text NOT NULL DEFAULT '',
    risk_severity      text NOT NULL DEFAULT '',
    dlp_findings       text NOT NULL DEFAULT '[]',
    streamed           smallint NOT NULL DEFAULT 0,

    source             text NOT NULL DEFAULT 'gateway',

    -- clickhouse/016: Cursor billed vs usage-value split
    usage_value_usd    double precision NOT NULL DEFAULT 0,
    -- clickhouse/017: universal metered cost
    cost_source        text NOT NULL DEFAULT '',
    metered_cost_usd   double precision NOT NULL DEFAULT 0,

    PRIMARY KEY (tenant_id, ts, call_id)
);
CREATE INDEX IF NOT EXISTS llm_calls_tenant_day ON llm_calls (tenant_id, ((ts AT TIME ZONE 'UTC')::date));

-- ============================================================
-- Agent runs / outcomes (clickhouse/001)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_runs (
    run_id         text NOT NULL,
    tenant_id      text NOT NULL,
    agent_id       text NOT NULL DEFAULT '',
    app_id         text NOT NULL DEFAULT '',
    user_id        text NOT NULL DEFAULT '',
    started_at     timestamptz NOT NULL,
    ended_at       timestamptz,
    status         text NOT NULL DEFAULT '',
    objective      text NOT NULL DEFAULT '',
    outcome_id     text NOT NULL DEFAULT '',
    total_cost_usd double precision NOT NULL DEFAULT 0,
    total_tokens   bigint NOT NULL DEFAULT 0,
    llm_calls      bigint NOT NULL DEFAULT 0,
    tool_calls     bigint NOT NULL DEFAULT 0,
    risk_events    bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, started_at, run_id)
);
CREATE INDEX IF NOT EXISTS agent_runs_tenant_run ON agent_runs (tenant_id, run_id);

CREATE TABLE IF NOT EXISTS outcomes (
    outcome_id             text NOT NULL,
    tenant_id              text NOT NULL,
    ts                     timestamptz NOT NULL,
    source_system          text NOT NULL DEFAULT '',
    outcome_type           text NOT NULL DEFAULT '',
    team_id                text NOT NULL DEFAULT '',
    user_id                text NOT NULL DEFAULT '',
    run_id                 text NOT NULL DEFAULT '',
    business_value_usd     double precision NOT NULL DEFAULT 0,
    quality_score          double precision NOT NULL DEFAULT 0,
    attribution_confidence double precision NOT NULL DEFAULT 0,
    completion_status      text NOT NULL DEFAULT '',
    PRIMARY KEY (tenant_id, ts, outcome_id)
);
CREATE INDEX IF NOT EXISTS outcomes_tenant_run ON outcomes (tenant_id, run_id);

-- ============================================================
-- Tool calls / risk (clickhouse/007)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_tool_calls (
    tenant_id    text NOT NULL,
    agent_id     text NOT NULL DEFAULT '',
    run_id       text NOT NULL DEFAULT '',
    tool_call_id text NOT NULL,
    tool_name    text NOT NULL DEFAULT '',
    mcp_server   text NOT NULL DEFAULT '',
    ts           timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, agent_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS agent_tool_allow (
    tenant_id  text NOT NULL,
    agent_id   text NOT NULL,
    tool_name  text NOT NULL,
    allowed    smallint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, agent_id, tool_name)
);

CREATE TABLE IF NOT EXISTS risk_events (
    event_id    text NOT NULL,
    tenant_id   text NOT NULL,
    agent_id    text NOT NULL DEFAULT '',
    run_id      text NOT NULL DEFAULT '',
    category    text NOT NULL DEFAULT '',
    severity    text NOT NULL DEFAULT '',
    detail      text NOT NULL DEFAULT '',
    occurrences bigint NOT NULL DEFAULT 1,
    first_seen  timestamptz NOT NULL DEFAULT now(),
    detected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, agent_id, event_id)
);

CREATE TABLE IF NOT EXISTS agent_risk (
    tenant_id         text NOT NULL,
    agent_id          text NOT NULL,
    risk_exposure_pct double precision NOT NULL DEFAULT 0,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, agent_id)
);

-- ============================================================
-- ROI engine inputs (clickhouse/006)
-- ============================================================
CREATE TABLE IF NOT EXISTS roi_rates (
    tenant_id                    text NOT NULL,
    source_system                text NOT NULL DEFAULT '',
    outcome_type                 text NOT NULL DEFAULT '',
    hourly_rate                  double precision NOT NULL DEFAULT 0,
    baseline_minutes             double precision NOT NULL DEFAULT 0,
    rework_pct                   double precision NOT NULL DEFAULT 0,
    redeployment_factor          double precision NOT NULL DEFAULT 1,
    qa_cost_per_outcome          double precision NOT NULL DEFAULT 0,
    eval_cost_per_outcome        double precision NOT NULL DEFAULT 0,
    integration_cost_per_outcome double precision NOT NULL DEFAULT 0,
    platform_overhead_pct        double precision NOT NULL DEFAULT 0,
    updated_at                   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source_system, outcome_type)
);

CREATE TABLE IF NOT EXISTS roi_overrides (
    tenant_id             text NOT NULL,
    outcome_id            text NOT NULL,
    baseline_cost_usd     double precision,
    baseline_minutes      double precision,
    qa_cost_usd           double precision,
    eval_cost_usd         double precision,
    integration_cost_usd  double precision,
    platform_overhead_pct double precision,
    redeployment_factor   double precision,
    updated_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, outcome_id)
);

-- ============================================================
-- Provider billing + reconciliation (clickhouse/002 + 003)
-- ============================================================
CREATE TABLE IF NOT EXISTS provider_costs (
    tenant_id      text NOT NULL,
    day            date NOT NULL,
    provider       text NOT NULL DEFAULT '',
    model          text NOT NULL DEFAULT '',
    line_item      text NOT NULL DEFAULT '',
    virtual_key_id text NOT NULL DEFAULT '',
    input_tokens   bigint NOT NULL DEFAULT 0,
    output_tokens  bigint NOT NULL DEFAULT 0,
    cost_usd       double precision NOT NULL DEFAULT 0,
    currency       text NOT NULL DEFAULT 'USD',
    source         text NOT NULL DEFAULT '',
    imported_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, day, provider, model, source, line_item, virtual_key_id)
);

CREATE TABLE IF NOT EXISTS cost_adjustments (
    tenant_id         text NOT NULL,
    day               date NOT NULL,
    model             text NOT NULL DEFAULT '',
    gateway_cost_usd  double precision NOT NULL DEFAULT 0,
    provider_cost_usd double precision NOT NULL DEFAULT 0,
    drift_usd         double precision NOT NULL DEFAULT 0,
    drift_pct         double precision NOT NULL DEFAULT 0,
    flagged           smallint NOT NULL DEFAULT 0,
    threshold_pct     double precision NOT NULL DEFAULT 0,
    reconciled_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, day, model)
);

-- ============================================================
-- Fixed overhead + coding agents (clickhouse/012 + 015)
-- ============================================================
CREATE TABLE IF NOT EXISTS fixed_costs (
    tenant_id     text NOT NULL,
    period_month  date NOT NULL,
    vendor        text NOT NULL DEFAULT '',
    cost_type     text NOT NULL DEFAULT '',
    line_item     text NOT NULL DEFAULT '',
    seats         bigint NOT NULL DEFAULT 0,
    unit_cost_usd double precision NOT NULL DEFAULT 0,
    cost_usd      double precision NOT NULL DEFAULT 0,
    currency      text NOT NULL DEFAULT 'USD',
    attributable  smallint NOT NULL DEFAULT 0,
    source        text NOT NULL DEFAULT 'manual',
    note          text NOT NULL DEFAULT '',
    imported_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, period_month, vendor, cost_type, line_item)
);

CREATE TABLE IF NOT EXISTS coding_agent_daily (
    tenant_id text NOT NULL,
    day       date NOT NULL,
    provider  text NOT NULL DEFAULT '',
    user_id   text NOT NULL DEFAULT '',
    team_id   text NOT NULL DEFAULT '',
    agent_id  text NOT NULL DEFAULT '',
    cost_usd  double precision NOT NULL DEFAULT 0,
    sessions  bigint NOT NULL DEFAULT 0,
    requests  bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, day, provider, user_id, team_id, agent_id)
);

-- ============================================================
-- RLS (tenant ids are text here — the ClickHouse contract — so the policy
-- compares against app_current_tenant()::text). Fail closed with no binding.
-- ============================================================
DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'llm_calls', 'agent_runs', 'outcomes', 'agent_tool_calls',
        'agent_tool_allow', 'risk_events', 'agent_risk', 'roi_rates',
        'roi_overrides', 'provider_costs', 'cost_adjustments', 'fixed_costs',
        'coding_agent_daily'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = app_current_tenant()::text) '
            'WITH CHECK (tenant_id = app_current_tenant()::text)', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO agentledger_api', t);
    END LOOP;
END
$$;

-- ============================================================
-- Aggregate views replacing the ClickHouse materialized-view targets.
-- security_invoker so the caller's RLS context (app.tenant_id) applies.
-- ============================================================
CREATE OR REPLACE VIEW spend_daily WITH (security_invoker = true) AS
SELECT
    (ts AT TIME ZONE 'UTC')::date                                        AS day,
    tenant_id, team_id, app_id, provider,
    CASE WHEN response_model <> '' THEN response_model ELSE request_model END AS model,
    count(*)                                                             AS calls,
    sum(input_tokens)                                                    AS input_tokens,
    sum(output_tokens)                                                   AS output_tokens,
    sum(cache_read_tokens)                                               AS cached_tokens,
    sum(cost_usd)                                                        AS cost_usd,
    count(*) FILTER (WHERE status LIKE 'blocked%')                       AS blocked_calls,
    count(*) FILTER (WHERE status = 'upstream_error')                    AS error_calls
FROM llm_calls
GROUP BY day, tenant_id, team_id, app_id, provider, model;

CREATE OR REPLACE VIEW spend_hourly_by_key WITH (security_invoker = true) AS
SELECT
    date_trunc('hour', ts)            AS hour,
    tenant_id, virtual_key_id, agent_id,
    count(*)                          AS calls,
    sum(cost_usd)                     AS cost_usd,
    sum(input_tokens + output_tokens) AS total_tokens
FROM llm_calls
GROUP BY hour, tenant_id, virtual_key_id, agent_id;

CREATE OR REPLACE VIEW risk_daily WITH (security_invoker = true) AS
SELECT
    (ts AT TIME ZONE 'UTC')::date AS day,
    tenant_id, team_id, user_id, dlp_action, risk_severity,
    count(*)                      AS events
FROM llm_calls
WHERE dlp_action <> 'allow'
GROUP BY day, tenant_id, team_id, user_id, dlp_action, risk_severity;

-- clickhouse/014 semantics: unassigned spend surfaces as user 'Unassigned'.
CREATE OR REPLACE VIEW spend_daily_by_user WITH (security_invoker = true) AS
SELECT
    (ts AT TIME ZONE 'UTC')::date                                        AS day,
    tenant_id,
    CASE WHEN user_id = '' THEN 'Unassigned' ELSE user_id END            AS user_id,
    provider,
    CASE WHEN response_model <> '' THEN response_model ELSE request_model END AS model,
    count(*)                                                             AS calls,
    sum(cost_usd)                                                        AS cost_usd
FROM llm_calls
GROUP BY day, tenant_id, 3, provider, model;

-- ============================================================
-- v_roi — finance-grade ROI engine (port of clickhouse/006 + 011)
-- ============================================================
CREATE OR REPLACE VIEW v_roi WITH (security_invoker = true) AS
SELECT
    tenant_id,
    outcome_id,
    outcome_type,
    team_id,
    outcome_ts,
    run_id,
    agent_id,
    baseline_value_usd,
    value_usd,
    ai_cost_usd,
    qa_cost_usd,
    eval_cost_usd,
    integration_cost_usd,
    platform_overhead_usd,
    direct_cost_usd + platform_overhead_usd                                   AS fully_loaded_cost_usd,
    confidence                                                                AS attribution_confidence,
    risk_exposure_pct,
    value_usd - (direct_cost_usd + platform_overhead_usd)                     AS nominal_roi_usd,
    value_usd * confidence - (direct_cost_usd + platform_overhead_usd)        AS expected_roi_usd,
    value_usd * confidence * (1 - risk_exposure_pct)
        - (direct_cost_usd + platform_overhead_usd)                           AS risk_adjusted_roi_usd,
    value_usd * confidence * (1 - risk_exposure_pct)
        - (direct_cost_usd + platform_overhead_usd)                           AS roi_low_usd,
    value_usd - (direct_cost_usd + platform_overhead_usd)                     AS roi_high_usd,
    confidence >= 0.5                                                         AS headline_eligible
FROM (
    SELECT
        b.*,
        CASE WHEN b.business_value_usd > 0 THEN b.business_value_usd
             ELSE b.baseline_value_usd * (1 - b.rework_pct) * b.redeployment_factor
        END                                                                    AS value_usd,
        b.ai_cost_usd + b.qa_cost_usd + b.eval_cost_usd + b.integration_cost_usd AS direct_cost_usd,
        (b.ai_cost_usd + b.qa_cost_usd + b.eval_cost_usd + b.integration_cost_usd)
            * b.platform_overhead_pct                                          AS platform_overhead_usd
    FROM (
        SELECT
            o.tenant_id,
            o.outcome_id,
            o.outcome_type,
            o.team_id,
            o.ts                                                              AS outcome_ts,
            o.run_id,
            r.agent_id,
            o.business_value_usd,
            coalesce(ov.baseline_cost_usd,
                     coalesce(rt.hourly_rate, 0)
                     * coalesce(ov.baseline_minutes, rt.baseline_minutes, 0) / 60.0) AS baseline_value_usd,
            coalesce(rt.rework_pct, 0)                                        AS rework_pct,
            coalesce(ov.redeployment_factor, rt.redeployment_factor, 1.0)     AS redeployment_factor,
            coalesce(r.total_cost_usd, 0)                                     AS ai_cost_usd,
            coalesce(ov.qa_cost_usd, rt.qa_cost_per_outcome, 0)               AS qa_cost_usd,
            coalesce(ov.eval_cost_usd, rt.eval_cost_per_outcome, 0)           AS eval_cost_usd,
            coalesce(ov.integration_cost_usd, rt.integration_cost_per_outcome, 0) AS integration_cost_usd,
            coalesce(ov.platform_overhead_pct, rt.platform_overhead_pct, 0)   AS platform_overhead_pct,
            o.attribution_confidence                                          AS confidence,
            coalesce(ar.risk_exposure_pct, 0)                                 AS risk_exposure_pct
        FROM outcomes o
        LEFT JOIN agent_runs r
            ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
        LEFT JOIN roi_rates rt
            ON rt.tenant_id = o.tenant_id AND rt.source_system = o.source_system
           AND rt.outcome_type = o.outcome_type
        LEFT JOIN roi_overrides ov
            ON ov.tenant_id = o.tenant_id AND ov.outcome_id = o.outcome_id
        LEFT JOIN agent_risk ar
            ON ar.tenant_id = o.tenant_id AND ar.agent_id = r.agent_id
    ) b
) x;

-- ============================================================
-- Downstream views over v_roi / the graph (clickhouse/001, 005, 010)
-- ============================================================
CREATE OR REPLACE VIEW v_unit_economics WITH (security_invoker = true) AS
SELECT
    o.tenant_id,
    (date_trunc('month', o.ts))::date                        AS month,
    o.outcome_type,
    o.team_id,
    count(*)                                                 AS outcomes,
    sum(r.total_cost_usd)                                    AS ai_cost_usd,
    sum(o.business_value_usd)                                AS business_value_usd,
    sum(r.total_cost_usd) / nullif(count(*), 0)              AS cost_per_outcome,
    sum(o.business_value_usd) - sum(r.total_cost_usd)        AS net_value_usd,
    avg(o.attribution_confidence)                            AS avg_confidence
FROM outcomes o
LEFT JOIN agent_runs r
    ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id
GROUP BY o.tenant_id, month, o.outcome_type, o.team_id;

CREATE OR REPLACE VIEW v_outcome_graph WITH (security_invoker = true) AS
SELECT
    o.tenant_id,
    o.outcome_id,
    o.outcome_type,
    o.source_system,
    o.ts                                     AS outcome_ts,
    o.run_id,
    r.agent_id,
    r.user_id,
    r.total_cost_usd                         AS ai_cost_usd,
    o.business_value_usd,
    o.business_value_usd - r.total_cost_usd  AS net_value_usd,
    o.attribution_confidence,
    o.attribution_confidence >= 0.5          AS headline_eligible
FROM outcomes o
LEFT JOIN agent_runs r
    ON r.tenant_id = o.tenant_id AND r.run_id = o.run_id;

CREATE OR REPLACE VIEW v_agent_daily_unit_economics WITH (security_invoker = true) AS
SELECT
    tenant_id,
    agent_id,
    day,
    cost_usd,
    outcomes_count,
    value_usd,
    value_usd - fully_loaded_cost_usd                 AS net_value_usd,
    fully_loaded_cost_usd / nullif(success_count, 0)  AS cost_per_success,
    attribution_confidence_avg,
    risk_adjusted_roi
FROM (
    SELECT
        tenant_id,
        agent_id,
        (outcome_ts AT TIME ZONE 'UTC')::date        AS day,
        sum(ai_cost_usd)                             AS cost_usd,
        count(*)                                     AS outcomes_count,
        sum(value_usd)                               AS value_usd,
        sum(fully_loaded_cost_usd)                   AS fully_loaded_cost_usd,
        count(*) FILTER (WHERE headline_eligible)    AS success_count,
        avg(attribution_confidence)                  AS attribution_confidence_avg,
        sum(risk_adjusted_roi_usd)                   AS risk_adjusted_roi
    FROM v_roi
    WHERE agent_id IS NOT NULL AND agent_id <> ''
    GROUP BY tenant_id, agent_id, day
) agg;

-- ============================================================
-- Reconciliation + drift views (clickhouse/002 + 003)
-- ============================================================
CREATE OR REPLACE VIEW v_cost_reconciliation WITH (security_invoker = true) AS
WITH gw AS (
    SELECT
        tenant_id,
        (ts AT TIME ZONE 'UTC')::date AS day,
        CASE WHEN response_model <> '' THEN response_model ELSE request_model END AS model,
        sum(cost_usd)                 AS gateway_cost_usd,
        count(*)                      AS gateway_calls
    FROM llm_calls
    WHERE source = 'gateway' AND status = 'ok'
    GROUP BY tenant_id, day, model
),
pv AS (
    SELECT tenant_id, day, model, sum(cost_usd) AS provider_cost_usd
    FROM provider_costs
    GROUP BY tenant_id, day, model
)
SELECT
    coalesce(gw.tenant_id, pv.tenant_id)  AS tenant_id,
    coalesce(gw.day, pv.day)              AS day,
    coalesce(gw.model, pv.model)          AS model,
    coalesce(gw.gateway_cost_usd, 0)      AS gateway_cost_usd,
    coalesce(pv.provider_cost_usd, 0)     AS provider_cost_usd,
    coalesce(pv.provider_cost_usd, 0) - coalesce(gw.gateway_cost_usd, 0) AS drift_usd,
    CASE WHEN coalesce(pv.provider_cost_usd, 0) = 0 THEN 0
         ELSE (coalesce(pv.provider_cost_usd, 0) - coalesce(gw.gateway_cost_usd, 0))
              / pv.provider_cost_usd
    END                                   AS drift_pct
FROM gw
FULL OUTER JOIN pv
    ON gw.tenant_id = pv.tenant_id AND gw.day = pv.day AND gw.model = pv.model;

CREATE OR REPLACE VIEW v_flagged_drift WITH (security_invoker = true) AS
SELECT tenant_id, day, model, gateway_cost_usd, provider_cost_usd, drift_usd, drift_pct, threshold_pct
FROM cost_adjustments
WHERE flagged = 1;

-- ============================================================
-- Fixed-overhead views (clickhouse/012)
-- ============================================================
CREATE OR REPLACE VIEW v_fixed_cost_monthly WITH (security_invoker = true) AS
SELECT
    tenant_id,
    period_month,
    vendor,
    cost_type,
    sum(cost_usd)    AS cost_usd,
    sum(seats)       AS seats,
    max(imported_at) AS last_imported_at
FROM fixed_costs
WHERE attributable = 0
GROUP BY tenant_id, period_month, vendor, cost_type;

CREATE OR REPLACE VIEW v_total_cost_of_ai WITH (security_invoker = true) AS
WITH gw AS (
    SELECT
        tenant_id,
        (date_trunc('month', ts))::date AS month,
        sum(cost_usd)                   AS attributable_cost_usd
    FROM llm_calls
    WHERE source = 'gateway' AND status = 'ok'
    GROUP BY tenant_id, month
),
fx AS (
    SELECT
        tenant_id,
        (date_trunc('month', period_month::timestamp))::date AS month,
        sum(cost_usd)                                        AS fixed_cost_usd
    FROM fixed_costs
    WHERE attributable = 0
    GROUP BY tenant_id, month
)
SELECT
    coalesce(gw.tenant_id, fx.tenant_id)  AS tenant_id,
    coalesce(gw.month, fx.month)          AS month,
    coalesce(gw.attributable_cost_usd, 0) AS attributable_cost_usd,
    coalesce(fx.fixed_cost_usd, 0)        AS fixed_cost_usd,
    coalesce(gw.attributable_cost_usd, 0) + coalesce(fx.fixed_cost_usd, 0) AS total_cost_of_ai_usd,
    coalesce(fx.fixed_cost_usd, 0)
        / nullif(coalesce(gw.attributable_cost_usd, 0) + coalesce(fx.fixed_cost_usd, 0), 0) AS fixed_cost_pct
FROM gw
FULL OUTER JOIN fx
    ON gw.tenant_id = fx.tenant_id AND gw.month = fx.month;

-- ============================================================
-- Tool-governance views (clickhouse/007; used by the risk engine)
-- ============================================================
CREATE OR REPLACE VIEW v_unauthorized_tools WITH (security_invoker = true) AS
SELECT
    tc.tenant_id,
    tc.agent_id,
    tc.tool_name,
    min(tc.ts) AS first_seen,
    count(*)   AS occurrences
FROM agent_tool_calls tc
WHERE NOT EXISTS (
    SELECT 1 FROM agent_tool_allow al
    WHERE al.tenant_id = tc.tenant_id AND al.agent_id = tc.agent_id
      AND al.tool_name = tc.tool_name AND al.allowed = 1
)
GROUP BY tc.tenant_id, tc.agent_id, tc.tool_name;

CREATE OR REPLACE VIEW v_agent_tool_exposure WITH (security_invoker = true) AS
SELECT
    tc.tenant_id,
    tc.agent_id,
    count(*) AS total_calls,
    count(*) FILTER (WHERE al.allowed IS NULL)              AS unauthorized_calls,
    count(*) FILTER (WHERE al.allowed IS NULL)::float8 / count(*) AS exposure_pct
FROM agent_tool_calls tc
LEFT JOIN agent_tool_allow al
    ON al.tenant_id = tc.tenant_id AND al.agent_id = tc.agent_id
   AND al.tool_name = tc.tool_name AND al.allowed = 1
GROUP BY tc.tenant_id, tc.agent_id;

-- Views inherit no privileges: grant reads to the API role.
DO $$
DECLARE
    v text;
BEGIN
    FOREACH v IN ARRAY ARRAY[
        'spend_daily', 'spend_hourly_by_key', 'risk_daily', 'spend_daily_by_user',
        'v_roi', 'v_unit_economics', 'v_outcome_graph', 'v_agent_daily_unit_economics',
        'v_cost_reconciliation', 'v_flagged_drift', 'v_fixed_cost_monthly',
        'v_total_cost_of_ai', 'v_unauthorized_tools', 'v_agent_tool_exposure'
    ]
    LOOP
        EXECUTE format('GRANT SELECT ON %I TO agentledger_api', v);
    END LOOP;
END
$$;

COMMIT;

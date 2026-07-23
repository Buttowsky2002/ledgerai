-- BadgerIQ Postgres migration 028 — analytics RLS harden (Phase 8, Postgres path)
--
-- Production uses BADGERIQ_ANALYTICS_BACKEND=postgres (no ClickHouse). Migration
-- 023 already ENABLE/FORCE RLS + tenant_isolation on the analytics mirror
-- tables. This migration is the Postgres equivalent of ClickHouse ROW POLICY
-- verification: idempotently re-assert FORCE RLS and the fail-closed policy
--   tenant_id = app_current_tenant()::text
-- for every analytics table (text tenant ids match the former CH contract).
--
-- Views stay security_invoker (023 / 025) so the caller's RLS GUC applies.
-- Forward-only; never edit an applied migration.

BEGIN;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'llm_calls',
        'agent_runs',
        'outcomes',
        'agent_tool_calls',
        'agent_tool_allow',
        'risk_events',
        'agent_risk',
        'roi_rates',
        'roi_overrides',
        'provider_costs',
        'cost_adjustments',
        'fixed_costs',
        'coding_agent_daily'
    ];
BEGIN
    IF to_regprocedure('app_current_tenant()') IS NULL THEN
        RAISE EXCEPTION 'app_current_tenant() missing — apply migration 002_rls.sql first';
    END IF;

    FOREACH t IN ARRAY tables
    LOOP
        IF to_regclass(format('public.%I', t)) IS NULL THEN
            RAISE NOTICE 'analytics table % missing — skip RLS (apply 023_analytics_mvp.sql)', t;
            CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I '
            'USING (tenant_id = app_current_tenant()::text) '
            'WITH CHECK (tenant_id = app_current_tenant()::text)',
            t
        );
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO agentledger_api',
            t
        );
    END LOOP;
END
$$;

-- Re-assert SELECT on analytics views (security_invoker inherits table RLS).
DO $$
DECLARE
    v text;
    views text[] := ARRAY[
        'spend_daily',
        'spend_hourly_by_key',
        'risk_daily',
        'spend_daily_by_user',
        'v_roi',
        'v_unit_economics',
        'v_outcome_graph',
        'v_agent_daily_unit_economics',
        'v_cost_reconciliation',
        'v_flagged_drift',
        'v_fixed_cost_monthly',
        'v_total_cost_of_ai',
        'v_unauthorized_tools',
        'v_agent_tool_exposure',
        'v_cost_basis_daily'
    ];
BEGIN
    FOREACH v IN ARRAY views
    LOOP
        IF to_regclass(format('public.%I', v)) IS NULL THEN
            RAISE NOTICE 'analytics view % missing — skip GRANT', v;
            CONTINUE;
        END IF;
        EXECUTE format('GRANT SELECT ON %I TO agentledger_api', v);
    END LOOP;
END
$$;

COMMIT;

-- ============================================================
-- 031 — invite_accept: tenant GUC + no PL/pgSQL column shadowing
-- ============================================================
-- Two bugs on the public accept path:
--   1. identities has FORCE RLS; bind app.tenant_id before upsert.
--   2. RETURNS TABLE (user_id, tenant_id, api_role, email) creates PL/pgSQL
--      variables that make ON CONFLICT (tenant_id, email) ambiguous and abort
--      the INSERT — remapped by the API to "invalid or expired invite token".
--
-- #variable_conflict use_column prefers table columns in embedded SQL.
-- Forward-only; never edit an applied migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.invite_accept(
    p_token        TEXT,
    p_display_name TEXT
)
RETURNS TABLE (user_id UUID, tenant_id UUID, api_role TEXT, email TEXT)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
    v_invite  invites%ROWTYPE;
    v_user_id UUID;
BEGIN
    SELECT * INTO v_invite
    FROM   invites
    WHERE  token_hash  = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
      AND  status      = 'pending'
      AND  expires_at  > now()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid or expired invite token';
    END IF;

    -- Bind tenant for FORCE RLS on identities (and invites) for this txn.
    PERFORM set_config('app.tenant_id', v_invite.tenant_id::text, true);

    UPDATE invites
       SET status       = 'accepted',
           accepted_at  = now(),
           display_name = p_display_name
     WHERE invite_id = v_invite.invite_id;

    INSERT INTO identities AS ident (
        tenant_id, email, display_name, api_role, source, active
    )
    VALUES (
        v_invite.tenant_id,
        v_invite.email,
        p_display_name,
        v_invite.api_role,
        'invite',
        true
    )
    ON CONFLICT (tenant_id, email)
    DO UPDATE SET
        api_role     = EXCLUDED.api_role,
        display_name = CASE WHEN EXCLUDED.display_name IS NOT NULL
                            THEN EXCLUDED.display_name
                            ELSE ident.display_name END,
        active       = true
    RETURNING ident.user_id INTO v_user_id;

    RETURN QUERY
        SELECT v_user_id, v_invite.tenant_id, v_invite.api_role, v_invite.email;
END;
$$;

REVOKE EXECUTE ON FUNCTION invite_accept(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_accept(TEXT, TEXT) TO agentledger_api;

COMMIT;

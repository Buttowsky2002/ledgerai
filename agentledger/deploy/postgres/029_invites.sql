-- ============================================================
-- 029 — invite-only access: invites table + helper functions
-- ============================================================
-- Forward-only; never edit an applied migration.
-- Grants target agentledger_api (badgeriq_app inherits via 024).

BEGIN;

-- ---- Table ----

CREATE TABLE invites (
    invite_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID        NOT NULL REFERENCES tenants ON DELETE CASCADE,
    email        TEXT        NOT NULL,
    api_role     TEXT        NOT NULL DEFAULT 'viewer'
                                 CHECK (api_role IN ('viewer', 'analyst', 'admin')),
    display_name TEXT,                            -- invitee sets this on accept
    token_hash   TEXT        NOT NULL UNIQUE,      -- SHA-256(raw_token); raw token never stored
    invited_by   UUID        NOT NULL REFERENCES identities (user_id),
    status       TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'accepted', 'revoked')),
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
    accepted_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invites
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON invites TO agentledger_api;

CREATE INDEX ix_invites_tenant ON invites (tenant_id);
CREATE INDEX ix_invites_token  ON invites (token_hash);
CREATE INDEX ix_invites_tenant_email_pending
    ON invites (tenant_id, email)
    WHERE status = 'pending';

-- ---- SECURITY DEFINER functions (bypass RLS for public flows) ----

-- Called by the public accept-invite route (no tenant bound yet).
-- Returns the invite row if the token is valid, pending, and not expired.
CREATE OR REPLACE FUNCTION public.invite_lookup_by_token(p_token TEXT)
RETURNS TABLE (
    invite_id    UUID,
    tenant_id    UUID,
    email        TEXT,
    api_role     TEXT,
    expires_at   TIMESTAMPTZ
)
SECURITY DEFINER
SET search_path = public
LANGUAGE sql STABLE AS $$
    SELECT invite_id, tenant_id, email, api_role, expires_at
    FROM   invites
    WHERE  token_hash  = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
      AND  status      = 'pending'
      AND  expires_at  > now();
$$;

-- Atomically mark invite accepted and upsert the identity.
-- Returns user_id, tenant_id, api_role, and email for the accept response.
CREATE OR REPLACE FUNCTION public.invite_accept(
    p_token        TEXT,
    p_display_name TEXT
)
RETURNS TABLE (user_id UUID, tenant_id UUID, api_role TEXT, email TEXT)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
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

    UPDATE invites
       SET status       = 'accepted',
           accepted_at  = now(),
           display_name = p_display_name
     WHERE invite_id = v_invite.invite_id;

    INSERT INTO identities (tenant_id, email, display_name, api_role, source, active)
    VALUES (v_invite.tenant_id, v_invite.email,
            p_display_name, v_invite.api_role, 'invite', true)
    ON CONFLICT (tenant_id, email)
    DO UPDATE SET
        api_role     = EXCLUDED.api_role,
        display_name = CASE WHEN EXCLUDED.display_name IS NOT NULL
                            THEN EXCLUDED.display_name
                            ELSE identities.display_name END,
        active       = true
    RETURNING identities.user_id INTO v_user_id;

    RETURN QUERY SELECT v_user_id, v_invite.tenant_id, v_invite.api_role, v_invite.email;
END;
$$;

REVOKE EXECUTE ON FUNCTION invite_lookup_by_token(TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION invite_accept(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_lookup_by_token(TEXT) TO agentledger_api;
GRANT EXECUTE ON FUNCTION invite_accept(TEXT, TEXT) TO agentledger_api;

COMMIT;

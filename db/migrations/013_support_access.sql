-- PR-C: temporary, owner-approved support access. The platform has NO standing access to a shop's business data:
-- a platform admin asks (reason, duration, scope), the shop OWNER approves or refuses, access ends at expiry or at once
-- on revocation, and every request made under it is written to the shop's own journal.

CREATE TABLE support_grants (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES users(id),          -- the platform admin who will use it (only this person)
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  scope text NOT NULL CHECK (scope IN ('view','assist')),
  minutes int NOT NULL CHECK (minutes BETWEEN 15 AND 1440),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','refused','revoked','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (id),
  CHECK (status <> 'approved' OR expires_at IS NOT NULL)
);
CREATE INDEX support_grants_open ON support_grants (tenant_id, status, created_at DESC);
ALTER TABLE support_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY support_grants_tenant ON support_grants USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
GRANT SELECT, UPDATE ON support_grants TO app_runtime;   -- the shop decides/revokes; requests come only from the platform function

-- the session remembers which grant it is using (NULL for a normal membership session)
ALTER TABLE sessions ADD COLUMN support_grant_id uuid REFERENCES support_grants(id);

-- A grant is usable only while approved, not revoked, not expired, by the platform admin who asked for it.
-- (support_grants has FORCE RLS: the check runs in that shop's context and restores the caller's context)
CREATE FUNCTION support_grant_valid(p_grant uuid, p_user uuid, p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_prev text := current_setting('app.tenant_id', true); v boolean;
BEGIN
  IF p_grant IS NULL OR p_user IS NULL OR p_tenant IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT EXISTS (SELECT 1 FROM support_grants g
    WHERE g.id=p_grant AND g.tenant_id=p_tenant AND g.requested_by=p_user AND g.status='approved'
      AND g.revoked_at IS NULL AND g.expires_at>now()
      AND EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id=p_user)) INTO v;
  PERFORM set_config('app.tenant_id', COALESCE(v_prev,''), true);
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION support_grant_valid(uuid,uuid,uuid) FROM PUBLIC;

-- Session lookup: a support session whose grant is no longer valid loses its shop IMMEDIATELY (revocation/expiry).
DROP FUNCTION auth_get_session(text);
CREATE FUNCTION auth_get_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, active_tenant_id uuid, name text, email text, is_platform_admin boolean, support_grant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH s AS (
    UPDATE sessions SET last_seen_at = now()
     WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now()
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id AND NOT u.disabled)
    RETURNING sessions.id, sessions.user_id, sessions.active_tenant_id, sessions.support_grant_id)
  SELECT s.id, s.user_id,
         CASE WHEN s.support_grant_id IS NULL OR support_grant_valid(s.support_grant_id, s.user_id, s.active_tenant_id)
              THEN s.active_tenant_id END,
         u.name, u.email,
         EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = s.user_id),
         CASE WHEN s.support_grant_id IS NOT NULL AND support_grant_valid(s.support_grant_id, s.user_id, s.active_tenant_id)
              THEN s.support_grant_id END
    FROM s JOIN users u ON u.id = s.user_id;
END $$;
REVOKE ALL ON FUNCTION auth_get_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_get_session(text) TO app_runtime;

-- Normal shop switch (membership) always leaves support mode.
CREATE OR REPLACE FUNCTION auth_set_tenant(p_token_hash text, p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM sessions WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now();
  IF v_user IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.user_id', v_user::text, true);
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = v_user AND active) THEN RETURN false; END IF;
  UPDATE sessions SET active_tenant_id = p_tenant, support_grant_id = NULL WHERE token_hash = p_token_hash;
  RETURN true;
END $$;

-- Enter / leave a shop under a grant (platform admin's own session only).
CREATE FUNCTION auth_enter_support(p_token_hash text, p_tenant uuid, p_grant uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM sessions WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now();
  IF v_user IS NULL OR NOT support_grant_valid(p_grant, v_user, p_tenant) THEN RETURN false; END IF;
  UPDATE sessions SET active_tenant_id = p_tenant, support_grant_id = p_grant WHERE token_hash = p_token_hash;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  INSERT INTO audit_log (tenant_id, actor_id, action, ref_type, ref_id, meta)
    VALUES (p_tenant, v_user, 'support.entered', 'support_grant', p_grant, '{}'::jsonb);
  PERFORM set_config('app.tenant_id', '', true);
  RETURN true;
END $$;
CREATE FUNCTION auth_leave_support(p_token_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE sessions SET active_tenant_id = NULL, support_grant_id = NULL
   WHERE token_hash = p_token_hash AND support_grant_id IS NOT NULL $$;
REVOKE ALL ON FUNCTION auth_enter_support(text,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_leave_support(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_enter_support(text,uuid,uuid), auth_leave_support(text) TO app_runtime;

-- Platform side: ask for access (writes into the shop's table without any standing read access to it).
CREATE FUNCTION platform_request_support(p_actor uuid, p_tenant uuid, p_reason text, p_minutes int, p_scope text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id=p_actor) THEN RAISE EXCEPTION 'platform administrators only' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id=p_tenant) THEN RETURN NULL; END IF;
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  IF EXISTS (SELECT 1 FROM support_grants WHERE tenant_id=p_tenant AND requested_by=p_actor AND status='requested') THEN
    RAISE EXCEPTION 'a request is already waiting for the owner' USING ERRCODE='23505';
  END IF;
  INSERT INTO support_grants (tenant_id, requested_by, reason, minutes, scope) VALUES (p_tenant, p_actor, p_reason, p_minutes, p_scope) RETURNING id INTO v_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, ref_type, ref_id, meta)
    VALUES (p_tenant, p_actor, 'support.requested', 'support_grant', v_id, jsonb_build_object('scope',p_scope,'minutes',p_minutes,'reason',p_reason));
  INSERT INTO platform_audit (actor_user_id, action, meta)
    VALUES (p_actor, 'support.requested', jsonb_build_object('tenantId',p_tenant,'grantId',v_id,'scope',p_scope,'minutes',p_minutes));
  PERFORM set_config('app.tenant_id', '', true);
  RETURN v_id;
END $$;
-- Platform side: the requester's own requests for one shop (status only, no business data).
CREATE FUNCTION platform_my_support(p_actor uuid, p_tenant uuid)
RETURNS TABLE (id uuid, status text, scope text, minutes int, reason text, created_at timestamptz, expires_at timestamptz, usable boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  RETURN QUERY SELECT g.id, g.status, g.scope, g.minutes, g.reason, g.created_at, g.expires_at,
      support_grant_valid(g.id, p_actor, p_tenant)
    FROM support_grants g WHERE g.tenant_id=p_tenant AND g.requested_by=p_actor ORDER BY g.created_at DESC LIMIT 20;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
REVOKE ALL ON FUNCTION platform_request_support(uuid,uuid,text,int,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_my_support(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_request_support(uuid,uuid,text,int,text), platform_my_support(uuid,uuid) TO app_platform;

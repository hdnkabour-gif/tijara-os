-- Authentication, sessions, password reset, platform admins.
-- Design: the runtime role can NOT read password hashes, sessions or reset tokens directly.
-- All credential handling goes through SECURITY DEFINER functions owned by app_owner.

ALTER TABLE users
  ADD COLUMN password_hash text,
  ADD COLUMN failed_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN disabled boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));

-- users: runtime sees only itself and members of the current tenant, and never password_hash.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;           -- not FORCEd: owner-owned definer functions bypass
CREATE POLICY users_visible ON users FOR SELECT TO app_runtime
  USING (id = app_user() OR id IN (SELECT user_id FROM memberships WHERE tenant_id = app_tenant()));
CREATE POLICY users_platform ON users TO app_platform USING (true) WITH CHECK (true);
REVOKE SELECT ON users FROM app_runtime;
GRANT SELECT (id, email, name, created_at, disabled) ON users TO app_runtime;
REVOKE SELECT ON users FROM app_platform;
GRANT SELECT (id, email, name, created_at) ON users TO app_platform;
GRANT INSERT (email, name, password_hash) ON users TO app_platform;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  active_tenant_id uuid REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz, ip text, user_agent text
);
CREATE INDEX ix_sessions_user ON sessions (user_id);
CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, used_at timestamptz
);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;         -- no policies: only definer functions (owner) can touch them
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;

CREATE TABLE platform_admins (user_id uuid PRIMARY KEY REFERENCES users(id));
CREATE TABLE platform_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid, action text NOT NULL, meta jsonb, at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT, INSERT ON platform_admins, platform_audit TO app_platform;

-- ───────────── credential functions (SECURITY DEFINER) ─────────────
CREATE FUNCTION auth_get_user(p_email text)
RETURNS TABLE (id uuid, name text, password_hash text, failed_attempts int, locked_until timestamptz, disabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.name, u.password_hash, u.failed_attempts, u.locked_until, u.disabled
    FROM users u WHERE lower(u.email) = lower(p_email) $$;

CREATE FUNCTION auth_register_failure(p_user uuid, p_max int, p_lock_minutes int) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= p_max THEN now() + make_interval(mins => p_lock_minutes) ELSE locked_until END
   WHERE id = p_user $$;

CREATE FUNCTION auth_register_success(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = p_user $$;

CREATE FUNCTION auth_create_session(p_user uuid, p_token_hash text, p_ttl_minutes int, p_ip text, p_ua text, p_tenant uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM set_config('app.user_id', p_user::text, true);
  IF p_tenant IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = p_user AND active) THEN
    RAISE EXCEPTION 'not a member of this tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO sessions (user_id, token_hash, active_tenant_id, expires_at, ip, user_agent)
  VALUES (p_user, p_token_hash, p_tenant, now() + make_interval(mins => p_ttl_minutes), p_ip, left(p_ua, 300))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION auth_get_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, active_tenant_id uuid, name text, email text, is_platform_admin boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH s AS (
    UPDATE sessions SET last_seen_at = now()
     WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now()
       AND EXISTS (SELECT 1 FROM users u WHERE u.id = sessions.user_id AND NOT u.disabled)
    RETURNING sessions.id, sessions.user_id, sessions.active_tenant_id)
  SELECT s.id, s.user_id, s.active_tenant_id, u.name, u.email,
         EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = s.user_id)
    FROM s JOIN users u ON u.id = s.user_id;
END $$;

CREATE FUNCTION auth_revoke_session(p_token_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE sessions SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL $$;

CREATE FUNCTION auth_set_tenant(p_token_hash text, p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM sessions WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now();
  IF v_user IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.user_id', v_user::text, true);
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = v_user AND active) THEN RETURN false; END IF;
  UPDATE sessions SET active_tenant_id = p_tenant WHERE token_hash = p_token_hash;
  RETURN true;
END $$;

CREATE FUNCTION auth_list_tenants(p_user uuid)
RETURNS TABLE (tenant_id uuid, name text, slug text, role_name text, branch_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m record;
BEGIN
  PERFORM set_config('app.user_id', p_user::text, true);
  FOR m IN SELECT mm.tenant_id AS tid, mm.role_id, mm.branch_ids AS bids FROM memberships mm WHERE mm.user_id = p_user AND mm.active LOOP
    PERFORM set_config('app.tenant_id', m.tid::text, true);   -- roles/tenants are tenant-scoped under RLS
    RETURN QUERY SELECT m.tid, t.name, t.slug, r.name, m.bids
                   FROM tenants t JOIN roles r ON r.tenant_id = t.id AND r.id = m.role_id WHERE t.id = m.tid;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

CREATE FUNCTION auth_change_password(p_user uuid, p_new_hash text, p_keep_token_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE users SET password_hash = p_new_hash, failed_attempts = 0, locked_until = NULL WHERE id = p_user;
  UPDATE sessions SET revoked_at = now()
   WHERE user_id = p_user AND revoked_at IS NULL AND token_hash IS DISTINCT FROM p_keep_token_hash;
END $$;

CREATE FUNCTION auth_create_reset(p_email text, p_token_hash text, p_ttl_minutes int) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT id INTO v_user FROM users WHERE lower(email) = lower(p_email) AND NOT disabled;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (v_user, p_token_hash, now() + make_interval(mins => p_ttl_minutes));
  RETURN v_user;
END $$;

CREATE FUNCTION auth_consume_reset(p_token_hash text, p_new_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE password_resets SET used_at = now()
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now() RETURNING user_id INTO v_user;
  IF v_user IS NULL THEN RETURN false; END IF;
  UPDATE users SET password_hash = p_new_hash, failed_attempts = 0, locked_until = NULL WHERE id = v_user;
  UPDATE sessions SET revoked_at = now() WHERE user_id = v_user AND revoked_at IS NULL;
  RETURN true;
END $$;

-- used by tenant administrators (permission checked in the API) to create staff accounts
CREATE FUNCTION auth_create_user(p_email text, p_name text, p_hash text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO users (email, name, password_hash) VALUES (p_email, p_name, p_hash) RETURNING id $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_get_user(text)', 'auth_register_failure(uuid,int,int)', 'auth_register_success(uuid)',
    'auth_create_session(uuid,text,int,text,text,uuid)', 'auth_get_session(text)', 'auth_revoke_session(text)',
    'auth_set_tenant(text,uuid)', 'auth_list_tenants(uuid)', 'auth_change_password(uuid,text,text)',
    'auth_create_reset(text,text,int)', 'auth_consume_reset(text,text)', 'auth_create_user(text,text,text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_runtime', f);
  END LOOP;
END $$;

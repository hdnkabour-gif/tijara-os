-- Admin completeness: archive flags, company settings, controlled user administration.

ALTER TABLE customers ADD COLUMN active boolean NOT NULL DEFAULT true, ADD COLUMN address text, ADD COLUMN notes text;

-- Update the CURRENT tenant's name/company settings (runtime has no direct UPDATE on tenants).
CREATE FUNCTION tenant_update_settings(p_name text, p_company jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_tenant() IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  UPDATE tenants SET name = COALESCE(NULLIF(p_name, ''), name),
                     settings = settings || jsonb_build_object('company', COALESCE(p_company, '{}'::jsonb))
   WHERE id = app_tenant();
END $$;

-- Rename a user who is a member of the CURRENT tenant only.
CREATE FUNCTION auth_set_user_name(p_user uuid, p_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_tenant() IS NULL OR NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = app_tenant() AND user_id = p_user) THEN RETURN false; END IF;
  UPDATE users SET name = p_name WHERE id = p_user;
  RETURN true;
END $$;

-- Administrator-set password for a member of the CURRENT tenant: revokes that user's sessions, clears lockout.
CREATE FUNCTION auth_admin_set_password(p_user uuid, p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_tenant() IS NULL OR NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = app_tenant() AND user_id = p_user) THEN RETURN false; END IF;
  UPDATE users SET password_hash = p_hash, failed_attempts = 0, locked_until = NULL WHERE id = p_user;
  UPDATE sessions SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL;
  RETURN true;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['tenant_update_settings(text,jsonb)','auth_set_user_name(uuid,text)','auth_admin_set_password(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_runtime', f);
  END LOOP;
END $$;

-- Existing owners get the new permission (new tenants get it from the default role template).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);
    INSERT INTO role_permissions (tenant_id, role_id, permission)
      SELECT r.tenant_id, r.id, 'settings.manage' FROM roles r WHERE r.tenant_id = t.id AND r.name = 'owner'
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

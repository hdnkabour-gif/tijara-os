-- Follow-up security hardening for staff administration (PR #6).
-- Shared logins have global credentials: never let one tenant change another tenant's
-- user identity or take over a platform administrator via password reset.

CREATE OR REPLACE FUNCTION auth_admin_set_password(p_user uuid, p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $
DECLARE v_actor uuid; v_memberships int;
BEGIN
  IF app_tenant() IS NULL OR app_user() IS NULL THEN
    RAISE EXCEPTION 'no authenticated tenant context' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m JOIN roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
     WHERE m.tenant_id=app_tenant() AND m.user_id=app_user() AND m.active AND r.name='owner'
  ) THEN
    RAISE EXCEPTION 'only shop owner may reset member passwords' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships WHERE tenant_id=app_tenant() AND user_id=p_user
  ) THEN RETURN false; END IF;
  -- memberships has FORCE RLS. Switch the user GUC temporarily to the TARGET to count
  -- every tenant membership (otherwise other-tenant rows are invisible to the actor).
  v_actor := app_user();
  PERFORM set_config('app.user_id', p_user::text, true);
  SELECT count(*)::int INTO v_memberships FROM memberships WHERE user_id=p_user;
  PERFORM set_config('app.user_id', v_actor::text, true);
  IF p_user=v_actor OR EXISTS (SELECT 1 FROM platform_admins WHERE user_id=p_user)
     OR v_memberships <> 1 THEN
    RAISE EXCEPTION 'cannot reset shared, platform or own login from shop settings' USING ERRCODE = '42501';
  END IF;
  UPDATE users SET password_hash=p_hash, failed_attempts=0, locked_until=NULL WHERE id=p_user;
  UPDATE sessions SET revoked_at=now() WHERE user_id=p_user AND revoked_at IS NULL;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION auth_set_user_name(p_user uuid, p_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $
DECLARE v_actor uuid; v_memberships int;
BEGIN
  IF app_tenant() IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id=app_tenant() AND user_id=p_user) THEN RETURN false; END IF;
  v_actor := app_user();
  PERFORM set_config('app.user_id', p_user::text, true);
  SELECT count(*)::int INTO v_memberships FROM memberships WHERE user_id=p_user;
  PERFORM set_config('app.user_id', COALESCE(v_actor::text, ''), true);
  IF EXISTS (SELECT 1 FROM platform_admins WHERE user_id=p_user)
     OR v_memberships <> 1 THEN
    RAISE EXCEPTION 'cannot rename shared or platform account from shop settings' USING ERRCODE = '42501';
  END IF;
  UPDATE users SET name=p_name WHERE id=p_user;
  RETURN true;
END $$;

-- Deep merge of the company object: PATCH /tenant must not erase omitted fields.
-- Explicit empty-string values still clear their respective fields.
CREATE OR REPLACE FUNCTION tenant_update_settings(p_name text, p_company jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_tenant() IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE='42501'; END IF;
  UPDATE tenants SET
    name=COALESCE(NULLIF(p_name,''),name),
    settings=jsonb_set(COALESCE(settings,'{}'::jsonb), '{company}',
      COALESCE(settings->'company','{}'::jsonb) || COALESCE(p_company,'{}'::jsonb), true)
    WHERE id=app_tenant();
END $$;

REVOKE ALL ON FUNCTION auth_admin_set_password(uuid,text), auth_set_user_name(uuid,text), tenant_update_settings(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_admin_set_password(uuid,text), auth_set_user_name(uuid,text), tenant_update_settings(text,jsonb) TO app_runtime;

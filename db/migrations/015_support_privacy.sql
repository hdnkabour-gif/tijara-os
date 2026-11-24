-- Keep historical memberships intact while preventing platform identities from using them.
CREATE OR REPLACE FUNCTION auth_list_tenants(p_user uuid)
RETURNS TABLE (tenant_id uuid, name text, slug text, role_name text, branch_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m record;
BEGIN
  IF EXISTS (SELECT 1 FROM platform_admins WHERE user_id=p_user) THEN RETURN; END IF;
  PERFORM set_config('app.user_id', p_user::text, true);
  FOR m IN SELECT mm.tenant_id AS tid, mm.role_id, mm.branch_ids AS bids FROM memberships mm WHERE mm.user_id = p_user AND mm.active LOOP
    PERFORM set_config('app.tenant_id', m.tid::text, true);   -- roles/tenants are tenant-scoped under RLS
    RETURN QUERY SELECT m.tid, t.name, t.slug, r.name, m.bids
                   FROM tenants t JOIN roles r ON r.tenant_id = t.id AND r.id = m.role_id WHERE t.id = m.tid;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

CREATE OR REPLACE FUNCTION auth_set_tenant(p_token_hash text, p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  SELECT user_id INTO v_user FROM sessions WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now();
  IF v_user IS NULL OR EXISTS (SELECT 1 FROM platform_admins WHERE user_id=v_user) THEN RETURN false; END IF;
  PERFORM set_config('app.user_id', v_user::text, true);
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = v_user AND active) THEN RETURN false; END IF;
  UPDATE sessions SET active_tenant_id = p_tenant, support_grant_id = NULL WHERE token_hash = p_token_hash;
  RETURN true;
END $$;

-- Grant the platform pool access only to these technical fields on the approved shop.
CREATE FUNCTION platform_support_diagnostics(p_actor uuid, p_tenant uuid, p_grant uuid)
RETURNS TABLE("tenantId" uuid, plan text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous_tenant text := current_setting('app.tenant_id', true);
BEGIN
  IF NOT support_grant_valid(p_grant,p_actor,p_tenant) THEN RETURN; END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  RETURN QUERY SELECT t.id,t.plan_id,t.status FROM tenants t WHERE t.id=p_tenant;
  PERFORM set_config('app.tenant_id',COALESCE(previous_tenant,''),true);
END $$;
REVOKE ALL ON FUNCTION platform_support_diagnostics(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_support_diagnostics(uuid,uuid,uuid) TO app_platform;

-- Owner contact is exposed only through the tenant-scoped administration card.
REVOKE SELECT (email, name, created_at) ON users FROM app_platform;
REVOKE INSERT ON users FROM app_platform;
GRANT INSERT (email, name, password_hash) ON users TO app_platform;
REVOKE INSERT ON platform_admins FROM app_platform;
REVOKE SELECT ON platform_audit FROM app_platform;

-- Project known administrative metadata even when reading entries from older writers.
CREATE OR REPLACE FUNCTION platform_audit_feed(p_tenant uuid, p_limit int)
RETURNS TABLE(at timestamptz, action text, actor_name text, tenant_id uuid, meta jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.at,a.action,u.name,(a.meta->>'tenantId')::uuid,
         jsonb_strip_nulls(jsonb_build_object('tenantId',a.meta->>'tenantId','slug',a.meta->>'slug',
           'plan',a.meta->>'plan','scope',a.meta->>'scope','minutes',a.meta->'minutes','grantId',a.meta->>'grantId',
           'previousPlan',a.meta#>>'{before,plan}','newPlan',a.meta#>>'{after,plan}',
           'previousStatus',a.meta#>>'{before,status}','newStatus',a.meta#>>'{after,status}'))
    FROM platform_audit a LEFT JOIN users u ON u.id=a.actor_user_id
   WHERE p_tenant IS NULL OR a.meta->>'tenantId'=p_tenant::text
   ORDER BY a.at DESC LIMIT LEAST(GREATEST(p_limit,1),500)
$$;

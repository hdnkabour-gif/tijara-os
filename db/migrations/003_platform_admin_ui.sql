-- Shop setup with activities + platform listing, for the platform administrator UI.
CREATE FUNCTION create_tenant(p_name text, p_slug text, p_plan text, p_settings jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.tenant_id', v_id::text, true);
  INSERT INTO tenants (id, name, slug, plan_id, settings) VALUES (v_id, p_name, p_slug, p_plan, COALESCE(p_settings, '{}'));
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION create_tenant(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_tenant(text, text, text, jsonb) TO app_platform;

-- Platform-level overview (names/plan/activities + counts only; never business data).
-- Only roles-owned definer functions can enumerate tenants: the policy targets app_owner, which the runtime never uses.
CREATE POLICY tenants_enumerate_by_owner ON tenants FOR SELECT TO app_owner USING (true);

CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (id uuid, name text, slug text, plan_id text, activities jsonb, created_at timestamptz, users int, items int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tt.id AS tid, tt.name AS tname, tt.slug AS tslug, tt.plan_id AS tplan, tt.settings AS tsettings, tt.created_at AS tcreated
             FROM tenants tt ORDER BY tt.created_at DESC LOOP
    PERFORM set_config('app.tenant_id', t.tid::text, true);        -- counts run under the tenant's own RLS context
    RETURN QUERY SELECT t.tid, t.tname, t.tslug, t.tplan, t.tsettings -> 'activities', t.tcreated,
                        (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.tid AND m.active),
                        (SELECT count(*)::int FROM items i WHERE i.tenant_id = t.tid);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
REVOKE ALL ON FUNCTION platform_list_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO app_platform;

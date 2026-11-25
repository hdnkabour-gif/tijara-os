-- Issue #19: what a shop sees and can call = plan feature (or platform override) ∩ module enabled by the shop
-- ∩ role permission ∩ branch scope. Activity is only the starting default; the owner can switch modules on or off
-- within what the platform allows. Nothing is deleted when a module is switched off (it is only hidden and refused).

-- 1) The order inbox (D1) becomes a module the platform can allow or block like the others; every plan includes it.
UPDATE plans SET features = features || '["orders"]'::jsonb WHERE NOT features ? 'orders';

-- 2) The shop's own module choices (absent row = enabled, so existing shops keep what they had unless step 4 applies).
CREATE TABLE tenant_modules (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  module text NOT NULL CHECK (module IN ('kitchen','production','workshop','purchases','cash','orders','online')),
  enabled boolean NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module)
);
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_modules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_modules_tenant ON tenant_modules USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
GRANT SELECT,INSERT,UPDATE ON tenant_modules TO app_runtime;

-- 3) Default per activity (kept in sync with src/entitlements.ts MODULES; a test compares both).
--    No activity recorded = a general shop that keeps every module (former behaviour).
CREATE FUNCTION module_default_enabled(p_activities jsonb, p_module text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_activities IS NULL OR jsonb_typeof(p_activities)<>'array' OR jsonb_array_length(p_activities)=0 THEN true
    WHEN p_module='kitchen'    THEN p_activities ?| ARRAY['grill','restaurant']
    WHEN p_module='production' THEN p_activities ?| ARRAY['butcher','grill']
    WHEN p_module='workshop'   THEN p_activities ?| ARRAY['mechanic']
    WHEN p_module IN ('orders','online') THEN p_activities ?| ARRAY['butcher','grill','restaurant','grocery']
    ELSE true END $$;

-- 4) Existing shops: apply the activity default ONLY to modules the shop never used (no record of that kind),
--    so a shop that already works with a module keeps it; the owner can switch any of them back on.
CREATE FUNCTION tenant_backfill_module_defaults(p_tenant uuid) RETURNS void
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO tenant_modules (tenant_id, module, enabled)
  SELECT t.id, m.module, false
    FROM tenants t CROSS JOIN (VALUES ('kitchen'),('production'),('workshop'),('orders'),('online')) AS m(module)
   WHERE t.id=p_tenant
     AND NOT module_default_enabled(t.settings->'activities', m.module)
     AND NOT CASE m.module
       WHEN 'kitchen'    THEN EXISTS (SELECT 1 FROM sales_order_lines l WHERE l.tenant_id=t.id AND l.prep_required)
       WHEN 'production' THEN EXISTS (SELECT 1 FROM production_orders p WHERE p.tenant_id=t.id)
       WHEN 'workshop'   THEN EXISTS (SELECT 1 FROM workshop_vehicles v WHERE v.tenant_id=t.id) OR EXISTS (SELECT 1 FROM workshop_orders w WHERE w.tenant_id=t.id)
       WHEN 'orders'     THEN EXISTS (SELECT 1 FROM order_requests r WHERE r.tenant_id=t.id)
       WHEN 'online'     THEN EXISTS (SELECT 1 FROM shop_menu_settings s WHERE s.tenant_id=t.id AND s.published)
     END
  ON CONFLICT DO NOTHING $$;
REVOKE ALL ON FUNCTION tenant_backfill_module_defaults(uuid) FROM PUBLIC;
-- runs as the migration owner, one shop at a time inside its own tenant context (RLS stays on)
DO $$ DECLARE t uuid; BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM tenant_backfill_module_defaults(t);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

-- 5) Platform controls: 'orders' can be allowed/blocked per shop; a TRIAL shop cannot be given modules beyond its plan
--    (paid plans may receive add-ons). Same function as 015 otherwise.
CREATE OR REPLACE FUNCTION platform_set_tenant_controls(
  p_actor uuid,p_tenant uuid,p_plan text,p_status text,p_reason text,p_limits jsonb,p_features jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_key text; v_int int;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM platform_admins WHERE user_id=p_actor)
    THEN RAISE EXCEPTION 'platform admin required' USING ERRCODE='42501'; END IF;
  IF p_plan IS NOT NULL AND NOT EXISTS(SELECT 1 FROM plans WHERE id=p_plan AND id<>'tiny')
    THEN RAISE EXCEPTION 'unknown plan' USING ERRCODE='22023'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('active','suspended')
    THEN RAISE EXCEPTION 'invalid tenant status' USING ERRCODE='22023'; END IF;
  IF p_status='suspended' AND NULLIF(trim(p_reason),'') IS NULL
    THEN RAISE EXCEPTION 'suspension reason required' USING ERRCODE='22023'; END IF;
  IF p_limits IS NOT NULL AND jsonb_typeof(p_limits)<>'object'
    THEN RAISE EXCEPTION 'limits must be an object' USING ERRCODE='22023'; END IF;
  IF p_features IS NOT NULL AND jsonb_typeof(p_features)<>'object'
    THEN RAISE EXCEPTION 'features must be an object' USING ERRCODE='22023'; END IF;
  IF p_features IS NOT NULL THEN
    FOR v_key IN SELECT jsonb_object_keys(p_features) LOOP
      IF v_key NOT IN ('kitchen','workshop','purchases','cash','production','bookings','delivery','online','orders')
        THEN RAISE EXCEPTION 'unsupported feature %',v_key USING ERRCODE='22023'; END IF;
      IF jsonb_typeof(p_features->v_key)<>'boolean'
        THEN RAISE EXCEPTION 'feature must be boolean' USING ERRCODE='22023'; END IF;
    END LOOP;
  END IF;
  IF p_limits IS NOT NULL THEN
    FOR v_key IN SELECT jsonb_object_keys(p_limits) LOOP
      IF v_key NOT IN ('max_users','max_items','max_branches','max_customers','max_monthly_orders') THEN
        RAISE EXCEPTION 'unsupported limit %',v_key USING ERRCODE='22023'; END IF;
      IF p_limits->v_key <> 'null'::jsonb THEN
        IF (p_limits->>v_key) !~ '^[0-9]{1,8}$' THEN
          RAISE EXCEPTION 'limit % must be positive integer',v_key USING ERRCODE='22023'; END IF;
        v_int := (p_limits->>v_key)::int;
        IF v_int<1 OR v_int>10000000 THEN
          RAISE EXCEPTION 'limit out of range' USING ERRCODE='22023'; END IF;
      END IF;
    END LOOP;
  END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  SELECT jsonb_build_object('plan',t.plan_id,'status',t.status,'reason',t.status_reason,'trialEnd',t.trial_expires_at,'limits',to_jsonb(q))
    INTO v_before FROM tenants t LEFT JOIN tenant_quotas q ON q.tenant_id=t.id WHERE t.id=p_tenant FOR UPDATE OF t;
  IF v_before IS NULL THEN RETURN false; END IF;
  UPDATE tenants
    SET plan_id=COALESCE(p_plan,plan_id),
        status=COALESCE(p_status,status),
        status_reason=CASE WHEN p_status='active' THEN NULL
                          WHEN p_status='suspended' THEN left(p_reason,300)
                          ELSE status_reason END,
        status_changed_at=CASE WHEN p_status IS NULL THEN status_changed_at ELSE now() END
   WHERE id=p_tenant;
  IF (p_limits IS NOT NULL AND p_limits<>'{}'::jsonb) OR p_features IS NOT NULL THEN
    INSERT INTO tenant_quotas (tenant_id) VALUES (p_tenant) ON CONFLICT DO NOTHING;
    UPDATE tenant_quotas SET
      max_users=CASE WHEN p_limits ? 'max_users' THEN (p_limits->>'max_users')::int ELSE max_users END,
      max_items=CASE WHEN p_limits ? 'max_items' THEN (p_limits->>'max_items')::int ELSE max_items END,
      max_branches=CASE WHEN p_limits ? 'max_branches' THEN (p_limits->>'max_branches')::int ELSE max_branches END,
      max_customers=CASE WHEN p_limits ? 'max_customers' THEN (p_limits->>'max_customers')::int ELSE max_customers END,
      max_monthly_orders=CASE WHEN p_limits ? 'max_monthly_orders' THEN (p_limits->>'max_monthly_orders')::int ELSE max_monthly_orders END,
      feature_overrides=COALESCE(p_features,feature_overrides)
      WHERE tenant_id=p_tenant;
  END IF;
  -- a trial cannot carry a module its plan does not include (checked on the final state; the whole call is undone)
  IF EXISTS (SELECT 1 FROM tenants t JOIN plans p ON p.id=t.plan_id JOIN tenant_quotas q ON q.tenant_id=t.id,
                    jsonb_each(q.feature_overrides) f
              WHERE t.id=p_tenant AND t.plan_id='trial' AND f.value='true'::jsonb AND NOT p.features ? f.key)
    THEN RAISE EXCEPTION 'a trial shop cannot receive modules outside its plan' USING ERRCODE='TJ403'; END IF;
  SELECT jsonb_build_object('plan',t.plan_id,'status',t.status,'reason',t.status_reason,'trialEnd',t.trial_expires_at,'limits',to_jsonb(q))
    INTO v_after FROM tenants t LEFT JOIN tenant_quotas q ON q.tenant_id=t.id WHERE t.id=p_tenant;
  INSERT INTO platform_audit(actor_user_id,action,meta)
    VALUES(p_actor,'tenant.controls_changed',jsonb_build_object('tenantId',p_tenant,'before',v_before,'after',v_after));
  RETURN true;
END $$;

-- 6) New shops get the activity default written at creation (called by the runtime inside the new shop's context).
CREATE FUNCTION tenant_apply_module_defaults(p_tenant uuid) RETURNS void
LANGUAGE sql SECURITY INVOKER AS $$
  INSERT INTO tenant_modules (tenant_id, module, enabled)
  SELECT t.id, m.module, module_default_enabled(t.settings->'activities', m.module)
    FROM tenants t CROSS JOIN (VALUES ('kitchen'),('production'),('workshop'),('purchases'),('cash'),('orders'),('online')) AS m(module)
   WHERE t.id=p_tenant
  ON CONFLICT DO NOTHING $$;
GRANT EXECUTE ON FUNCTION tenant_apply_module_defaults(uuid), module_default_enabled(jsonb,text) TO app_runtime;

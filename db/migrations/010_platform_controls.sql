-- Platform controls: reversible tenant suspension, subscription tiers, hard per-shop quotas.
-- No customer, invoice, order, stock or membership record is removed by any operation here.
ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK(status IN ('active','suspended'));
ALTER TABLE tenants ADD COLUMN status_reason text;
ALTER TABLE tenants ADD COLUMN status_changed_at timestamptz;

ALTER TABLE plans
  ADD COLUMN max_branches int NOT NULL DEFAULT 2,
  ADD COLUMN max_customers int NOT NULL DEFAULT 1000,
  ADD COLUMN max_monthly_orders int NOT NULL DEFAULT 10000,
  ADD COLUMN features jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE plans SET
  name=CASE id WHEN 'basic' THEN 'Standard' WHEN 'pro' THEN 'Professional' ELSE name END,
  max_branches=CASE id WHEN 'tiny' THEN 1 WHEN 'basic' THEN 2 ELSE 10 END,
  max_customers=CASE id WHEN 'tiny' THEN 20 WHEN 'basic' THEN 500 ELSE 5000 END,
  max_monthly_orders=CASE id WHEN 'tiny' THEN 100 WHEN 'basic' THEN 1000 ELSE 20000 END,
  features=CASE id
    WHEN 'tiny' THEN '["core","kitchen","workshop","purchases","cash","production","bookings","delivery"]'::jsonb
    WHEN 'basic' THEN '["core","kitchen","workshop","purchases","cash","production"]'::jsonb
    ELSE '["core","kitchen","workshop","purchases","cash","production","bookings","delivery"]'::jsonb END;
INSERT INTO plans (id,name,max_users,max_items,max_branches,max_customers,max_monthly_orders,features)
VALUES
 ('trial','Trial',2,50,1,100,200,'["core","kitchen","cash"]'::jsonb),
 ('complete','Complete',50,10000,25,50000,200000,'["core","kitchen","workshop","purchases","cash","production","bookings","delivery"]'::jsonb)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE tenant_quotas (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  max_users int CHECK (max_users BETWEEN 1 AND 10000),
  max_items int CHECK (max_items BETWEEN 1 AND 1000000),
  max_branches int CHECK (max_branches BETWEEN 1 AND 1000),
  max_customers int CHECK (max_customers BETWEEN 1 AND 1000000),
  max_monthly_orders int CHECK (max_monthly_orders BETWEEN 1 AND 10000000)
);
ALTER TABLE tenant_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_quotas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_quotas_isolation ON tenant_quotas
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
-- The migration-owned platform listing function runs as app_owner, never as app_runtime.
CREATE POLICY tenant_quotas_platform_read ON tenant_quotas FOR SELECT TO app_owner USING (true);
GRANT SELECT ON tenant_quotas TO app_runtime;

-- Common advisory lock serializes concurrent creations for the same tenant & quota type.
CREATE OR REPLACE FUNCTION enforce_tenant_quota() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_max int; v_count bigint; v_col text; v_table text; v_month_start timestamptz;
BEGIN
  IF TG_TABLE_NAME='memberships' THEN
    IF NEW.active IS NOT TRUE OR (TG_OP='UPDATE' AND OLD.active IS TRUE) THEN RETURN NEW; END IF;
    v_col:='max_users'; v_table:='memberships';
  ELSIF TG_TABLE_NAME='items' THEN v_col:='max_items'; v_table:='items';
  ELSIF TG_TABLE_NAME='branches' THEN v_col:='max_branches'; v_table:='branches';
  ELSIF TG_TABLE_NAME='customers' THEN v_col:='max_customers'; v_table:='customers';
  ELSIF TG_TABLE_NAME='sales_orders' THEN v_col:='max_monthly_orders'; v_table:='sales_orders';
  ELSE RAISE EXCEPTION 'unexpected quota table' USING ERRCODE='P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||v_col,14592));
  SELECT COALESCE(
    CASE v_col WHEN 'max_users' THEN q.max_users WHEN 'max_items' THEN q.max_items
      WHEN 'max_branches' THEN q.max_branches WHEN 'max_customers' THEN q.max_customers
      ELSE q.max_monthly_orders END,
    CASE v_col WHEN 'max_users' THEN p.max_users WHEN 'max_items' THEN p.max_items
      WHEN 'max_branches' THEN p.max_branches WHEN 'max_customers' THEN p.max_customers
      ELSE p.max_monthly_orders END)
  INTO v_max
    FROM tenants t JOIN plans p ON p.id=t.plan_id LEFT JOIN tenant_quotas q ON q.tenant_id=t.id
   WHERE t.id=NEW.tenant_id;
  IF v_max IS NULL THEN RAISE EXCEPTION 'plan quota unavailable' USING ERRCODE='P0001'; END IF;
  -- Read under the target shop context. Also works with FORCE RLS for tenant-scoped tables.
  PERFORM set_config('app.tenant_id',NEW.tenant_id::text,true);
  IF v_col='max_users' THEN
    SELECT count(*) INTO v_count FROM memberships WHERE tenant_id=NEW.tenant_id AND active;
  ELSIF v_col='max_monthly_orders' THEN
    v_month_start:=date_trunc('month',now());
    SELECT count(*) INTO v_count FROM sales_orders
      WHERE tenant_id=NEW.tenant_id AND created_at>=v_month_start
      AND created_at<v_month_start+interval '1 month';
  ELSE
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id=$1',v_table)
      INTO v_count USING NEW.tenant_id;
  END IF;
  IF v_count >= v_max THEN
    RAISE EXCEPTION 'plan quota % reached (%)',v_col,v_max USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER trg_user_quota ON memberships;
DROP TRIGGER trg_item_quota ON items;
CREATE TRIGGER trg_user_quota BEFORE INSERT OR UPDATE OF active ON memberships
  FOR EACH ROW EXECUTE FUNCTION enforce_tenant_quota();
CREATE TRIGGER trg_item_quota BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION enforce_tenant_quota();
CREATE TRIGGER trg_branch_quota BEFORE INSERT ON branches FOR EACH ROW EXECUTE FUNCTION enforce_tenant_quota();
CREATE TRIGGER trg_customer_quota BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION enforce_tenant_quota();
CREATE TRIGGER trg_order_quota BEFORE INSERT ON sales_orders FOR EACH ROW EXECUTE FUNCTION enforce_tenant_quota();

-- Administrative setter: callable only by app_platform; SQL checks operator against platform_admins.
-- Changes status and quotas without deleting or rewriting commercial rows.
CREATE FUNCTION platform_set_tenant_controls(
  p_actor uuid,p_tenant uuid,p_plan text,p_status text,p_reason text,p_limits jsonb) RETURNS boolean
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
  SELECT jsonb_build_object('plan',t.plan_id,'status',t.status,'reason',t.status_reason,'limits',to_jsonb(q))
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
  IF p_limits IS NOT NULL AND p_limits<>'{}'::jsonb THEN
    INSERT INTO tenant_quotas (tenant_id) VALUES (p_tenant) ON CONFLICT DO NOTHING;
    UPDATE tenant_quotas SET
      max_users=CASE WHEN p_limits ? 'max_users' THEN (p_limits->>'max_users')::int ELSE max_users END,
      max_items=CASE WHEN p_limits ? 'max_items' THEN (p_limits->>'max_items')::int ELSE max_items END,
      max_branches=CASE WHEN p_limits ? 'max_branches' THEN (p_limits->>'max_branches')::int ELSE max_branches END,
      max_customers=CASE WHEN p_limits ? 'max_customers' THEN (p_limits->>'max_customers')::int ELSE max_customers END,
      max_monthly_orders=CASE WHEN p_limits ? 'max_monthly_orders' THEN (p_limits->>'max_monthly_orders')::int ELSE max_monthly_orders END
      WHERE tenant_id=p_tenant;
  END IF;
  SELECT jsonb_build_object('plan',t.plan_id,'status',t.status,'reason',t.status_reason,'limits',to_jsonb(q))
    INTO v_after FROM tenants t LEFT JOIN tenant_quotas q ON q.tenant_id=t.id WHERE t.id=p_tenant;
  INSERT INTO platform_audit(actor_user_id,action,meta)
    VALUES(p_actor,'tenant.controls_changed',jsonb_build_object('tenantId',p_tenant,'before',v_before,'after',v_after));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION platform_set_tenant_controls(uuid,uuid,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_set_tenant_controls(uuid,uuid,text,text,text,jsonb) TO app_platform;

CREATE FUNCTION platform_list_tenant_controls()
RETURNS TABLE(id uuid,name text,slug text,plan_id text,activities jsonb,status text,status_reason text,
  max_users int,max_items int,max_branches int,max_customers int,max_monthly_orders int,
  overrides jsonb,features jsonb,users int,items int,branches int,customers int,monthly_orders int,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT t.id tid,t.name tname,t.slug tslug,t.plan_id tplan,t.status tstatus,t.status_reason treason,
           t.created_at tcreated,t.settings->'activities' tactivities,p.features tfeatures,
           COALESCE(q.max_users,p.max_users) ulimit,COALESCE(q.max_items,p.max_items) ilimit,
           COALESCE(q.max_branches,p.max_branches) blimit,COALESCE(q.max_customers,p.max_customers) climit,
           COALESCE(q.max_monthly_orders,p.max_monthly_orders) olimit,to_jsonb(q) qos
      FROM tenants t JOIN plans p ON p.id=t.plan_id LEFT JOIN tenant_quotas q ON q.tenant_id=t.id
      ORDER BY t.created_at DESC
  LOOP
    PERFORM set_config('app.tenant_id',r.tid::text,true);
    RETURN QUERY SELECT r.tid,r.tname,r.tslug,r.tplan,r.tactivities,r.tstatus,r.treason,
        r.ulimit,r.ilimit,r.blimit,r.climit,r.olimit,
        COALESCE(r.qos,'{}'::jsonb),r.tfeatures,
        (SELECT count(*)::int FROM memberships m WHERE m.tenant_id=r.tid AND m.active),
        (SELECT count(*)::int FROM items i WHERE i.tenant_id=r.tid),
        (SELECT count(*)::int FROM branches b WHERE b.tenant_id=r.tid),
        (SELECT count(*)::int FROM customers c WHERE c.tenant_id=r.tid),
        (SELECT count(*)::int FROM sales_orders o WHERE o.tenant_id=r.tid AND o.created_at>=date_trunc('month',now())),
        r.tcreated;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $$;
REVOKE ALL ON FUNCTION platform_list_tenant_controls() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_list_tenant_controls() TO app_platform;

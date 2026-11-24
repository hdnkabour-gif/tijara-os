-- Phase D2: public menu (QR / link, no customer account), dish cards with media, online orders into the D1 inbox,
-- private tracking links. Media FILES live outside PostgreSQL (persistent media storage); the database keeps metadata.

-- 1) The shop's public menu settings (one row per shop). Nothing is public until the owner publishes.
CREATE TABLE shop_menu_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  published boolean NOT NULL DEFAULT false,            -- the menu page is visible
  accepting_orders boolean NOT NULL DEFAULT false,     -- online orders can be sent (independent of the cashier)
  pickup_enabled boolean NOT NULL DEFAULT true,
  dine_in_enabled boolean NOT NULL DEFAULT false,
  branch_id uuid,                                      -- the branch that receives online orders
  prep_minutes int NOT NULL DEFAULT 30 CHECK (prep_minutes BETWEEN 0 AND 1440),
  slot_minutes int NOT NULL DEFAULT 15 CHECK (slot_minutes IN (10,15,20,30,60)),
  slot_capacity int NOT NULL DEFAULT 5 CHECK (slot_capacity BETWEEN 1 AND 200),   -- orders per time slot
  days_ahead int NOT NULL DEFAULT 2 CHECK (days_ahead BETWEEN 0 AND 14),
  hours jsonb NOT NULL DEFAULT '{}'::jsonb,             -- {"1":[["11:00","15:00"],["18:00","23:00"]], ...} 0=Sunday, local time
  message text CHECK (length(message) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id)
);

-- 2) Dish card: what the customer reads (all optional, owner-written; never invented).
CREATE TABLE item_menu (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  item_id uuid NOT NULL,
  category text CHECK (length(category) <= 60),
  description text CHECK (length(description) <= 600),
  ingredients text CHECK (length(ingredients) <= 400),
  allergens text[] NOT NULL DEFAULT '{}',
  weight_label text CHECK (length(weight_label) <= 40),          -- e.g. "≈ 350 g"
  serves int CHECK (serves BETWEEN 1 AND 50),
  prep_minutes int CHECK (prep_minutes BETWEEN 0 AND 600),
  sold_out boolean NOT NULL DEFAULT false,                       -- manual "épuisé aujourd'hui"
  position int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id,item_id),
  FOREIGN KEY (tenant_id,item_id) REFERENCES items(tenant_id,id)
);

-- 3) Media metadata (files are in the media store under an unguessable key).
CREATE TABLE item_media (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image','video')),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp','video/mp4','video/webm')),
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[a-f0-9]{48}$'),
  thumb_key text UNIQUE CHECK (thumb_key ~ '^[a-f0-9]{48}$'),
  bytes int NOT NULL CHECK (bytes > 0),
  width int, height int,
  duration_ms int,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  alt text CHECK (length(alt) <= 120),
  position int NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,item_id) REFERENCES items(tenant_id,id)
);
CREATE INDEX item_media_item ON item_media (tenant_id,item_id,position);

-- 4) "Compose your plate": a choice can add a FIXED quantity of a product (e.g. 0.25 kg of kefta per portion).
ALTER TABLE item_option_choices DROP CONSTRAINT item_option_choices_qty_mode_check;
ALTER TABLE item_option_choices ADD CONSTRAINT item_option_choices_qty_mode_check CHECK (qty_mode IN ('same','one','fixed')),
  ADD COLUMN add_qty numeric(14,4) CHECK (add_qty > 0),
  ADD CONSTRAINT item_option_choices_fixed_qty CHECK (qty_mode <> 'fixed' OR add_qty IS NOT NULL);

-- 5) Online orders: a private tracking token (only its SHA-256 is stored) and the customer's consent to be contacted.
ALTER TABLE order_requests
  ADD COLUMN tracking_hash text UNIQUE CHECK (tracking_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN contact_consent boolean NOT NULL DEFAULT false;
CREATE INDEX order_requests_slot ON order_requests (tenant_id, wanted_at) WHERE status IN ('pending','accepted');

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_menu_settings','item_menu','item_media'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant())', t||'_tenant', t);
  END LOOP;
END $rls$;
GRANT SELECT,INSERT,UPDATE ON shop_menu_settings, item_menu TO app_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON item_media TO app_runtime;

-- 6) Public lookup of a shop by its slug: only the id, and only when the menu is published and the shop is usable.
--    (tenants are not readable without a tenant context; this exposes nothing else.)
CREATE FUNCTION public_shop_by_slug(p_slug text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v uuid;
BEGIN
  SELECT t.id INTO v FROM tenants t
   WHERE t.slug = p_slug AND t.status = 'active' AND NOT (t.plan_id = 'trial' AND t.trial_expires_at IS NOT NULL AND t.trial_expires_at <= now());
  IF v IS NULL THEN RETURN NULL; END IF;
  PERFORM set_config('app.tenant_id', v::text, true);
  IF NOT EXISTS (SELECT 1 FROM shop_menu_settings s WHERE s.tenant_id = v AND s.published) THEN v := NULL; END IF;
  PERFORM set_config('app.tenant_id', '', true);
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public_shop_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_shop_by_slug(text) TO app_runtime;

-- 7) Private tracking: the token is <shop id (16 bytes)><24 random bytes>, base64url; only its SHA-256 is stored and the
--    lookup runs inside that shop's own RLS context (no cross-shop search function).

-- 8) A plan feature for online orders (the platform can enable/disable it per shop like the other modules).
UPDATE plans SET features = features || '["online"]'::jsonb WHERE id IN ('basic','pro','complete','tiny') AND NOT features ? 'online';

-- the platform can switch the new module on/off per shop (same function as 010, one more allowed key)
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
      IF v_key NOT IN ('kitchen','workshop','purchases','cash','production','bookings','delivery','online')
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
  SELECT jsonb_build_object('plan',t.plan_id,'status',t.status,'reason',t.status_reason,'trialEnd',t.trial_expires_at,'limits',to_jsonb(q))
    INTO v_after FROM tenants t LEFT JOIN tenant_quotas q ON q.tenant_id=t.id WHERE t.id=p_tenant;
  INSERT INTO platform_audit(actor_user_id,action,meta)
    VALUES(p_actor,'tenant.controls_changed',jsonb_build_object('tenantId',p_tenant,'before',v_before,'after',v_after));
  RETURN true;
END $$;

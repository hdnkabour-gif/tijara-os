-- Tijara OS prototype schema (design v0.2). Applied as role app_owner.
-- Runtime connects as app_runtime (NOSUPERUSER, NOBYPASSRLS, not table owner).

CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ───────────── GLOBAL tables (no tenant_id) ─────────────
CREATE TABLE plans (
  id text PRIMARY KEY, name text NOT NULL,
  max_users int NOT NULL, max_items int NOT NULL
);
INSERT INTO plans VALUES ('basic','Basic',3,100),('pro','Pro',10,1000),('tiny','Tiny (tests)',2,6);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Tenancy ─────────────
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, slug text NOT NULL UNIQUE,
  plan_id text NOT NULL REFERENCES plans(id),
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, name)
);
CREATE TABLE role_permissions (
  tenant_id uuid NOT NULL, role_id uuid NOT NULL, permission text NOT NULL,
  PRIMARY KEY (tenant_id, role_id, permission),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id)
);
CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL,
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id)
);

-- ───────────── Catalog ─────────────
CREATE TABLE cost_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE cost_policy_versions (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL, version int NOT NULL,
  selection_rule text NOT NULL CHECK (selection_rule IN ('fefo','fifo')),
  valuation_method text NOT NULL CHECK (valuation_method IN ('weighted_average','batch_actual')),
  allocation_method text NOT NULL CHECK (allocation_method IN ('by_weight','by_relative_value')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, policy_id, version),
  FOREIGN KEY (tenant_id, policy_id) REFERENCES cost_policies(tenant_id, id)
);

CREATE TABLE items (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sku text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('goods','service','composite')),
  track_quantity boolean NOT NULL,
  batch_tracking text NOT NULL DEFAULT 'none' CHECK (batch_tracking IN ('none','optional','required')),
  serial_tracking boolean NOT NULL DEFAULT false,
  fulfillment text NOT NULL CHECK (fulfillment IN ('stock','backflush','none')),
  base_uom text NOT NULL DEFAULT 'unit',
  price numeric(14,4) NOT NULL DEFAULT 0,
  cost_policy_id uuid,
  active boolean NOT NULL DEFAULT true,
  attributes jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, sku),
  FOREIGN KEY (tenant_id, cost_policy_id) REFERENCES cost_policies(tenant_id, id),
  CONSTRAINT chk_service CHECK (kind <> 'service' OR (NOT track_quantity AND fulfillment = 'none')),
  CONSTRAINT chk_stock CHECK (fulfillment <> 'stock' OR track_quantity),
  CONSTRAINT chk_backflush CHECK (fulfillment <> 'backflush' OR (NOT track_quantity)),
  CONSTRAINT chk_none CHECK (fulfillment <> 'none' OR NOT track_quantity),
  CONSTRAINT chk_serial CHECK (NOT serial_tracking OR track_quantity)
);

CREATE TABLE recipe_versions (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL, version int NOT NULL,
  expected_waste_pct numeric(6,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, item_id, version),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE TABLE recipe_lines (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  recipe_version_id uuid NOT NULL, component_item_id uuid NOT NULL,
  qty_per_unit numeric(14,4) NOT NULL CHECK (qty_per_unit > 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, recipe_version_id) REFERENCES recipe_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, component_item_id) REFERENCES items(tenant_id, id)
);

CREATE TABLE batches (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL, batch_no text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz, unit_cost numeric(14,4) NOT NULL DEFAULT 0, supplier text,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, item_id, batch_no),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE TABLE serials (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL, serial_no text NOT NULL,
  status text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock','reserved','sold','returned')),
  warranty_until date,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, item_id, serial_no),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);

CREATE TABLE customers (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL, phone text, credit_limit numeric(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);

-- ───────────── Commands (idempotency at business-command level) ─────────────
CREATE TABLE business_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL, command_type text NOT NULL, request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','succeeded','failed')),
  result jsonb, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, idempotency_key)
);

-- ───────────── Inventory ─────────────
CREATE TABLE stock_balances (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL, item_id uuid NOT NULL, batch_id uuid,
  stock_status text NOT NULL DEFAULT 'sellable' CHECK (stock_status IN ('sellable','damaged','quarantine')),
  on_hand numeric(14,4) NOT NULL DEFAULT 0,
  reserved numeric(14,4) NOT NULL DEFAULT 0,
  avg_cost numeric(14,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches(tenant_id, id),
  CONSTRAINT chk_on_hand CHECK (on_hand >= 0),
  CONSTRAINT chk_reserved CHECK (reserved >= 0 AND reserved <= on_hand)
);
CREATE UNIQUE INDEX uq_balance_key ON stock_balances
  (tenant_id, branch_id, item_id, COALESCE(batch_id, '00000000-0000-0000-0000-000000000000'::uuid), stock_status);

CREATE TABLE stock_movements (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL, item_id uuid NOT NULL, batch_id uuid, serial_id uuid,
  stock_status text NOT NULL DEFAULT 'sellable',
  qty_delta numeric(14,4) NOT NULL CHECK (qty_delta <> 0),
  unit_cost numeric(14,4) NOT NULL DEFAULT 0,
  movement_type text NOT NULL CHECK (movement_type IN
    ('receipt','sale','production_consume','production_output','backflush_consume',
     'transfer_out','transfer_in','adjustment','waste','return_in','return_out','reversal','status_change')),
  command_id uuid NOT NULL, command_seq int NOT NULL,
  source_doc_type text, source_doc_id uuid, reverses_movement_id uuid, reason_code text,
  cost_policy_version_id uuid, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, command_id, command_seq),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches(tenant_id, id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES business_commands(tenant_id, id)
);
CREATE INDEX ix_mov_source ON stock_movements (tenant_id, source_doc_id);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = '42501'; END $$;
CREATE TRIGGER trg_ledger_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────── Sales ─────────────
CREATE TABLE sales_orders (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL, customer_id uuid,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN
    ('draft','confirmed','in_preparation','ready','closed','cancelled')),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);
CREATE TABLE sales_order_lines (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL, line_no int NOT NULL, item_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN
    ('draft','reserved','weighed','committed','void','returned')),
  fulfillment text NOT NULL,
  ordered_qty numeric(14,4) NOT NULL CHECK (ordered_qty > 0),
  actual_qty numeric(14,4),
  unit_price numeric(14,4) NOT NULL,
  line_total numeric(14,2) NOT NULL DEFAULT 0,
  prep_required boolean NOT NULL DEFAULT false,
  prep_started boolean NOT NULL DEFAULT false,
  serial_no text,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id)
);
CREATE TABLE order_events (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL, from_state text, to_state text NOT NULL,
  actor_id uuid, note text, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders(tenant_id, id)
);

CREATE TABLE stock_reservations (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_line_id uuid NOT NULL, branch_id uuid NOT NULL, item_id uuid NOT NULL, batch_id uuid,
  qty numeric(14,4) NOT NULL CHECK (qty > 0), serial_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_line_id) REFERENCES sales_order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES batches(tenant_id, id)
);

CREATE TABLE invoice_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id), series text NOT NULL DEFAULT 'A',
  last_no int NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, series)
);
CREATE TABLE invoices (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL, invoice_no text NOT NULL, customer_id uuid,
  total numeric(14,2) NOT NULL, status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, invoice_no), UNIQUE (tenant_id, order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES sales_orders(tenant_id, id)
);
CREATE TABLE payments (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  method text NOT NULL CHECK (method IN ('cash','card','transfer')),
  amount numeric(14,2) NOT NULL CHECK (amount <> 0),
  customer_id uuid, command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES business_commands(tenant_id, id)
);
CREATE TABLE payment_allocations (
  tenant_id uuid NOT NULL, payment_id uuid NOT NULL, invoice_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL,
  PRIMARY KEY (tenant_id, payment_id, invoice_id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);
CREATE TABLE receivable_entries (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL, invoice_id uuid, payment_id uuid,
  kind text NOT NULL CHECK (kind IN ('charge','payment','adjustment')),
  amount numeric(14,2) NOT NULL,           -- + = customer owes more
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

-- ───────────── Production ─────────────
CREATE TABLE production_orders (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL, type text NOT NULL CHECK (type IN ('transform','prepare')),
  command_id uuid NOT NULL, recipe_version_id uuid, cost_policy_version_id uuid,
  allocation_method text NOT NULL, total_input_cost numeric(14,4) NOT NULL,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, command_id) REFERENCES business_commands(tenant_id, id)
);
CREATE TABLE production_lines (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  production_order_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('input','output','byproduct','waste')),
  item_id uuid, qty numeric(14,4) NOT NULL CHECK (qty > 0),
  unit_cost numeric(14,4) NOT NULL DEFAULT 0, memo_cost numeric(14,4) NOT NULL DEFAULT 0,
  reason text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, production_order_id) REFERENCES production_orders(tenant_id, id)
);

-- ───────────── Approvals & audit ─────────────
CREATE TABLE approval_policies (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  action text NOT NULL, max_value numeric(14,2) NOT NULL, approver_permission text NOT NULL,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, action)
);
CREATE TABLE approval_requests (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  action text NOT NULL, ref_type text NOT NULL, ref_id uuid NOT NULL,
  requested_by uuid NOT NULL, value numeric(14,2),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by uuid, decided_at timestamptz, self_approved boolean NOT NULL DEFAULT false, reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE audit_log (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid, action text NOT NULL, ref_type text, ref_id uuid,
  before jsonb, after jsonb, meta jsonb, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────── Quotas (plan limits enforced in DB) ─────────────
CREATE FUNCTION enforce_user_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max int; v_cnt int;
BEGIN
  SELECT p.max_users INTO v_max FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = NEW.tenant_id;
  SELECT count(*) INTO v_cnt FROM memberships WHERE tenant_id = NEW.tenant_id AND active;
  IF v_cnt >= v_max THEN RAISE EXCEPTION 'plan user limit reached (%)', v_max USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_user_quota BEFORE INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION enforce_user_quota();

CREATE FUNCTION enforce_item_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max int; v_cnt int;
BEGIN
  SELECT p.max_items INTO v_max FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = NEW.tenant_id;
  SELECT count(*) INTO v_cnt FROM items WHERE tenant_id = NEW.tenant_id;
  IF v_cnt >= v_max THEN RAISE EXCEPTION 'plan item limit reached (%)', v_max USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_item_quota BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION enforce_item_quota();

-- ───────────── Row-Level Security ─────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches','roles','role_permissions','cost_policies','cost_policy_versions','items',
    'recipe_versions','recipe_lines','batches','serials','customers','business_commands',
    'stock_balances','stock_movements','sales_orders','sales_order_lines','order_events',
    'stock_reservations','invoice_counters','invoices','payments','payment_allocations',
    'receivable_entries','production_orders','production_lines','approval_policies',
    'approval_requests','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_visibility ON memberships
  USING (tenant_id = app_tenant() OR user_id = app_user())
  WITH CHECK (tenant_id = app_tenant());

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app_tenant() OR id IN (SELECT tenant_id FROM memberships WHERE user_id = app_user()))
  WITH CHECK (id = app_tenant());

-- ───────────── Platform-only tenant creation ─────────────
CREATE FUNCTION create_tenant(p_name text, p_slug text, p_plan text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM set_config('app.tenant_id', v_id::text, true);
  INSERT INTO tenants (id, name, slug, plan_id) VALUES (v_id, p_name, p_slug, p_plan);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION create_tenant(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_tenant(text, text, text) TO app_platform;

-- ───────────── Grants ─────────────
GRANT USAGE ON SCHEMA public TO app_runtime, app_platform;
GRANT SELECT ON plans TO app_runtime, app_platform;
GRANT SELECT ON users TO app_runtime;
GRANT SELECT, INSERT ON users TO app_platform;
GRANT SELECT ON tenants TO app_runtime;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
           AND tablename NOT IN ('plans','users','tenants')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_runtime', t);
  END LOOP;
END $$;
-- append-only tables: no UPDATE / DELETE for the runtime role
REVOKE UPDATE, DELETE ON stock_movements, audit_log FROM app_runtime;

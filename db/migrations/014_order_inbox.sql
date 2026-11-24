-- Phase D1: product options + a merchant order inbox (counter, phone, WhatsApp, table). An order REQUEST is not a sale:
-- it becomes one only when staff accept it, through the existing sales engine (sales_orders, stock reservation,
-- invoice on payment). No parallel pricing, stock or payment ledger.

-- 1) Options of a product: groups (e.g. "Préparation", "Épices") with choices (e.g. "Grillé", "Sans épices").
--    A choice may ADD a linked product/service line (e.g. "Grillé" adds the grilling service per kg): prices always come
--    from items, so the server computes every total and stock/invoices stay in the sales engine.
CREATE TABLE item_option_groups (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  required boolean NOT NULL DEFAULT false,
  multiple boolean NOT NULL DEFAULT false,
  position int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,item_id) REFERENCES items(tenant_id,id)
);
CREATE TABLE item_option_choices (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 60),
  add_item_id uuid,
  qty_mode text NOT NULL DEFAULT 'same' CHECK (qty_mode IN ('same','one')),   -- same quantity as the product, or one unit
  position int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,group_id) REFERENCES item_option_groups(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,add_item_id) REFERENCES items(tenant_id,id)
);
CREATE INDEX item_option_groups_item ON item_option_groups (tenant_id,item_id);
CREATE INDEX item_option_choices_group ON item_option_choices (tenant_id,group_id);

-- opt-in: only products the owner marks as orderable appear in the order intake (and later in a public menu)
ALTER TABLE items ADD COLUMN orderable boolean NOT NULL DEFAULT false;
-- the kitchen must see the customer's choices ("Sans épices · Grillé")
ALTER TABLE sales_order_lines ADD COLUMN note text CHECK (length(note) <= 300);

-- 2) Order requests (the inbox) and their lines.
CREATE TABLE order_requests (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('counter','phone','whatsapp','table','web')),
  mode text NOT NULL CHECK (mode IN ('pickup','dine_in','delivery')),
  customer_id uuid,
  customer_name text CHECK (length(customer_name) <= 100),
  customer_phone text CHECK (length(customer_phone) <= 30),
  table_label text CHECK (length(table_label) <= 30),
  wanted_at timestamptz,
  note text CHECK (length(note) <= 300),
  to_kitchen boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  quote_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (quote_total >= 0),
  sales_order_id uuid,
  reason text CHECK (length(reason) <= 300),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,sales_order_id),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY (tenant_id,sales_order_id) REFERENCES sales_orders(tenant_id,id),
  CHECK ((status='accepted') = (sales_order_id IS NOT NULL)),
  CHECK (status<>'rejected' OR reason IS NOT NULL)
);
CREATE INDEX order_requests_inbox ON order_requests (tenant_id,branch_id,status,created_at DESC);
CREATE TABLE order_request_lines (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  line_no int NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,4) NOT NULL CHECK (qty > 0),
  choice_ids uuid[] NOT NULL DEFAULT '{}',
  choice_labels text[] NOT NULL DEFAULT '{}',
  note text CHECK (length(note) <= 200),
  quote_total numeric(14,2) NOT NULL CHECK (quote_total >= 0),   -- product + added lines, computed by the server
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,request_id,line_no),
  FOREIGN KEY (tenant_id,request_id) REFERENCES order_requests(tenant_id,id),
  FOREIGN KEY (tenant_id,item_id) REFERENCES items(tenant_id,id)
);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['item_option_groups','item_option_choices','order_requests','order_request_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant())', t||'_tenant', t);
  END LOOP;
END $rls$;
GRANT SELECT,INSERT,UPDATE,DELETE ON item_option_groups,item_option_choices TO app_runtime;
GRANT SELECT,INSERT,UPDATE ON order_requests,order_request_lines TO app_runtime;

-- 3) Permissions for existing shops: owner and manager take and decide orders, cashiers take them and see the inbox.
DO $perm$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id',t.id::text,true);
    INSERT INTO role_permissions (tenant_id,role_id,permission)
      SELECT r.tenant_id,r.id,p.permission FROM roles r
      CROSS JOIN (VALUES ('orders.view'),('orders.manage')) p(permission)
      WHERE r.tenant_id=t.id AND r.name IN ('owner','manager','cashier')
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $perm$;

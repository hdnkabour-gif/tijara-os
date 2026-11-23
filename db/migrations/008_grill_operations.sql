-- Phase B: kitchen order labels and tenant-isolated suppliers, purchases and cash sessions.
ALTER TABLE sales_orders ADD COLUMN service_label text CHECK (length(service_label) <= 60);

CREATE TABLE suppliers (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 150),
  phone text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE purchase_receipts (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  reference text,
  total numeric(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id)
);
CREATE TABLE purchase_receipt_lines (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,4) NOT NULL CHECK (qty > 0),
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,receipt_id) REFERENCES purchase_receipts(tenant_id,id),
  FOREIGN KEY (tenant_id,item_id) REFERENCES items(tenant_id,id)
);
CREATE TABLE cash_sessions (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL,
  opened_by uuid,
  opening_float numeric(14,2) NOT NULL CHECK (opening_float >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid,
  closed_at timestamptz,
  counted_cash numeric(14,2) CHECK (counted_cash >= 0),
  expected_cash numeric(14,2),
  difference numeric(14,2),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id),
  CONSTRAINT cash_close_complete CHECK (
    (closed_at IS NULL AND counted_cash IS NULL AND expected_cash IS NULL AND difference IS NULL)
    OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL AND difference IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_cash_session_per_branch ON cash_sessions (tenant_id,branch_id) WHERE closed_at IS NULL;

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY suppliers_tenant ON suppliers USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
ALTER TABLE purchase_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_receipts_tenant ON purchase_receipts USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
ALTER TABLE purchase_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_receipt_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_lines_tenant ON purchase_receipt_lines USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_sessions_tenant ON cash_sessions USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
GRANT SELECT,INSERT,UPDATE,DELETE ON suppliers,purchase_receipts,purchase_receipt_lines,cash_sessions TO app_runtime;

DO $phaseb$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id',t.id::text,true);
    INSERT INTO role_permissions (tenant_id,role_id,permission)
      SELECT r.tenant_id,r.id,p.permission
      FROM roles r
      CROSS JOIN (VALUES ('kitchen.view'),('kitchen.manage'),('purchases.view'),('purchases.manage'),('cash.view'),('cash.manage'),('production.manage')) p(permission)
      WHERE r.tenant_id=t.id AND r.name='owner'
      ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions (tenant_id,role_id,permission)
      SELECT r.tenant_id,r.id,p.permission
      FROM roles r
      CROSS JOIN (VALUES ('kitchen.view'),('kitchen.manage'),('purchases.view'),('cash.view'),('cash.manage')) p(permission)
      WHERE r.tenant_id=t.id AND r.name='manager'
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $phaseb$;

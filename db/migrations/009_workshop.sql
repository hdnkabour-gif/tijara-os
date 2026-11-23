-- Phase C: tenant/branch-isolated vehicles and mechanic repair workflow.
-- This migration is independent of phase B. Both PRs must be integrated in order.
CREATE TABLE workshop_vehicles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid,
  plate text NOT NULL CHECK (length(plate) BETWEEN 2 AND 30),
  vin text CHECK (length(vin) <= 50),
  make text NOT NULL CHECK (length(make) BETWEEN 1 AND 80),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 80),
  odometer_km bigint NOT NULL DEFAULT 0 CHECK (odometer_km >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,plate),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
CREATE TABLE workshop_orders (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  customer_id uuid,
  sales_order_id uuid,
  state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted','approved','in_progress','completed','delivered','cancelled')),
  issue_note text,
  quote_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (quote_total >= 0),
  mileage_at_visit bigint NOT NULL CHECK (mileage_at_visit >= 0),
  warranty_days integer NOT NULL DEFAULT 0 CHECK (warranty_days BETWEEN 0 AND 3650),
  next_service_date date,
  next_service_km bigint CHECK (next_service_km >= 0),
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  delivered_at timestamptz,
  invoice_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,sales_order_id),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id),
  FOREIGN KEY (tenant_id,vehicle_id) REFERENCES workshop_vehicles(tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY (tenant_id,sales_order_id) REFERENCES sales_orders(tenant_id,id),
  FOREIGN KEY (tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE TABLE workshop_order_lines (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  item_id uuid NOT NULL,
  qty numeric(14,4) NOT NULL CHECK (qty > 0),
  unit_price numeric(14,4) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,work_order_id) REFERENCES workshop_orders(tenant_id,id),
  FOREIGN KEY (tenant_id,item_id) REFERENCES items(tenant_id,id)
);

ALTER TABLE workshop_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_vehicles FORCE ROW LEVEL SECURITY;
CREATE POLICY workshop_vehicles_tenant ON workshop_vehicles USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
ALTER TABLE workshop_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY workshop_orders_tenant ON workshop_orders USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
ALTER TABLE workshop_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY workshop_order_lines_tenant ON workshop_order_lines USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());

GRANT SELECT,INSERT,UPDATE,DELETE ON workshop_vehicles,workshop_orders,workshop_order_lines TO app_runtime;

DO $phasec$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id',t.id::text,true);
    INSERT INTO role_permissions (tenant_id,role_id,permission)
      SELECT r.tenant_id,r.id,p.permission FROM roles r
      CROSS JOIN (VALUES ('workshop.view'),('workshop.manage')) p(permission)
      WHERE r.tenant_id=t.id AND r.name IN ('owner','manager')
      ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $phasec$;

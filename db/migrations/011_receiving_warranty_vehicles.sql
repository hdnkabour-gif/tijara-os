-- PR-A: traceable supplier receipts (batch, expiry, serial numbers, supplier warranty) and vehicle ownership history.
-- Additive only: existing rows keep working (new columns are nullable or have defaults).

-- 1) Purchase receipt lines keep what was received, so a receipt can be audited later
--    (which batch, which expiry, which serial numbers) even if the batch row is reused.
ALTER TABLE purchase_receipt_lines
  ADD COLUMN batch_no text CHECK (length(batch_no) BETWEEN 1 AND 60),
  ADD COLUMN expires_at date,
  ADD COLUMN serial_nos text[] NOT NULL DEFAULT '{}',
  ADD COLUMN warranty_until date,
  ADD CONSTRAINT purchase_line_expiry_needs_batch CHECK (expires_at IS NULL OR batch_no IS NOT NULL);

-- 2) Vehicle ownership history: every owner change is kept (sold cars, company fleets).
CREATE TABLE workshop_vehicle_owners (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL,
  customer_id uuid,
  plate text NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  note text CHECK (length(note) <= 300),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,vehicle_id) REFERENCES workshop_vehicles(tenant_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
CREATE INDEX workshop_vehicle_owners_vehicle ON workshop_vehicle_owners (tenant_id,vehicle_id,changed_at DESC);
ALTER TABLE workshop_vehicle_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_vehicle_owners FORCE ROW LEVEL SECURITY;
CREATE POLICY workshop_vehicle_owners_tenant ON workshop_vehicle_owners USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
-- history is append-only for the application
GRANT SELECT,INSERT ON workshop_vehicle_owners TO app_runtime;

-- current state of existing vehicles becomes the first history entry
-- (FORCE RLS applies to the migration role too: run tenant by tenant)
DO $pra$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id',t.id::text,true);
    INSERT INTO workshop_vehicle_owners (tenant_id,vehicle_id,customer_id,plate,changed_at,note)
      SELECT tenant_id,id,customer_id,plate,created_at,'initial' FROM workshop_vehicles WHERE tenant_id=t.id;
  END LOOP;
  PERFORM set_config('app.tenant_id','',true);
END $pra$;

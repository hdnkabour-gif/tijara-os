-- Preserve what was sold / billed when product labels or company details change later.
-- Existing staging invoices are backfilled with values visible at migration time; historical
-- values from before this migration cannot be reconstructed if already edited.

ALTER TABLE sales_order_lines
  ADD COLUMN item_name_at_sale text,
  ADD COLUMN item_sku_at_sale text,
  ADD COLUMN base_uom_at_sale text;

UPDATE sales_order_lines l
   SET item_name_at_sale = i.name, item_sku_at_sale = i.sku, base_uom_at_sale = i.base_uom
  FROM items i WHERE i.tenant_id = l.tenant_id AND i.id = l.item_id;

ALTER TABLE sales_order_lines
  ALTER COLUMN item_name_at_sale SET NOT NULL,
  ALTER COLUMN item_sku_at_sale SET NOT NULL,
  ALTER COLUMN base_uom_at_sale SET NOT NULL;

ALTER TABLE invoices ADD COLUMN display_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE invoices inv
   SET display_snapshot = jsonb_build_object(
     'shop', jsonb_build_object('name', t.name, 'company', COALESCE(t.settings->'company', '{}'::jsonb)),
     'branchName', b.name,
     'customerName', cu.name,
     'customerPhone', cu.phone)
  FROM sales_orders so
  JOIN branches b ON b.tenant_id = so.tenant_id AND b.id = so.branch_id
  JOIN tenants t ON t.id = so.tenant_id
  LEFT JOIN customers cu ON cu.tenant_id = so.tenant_id AND cu.id = so.customer_id
 WHERE inv.tenant_id = so.tenant_id AND inv.order_id = so.id;

-- A signed invoice must retain its commercial identity, even when the catalog is edited.
CREATE FUNCTION forbid_invoice_snapshot_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.display_snapshot IS DISTINCT FROM OLD.display_snapshot THEN
    RAISE EXCEPTION 'invoice snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoice_snapshot_immutable
 BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_invoice_snapshot_change();

CREATE FUNCTION forbid_order_line_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.item_name_at_sale, NEW.item_sku_at_sale, NEW.base_uom_at_sale)
       IS DISTINCT FROM
     (OLD.item_name_at_sale, OLD.item_sku_at_sale, OLD.base_uom_at_sale) THEN
    RAISE EXCEPTION 'sold item identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_order_line_identity_immutable
 BEFORE UPDATE ON sales_order_lines FOR EACH ROW EXECUTE FUNCTION forbid_order_line_identity_change();

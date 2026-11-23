-- PR-B: platform control center (metadata only) and per-shop branding.
-- The platform role still has NO access to tenant business tables (sales, customers, stock): the functions below return
-- operational metadata only (owners' contact, role counts, branch names, platform audit), never business records.

-- 1) Shop branding: colors + a small logo. Tenant data: FORCE RLS like every tenant table.
CREATE TABLE tenant_branding (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  primary_color text CHECK (primary_color ~ '^#[0-9a-f]{6}$'),
  accent_color text CHECK (accent_color ~ '^#[0-9a-f]{6}$'),
  logo bytea CHECK (octet_length(logo) <= 65536),
  logo_type text CHECK (logo_type IN ('image/png','image/jpeg','image/webp')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((logo IS NULL) = (logo_type IS NULL))
);
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branding_tenant ON tenant_branding USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant());
GRANT SELECT,INSERT,UPDATE ON tenant_branding TO app_runtime;

-- 2) 360° card of ONE shop for the platform admin: owners (to contact them), staff counts by role, branch names.
CREATE FUNCTION platform_tenant_people(p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id=p_tenant) THEN RETURN NULL; END IF;
  PERFORM set_config('app.tenant_id',p_tenant::text,true);
  SELECT jsonb_build_object(
    'owners',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',u.name,'email',u.email,'active',m.active) ORDER BY u.name)
        FROM memberships m JOIN roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=p_tenant AND r.name='owner'),'[]'::jsonb),
    'roles',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',x.name,'active',x.active,'inactive',x.inactive) ORDER BY x.name)
        FROM (SELECT r.name,count(*) FILTER (WHERE m.active)::int AS active,count(*) FILTER (WHERE NOT m.active)::int AS inactive
                FROM memberships m JOIN roles r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
               WHERE m.tenant_id=p_tenant GROUP BY r.name) x),'[]'::jsonb),
    'branches',COALESCE((SELECT jsonb_agg(b.name ORDER BY b.name) FROM branches b WHERE b.tenant_id=p_tenant),'[]'::jsonb),
    'branded',EXISTS (SELECT 1 FROM tenant_branding tb WHERE tb.tenant_id=p_tenant AND (tb.logo IS NOT NULL OR tb.primary_color IS NOT NULL)))
  INTO v;
  PERFORM set_config('app.tenant_id','',true);
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION platform_tenant_people(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenant_people(uuid) TO app_platform;

-- 3) Platform audit feed (whole platform, or one shop), with the actor's display name.
CREATE FUNCTION platform_audit_feed(p_tenant uuid, p_limit int)
RETURNS TABLE(at timestamptz, action text, actor_name text, tenant_id uuid, meta jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT a.at,a.action,u.name,(a.meta->>'tenantId')::uuid,a.meta
    FROM platform_audit a LEFT JOIN users u ON u.id=a.actor_user_id
   WHERE p_tenant IS NULL OR a.meta->>'tenantId'=p_tenant::text
   ORDER BY a.at DESC LIMIT LEAST(GREATEST(p_limit,1),500) $$;
REVOKE ALL ON FUNCTION platform_audit_feed(uuid,int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_audit_feed(uuid,int) TO app_platform;

-- 4) Backup / restore-drill outcomes, written by the backup job and by a restore drill (not by the application):
--    the Control Center shows what really happened, never a status inferred from an environment variable.
CREATE TABLE platform_backup_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('backup','restore_drill')),
  ok boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(detail::text) <= 2000)
);
CREATE INDEX platform_backup_events_kind_at ON platform_backup_events (kind, at DESC);
CREATE TRIGGER trg_platform_backup_events_immutable BEFORE UPDATE OR DELETE ON platform_backup_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT ON platform_backup_events TO app_platform;

-- Callable by the backup job's own database login; the two application roles can never record a (fake) backup.
CREATE FUNCTION platform_record_backup(p_kind text, p_ok boolean, p_detail jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF session_user IN ('app_runtime','app_platform') THEN
    RAISE EXCEPTION 'backup events are recorded by the backup job only' USING ERRCODE='42501';
  END IF;
  INSERT INTO platform_backup_events (kind, ok, detail) VALUES (p_kind, p_ok, COALESCE(p_detail,'{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION platform_record_backup(text,boolean,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_record_backup(text,boolean,jsonb) TO PUBLIC;

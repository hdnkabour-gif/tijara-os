-- schema_migrations is bookkeeping owned by the migration job. The runtime may READ it (readiness check) and must never change it.
-- (Migration 001 granted write access to every table existing at that time, including this one.)
REVOKE ALL ON schema_migrations FROM app_runtime, app_platform;
GRANT SELECT ON schema_migrations TO app_runtime;

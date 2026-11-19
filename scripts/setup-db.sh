#!/usr/bin/env bash
# Local DEV/TEST database bootstrap. Run as root (uses the postgres OS user). Not for production.
set -euo pipefail
PSQL="su postgres -c"
$PSQL "psql -v ON_ERROR_STOP=1 -q" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_owner') THEN
    CREATE ROLE app_owner LOGIN PASSWORD 'owner_dev_pw' NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'runtime_dev_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_platform') THEN
    CREATE ROLE app_platform LOGIN PASSWORD 'platform_dev_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF;
END $$;
SQL
if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='tijara_test'\"" | grep -q 1; then
  su postgres -c "createdb -O app_owner tijara_test"
fi
su postgres -c "psql -q -d tijara_test -c 'ALTER SCHEMA public OWNER TO app_owner'"
echo "db ready"
# dedicated backup role (BYPASSRLS so pg_dump can read every tenant). DEV ONLY password.
su postgres -c "psql -q" <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='backup_admin') THEN
  CREATE ROLE backup_admin LOGIN PASSWORD 'backup_dev_pw' SUPERUSER; END IF; END $$;
SQL

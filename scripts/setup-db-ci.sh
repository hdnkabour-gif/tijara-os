#!/usr/bin/env bash
# CI bootstrap: Postgres service container reachable with PGHOST/PGUSER/PGPASSWORD (superuser). Test roles only.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD 'owner_dev_pw' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE app_runtime LOGIN PASSWORD 'runtime_dev_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE ROLE app_platform LOGIN PASSWORD 'platform_dev_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE tijara_test OWNER app_owner;
SQL
psql -q -d tijara_test -c 'ALTER SCHEMA public OWNER TO app_owner'

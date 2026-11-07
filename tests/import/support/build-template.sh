#!/usr/bin/env bash
# Builds the TEMPLATE database the import rehearsal tests copy from: plain PostgreSQL 16 on 127.0.0.1:55511, the local Supabase stand-ins
# (local-shim.sql: roles, auth/storage tables), then every supabase/migrations file in name order, each as its own run. The name must
# contain "rehearsal". Run once per disposable server; each test file then does CREATE DATABASE ... TEMPLATE for its own copy.
#   tests/import/support/build-template.sh [template name, default sliq_rehearsal_tpl]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
DB=${1:-sliq_rehearsal_tpl}
[[ "$DB" == *rehearsal* && "$DB" =~ ^[a-z0-9_]+$ ]] || { echo "Refusing: the database name must be lower case and contain 'rehearsal' ($DB)" >&2; exit 2; }
export PGHOST=127.0.0.1 PGPORT=55511 PGUSER=postgres
psql -X -q -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB" >/dev/null
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/tests/import/support/local-shim.sql" >/dev/null
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
SQL
n=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  b=$(basename "$f")
  psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>/tmp/sliq-rehearsal-mig.err || { echo "FAIL $b: $(grep -m1 ERROR /tmp/sliq-rehearsal-mig.err)" >&2; exit 1; }
  n=$((n + 1))
done
psql -X -q -d "$DB" -c "alter role service_role bypassrls" >/dev/null
echo "built $DB: shim + $n migrations"

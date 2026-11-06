#!/usr/bin/env bash
# LOCAL PLAIN-POSTGRES ONLY. Builds a throw-away database from supabase/migrations on a bare PG16 server you started yourself
# (no Docker, no Supabase CLI). This is NOT the PQ environment; it only lets the database half of tests/pq be proved without Docker.
#   PGHOST=127.0.0.1 PGPORT=55521 PGUSER=postgres tests/pq/support/build-local-pg.sh pq_local_db
# Refuses a non-loopback host and any database that already holds an organisation.
set -euo pipefail
DB=${1:?usage: build-local-pg.sh DBNAME}
case "${PGHOST:-}" in 127.0.0.1|localhost|::1) ;; *) echo "Refusing: PGHOST must be loopback (got '${PGHOST:-unset}')" >&2; exit 1 ;; esac
[[ "$DB" =~ ^[a-z][a-z0-9_]{2,40}$ ]] || { echo "Refusing: bad database name" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../../.." && pwd)
psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists $DB with (force)" -c "create database $DB" >/dev/null
for f in "$HERE/local-pg-shim.sql" "$HERE/local-pg-extras.sql"; do psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
for f in "$ROOT"/supabase/migrations/*.sql; do
  n=$(basename "$f"); num=${n%%_*}
  psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>"${TMPDIR:-/tmp}/pq-mig-$n.err" || { echo "FAIL $n" >&2; tail -5 "${TMPDIR:-/tmp}/pq-mig-$n.err" >&2; exit 1; }
  psql -X -q -d "$DB" -c "insert into supabase_migrations.schema_migrations(version,name) values ('$num','${n%.sql}')" >/dev/null
done
psql -X -q -d "$DB" -c "alter role service_role bypassrls" >/dev/null
echo "built $DB: $(psql -X -At -d "$DB" -c 'select count(*) from supabase_migrations.schema_migrations') migrations"

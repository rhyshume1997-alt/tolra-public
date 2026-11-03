#!/usr/bin/env bash
# Builds the disposable rehearsal database: a LOCAL plain PostgreSQL 16 (127.0.0.1:5432, user postgres), the Supabase stand-ins
# (standins.sql: roles, auth/storage tables, auth.uid()), then every supabase/migrations file in name order (000-129 on main),
# each in its own transaction. Never a hosted project: the host is fixed to 127.0.0.1 and the name must contain "rehearsal".
#
#   PGPASSWORD=localonly scripts/sliq-import/rehearsal/build-db.sh [db name, default sliq_rehearsal]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
DB=${1:-sliq_rehearsal}
[[ "$DB" == *rehearsal* ]] || { echo "Refusing: the database name must contain 'rehearsal' ($DB)" >&2; exit 2; }
[[ "$DB" =~ ^[a-z0-9_]+$ ]] || { echo "Refusing: database name must be lower case letters, digits and _" >&2; exit 2; }
export PGPASSWORD=${PGPASSWORD:-localonly}
PSQL=(psql -h 127.0.0.1 -p 5432 -U postgres -v ON_ERROR_STOP=1 -q -X)
LOG=${LOG:-$(mktemp -d)}
start=$(date +%s.%N)
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/scripts/sliq-import/rehearsal/standins.sql" >"$LOG/standins.log" 2>&1 || { echo "stand-ins failed: $(grep -m1 ERROR "$LOG/standins.log")" >&2; exit 1; }
n=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  v=$(basename "$f" | cut -d_ -f1)
  "${PSQL[@]}" -d "$DB" -1 -f "$f" >/dev/null 2>"$LOG/migration.err" || { echo "$(basename "$f") failed: $(grep -m1 ERROR "$LOG/migration.err")" >&2; exit 1; }
  "${PSQL[@]}" -d "$DB" -c "insert into supabase_migrations.schema_migrations(version, name) values ('$v', '$(basename "$f" .sql)') on conflict (version) do nothing" >/dev/null
  n=$((n + 1))
done
end=$(date +%s.%N)
all=("$ROOT"/supabase/migrations/*.sql)
first=$(basename "${all[0]}" | cut -d_ -f1)
last=$(basename "${all[-1]}" | cut -d_ -f1)
printf 'built %s: stand-ins + %d migrations (%s-%s) in %.1f s\n' "$DB" "$n" "$first" "$last" "$(echo "$end - $start" | bc)"

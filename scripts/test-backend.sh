#!/usr/bin/env bash
# Disposable local Supabase for the DB and browser suites (audit batch B1). Docker required.
#
#   scripts/test-backend.sh start   # start (or reuse) the local stack, apply migrations, write .env.test.local
#   scripts/test-backend.sh reset   # drop and rebuild the local database from supabase/migrations
#   scripts/test-backend.sh stop    # stop and delete the local containers and volumes
#
# SUPABASE_BIN overrides the CLI (default: `supabase` on PATH). Only ever talks to 127.0.0.1.
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE_BIN:-supabase}"
EXCLUDE="studio,realtime,edge-runtime,logflare,vector,imgproxy,supavisor,postgres-meta"

write_env() {
  # `supabase status -o env` prints API_URL, ANON_KEY, SERVICE_ROLE_KEY, DB_URL ... for the local stack only.
  eval "$("$SUPABASE" status -o env 2>/dev/null)"
  for value in "$API_URL" "$DB_URL"; do
    case "$value" in
      http://127.0.0.1:*|postgresql://*@127.0.0.1:*) ;;
      *) echo "Refusing: local stack reported a non-loopback address ($value)" >&2; exit 1 ;;
    esac
  done
  cat > .env.test.local <<ENV
# Written by scripts/test-backend.sh: the local disposable stack (well-known local demo keys, not secrets).
TEST_SUPABASE_URL=$API_URL
TEST_SUPABASE_ANON_KEY=$ANON_KEY
TEST_SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
TEST_DATABASE_URL=$DB_URL
ENV
  echo "Wrote .env.test.local ($API_URL, database ${DB_URL##*@})"
}

case "${1:-start}" in
  start)
    "$SUPABASE" start -x "$EXCLUDE"
    write_env
    ;;
  reset)
    "$SUPABASE" db reset --local --no-seed
    write_env
    ;;
  env)
    write_env
    ;;
  stop)
    "$SUPABASE" stop --no-backup
    rm -f .env.test.local
    ;;
  *)
    echo "usage: $0 start|reset|env|stop" >&2
    exit 2
    ;;
esac

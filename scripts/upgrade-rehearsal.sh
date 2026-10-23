#!/usr/bin/env bash
# Upgrade rehearsal (audit B10, SEC13). LOCAL disposable stack only: it DROPS and rebuilds the local database twice.
#
#   scripts/upgrade-rehearsal.sh [BASE]     # BASE = last migration already on the target project (default 013)
#
# 1. Rebuilds the local database with migrations up to BASE only (a copy of supabase/ with later files removed).
# 2. Runs tests/rehearsal/upgrade.test.ts: loads data with the old code, runs the read-only verify scripts, applies
#    every later migration as the postgres role (one transaction per file), applies them again, and compares the
#    result with the fresh-build catalogue snapshot.
# 3. Rebuilds the full chain again so the normal suites can run.
# SUPABASE_BIN overrides the CLI (default: `supabase` on PATH).
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${1:-013}"
SUPABASE="${SUPABASE_BIN:-supabase}"
[[ "$BASE" =~ ^[0-9]{3}$ ]] || { echo "BASE must be a 3-digit migration number" >&2; exit 2; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -r supabase "$work/supabase"
for f in "$work"/supabase/migrations/*.sql; do
  n="$(basename "$f" | cut -d_ -f1)"
  [[ "$n" > "$BASE" ]] && rm "$f"
done
echo "[rehearsal] rebuilding the local database at $BASE ($(ls "$work"/supabase/migrations | wc -l) migrations)"
"$SUPABASE" db reset --local --no-seed --workdir "$work"
scripts/test-backend.sh env

status=0
REHEARSAL_BASE="$BASE" npx vitest run -c vitest.rehearsal.config.ts || status=$?

echo "[rehearsal] rebuilding the full migration chain"
scripts/test-backend.sh reset
exit "$status"

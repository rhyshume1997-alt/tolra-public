#!/usr/bin/env bash
# One-off money rounding parity proof on a runner-owned disposable local Supabase stack (same start as ci.yml's integration
# job: scripts/test-backend.sh, every migration in supabase/migrations, 000-144 at the candidate). Never accepts a remote URL
# and never reuses a stack.
#
#   bash scripts/money-parity/run.sh
#
# 1. records and checks the SHAs (scripts/money-parity/shas.sh); 2. starts the stack; 3. runs the two parity files with the
# JSON reporter: tests/db/money-rounding-parity.test.ts (byte-identical to draft PR #284's head) and
# tests/db/money-parity-ties.test.ts (the 38 tie cases); 4. the gate (scripts/money-parity/gate.mjs). Evidence: work/money-parity-*/.
set -euo pipefail
cd "$(dirname "$0")/../.."
SUPABASE="${SUPABASE_BIN:-supabase}"
for key in TEST_DATABASE_URL TEST_SUPABASE_URL TEST_SUPABASE_ANON_KEY TEST_SUPABASE_SERVICE_ROLE_KEY; do
  [[ ! -v "$key" ]] || { echo "money-parity refuses inherited $key; use the fresh runner-owned stack." >&2; exit 1; }
done
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
[[ ! -e .env.test.local ]] || { echo 'money-parity refuses existing .env.test.local; use a fresh dedicated checkout.' >&2; exit 1; }
existing="$(docker ps -aq --filter 'name=^supabase_.*_tolra-local-test$')"
[[ -z "$existing" ]] || { echo 'money-parity refuses existing tolra-local-test containers.' >&2; exit 1; }

mkdir -p work
out="$(mktemp -d "$PWD/work/money-parity-XXXXXX")"
cleanup() { "$SUPABASE" stop --no-backup > "$out/cleanup.log" 2>&1 || true; rm -f .env.test.local; }
trap cleanup EXIT
export SUPABASE_BIN="$SUPABASE"
echo "money-parity evidence directory: $out"

bash scripts/money-parity/shas.sh 2>&1 | tee "$out/shas.txt"

bash scripts/test-backend.sh start > "$out/start.log" 2>&1 || { cat "$out/start.log"; exit 1; }
# Migrations the stack applied (from the stack itself, read-only).
eval "$("$SUPABASE" status -o env 2>/dev/null)"
DB_URL="$DB_URL" node -e '
  const { Client } = require("pg"); const c = new Client({ connectionString: process.env.DB_URL });
  c.connect().then(() => c.query("select version from supabase_migrations.schema_migrations order by version"))
    .then((r) => { for (const x of r.rows) console.log(x.version); return c.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });' > "$out/migrations.txt"
echo "migrations applied: $(wc -l < "$out/migrations.txt") (first $(head -1 "$out/migrations.txt"), last $(tail -1 "$out/migrations.txt"))" | tee -a "$out/shas.txt"

rc=0
CI_EVIDENCE_DB_JSON="$out/parity.json" MONEY_PARITY_TIES_OUT="$out/ties.json" \
  node node_modules/vitest/vitest.mjs run -c vitest.db.config.ts \
  tests/db/money-rounding-parity.test.ts tests/db/money-parity-ties.test.ts > "$out/parity.log" 2>&1 || rc=1
cat "$out/parity.log"
[[ -f "$out/parity.json" ]] || { echo "money-parity: the vitest report is missing." >&2; exit 1; }
node scripts/money-parity/gate.mjs "$out/parity.json" "$out/ties.json" 2>&1 | tee "$out/gate.log"
exit "$rc"

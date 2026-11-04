#!/usr/bin/env bash
# Dedicated disposable local Supabase/Postgres only. Never accepts a remote URL.
set -euo pipefail
cd "$(dirname "$0")/../.."
SUPABASE="${SUPABASE_BIN:-supabase}"
for key in TEST_DATABASE_URL TEST_SUPABASE_URL TEST_SUPABASE_ANON_KEY TEST_SUPABASE_SERVICE_ROLE_KEY PGOPTIONS; do
  [[ ! -v "$key" ]] || { echo "C07 refuses inherited $key; use the fresh runner-owned stack." >&2; exit 1; }
done
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
[[ ! -e .env.test.local ]] || { echo 'C07 refuses existing .env.test.local; use a fresh dedicated checkout.' >&2; exit 1; }
# Do not reuse or destroy somebody else's local stack, including stopped containers.
existing="$(docker ps -aq --filter 'name=^supabase_.*_tolra-local-test$')"
[[ -z "$existing" ]] || { echo 'C07 refuses existing tolra-local-test containers.' >&2; exit 1; }
mkdir -p work
out="$(mktemp -d "$PWD/work/c07-XXXXXX")"
cleanup() { "$SUPABASE" stop --no-backup > "$out/cleanup.log" 2>&1 || true; rm -f .env.test.local; }
trap cleanup EXIT
export SUPABASE_BIN="$SUPABASE"
echo "C07 evidence directory: $out"
bash scripts/test-backend.sh start > "$out/start.log" 2>&1 || { cat "$out/start.log"; exit 1; }
# Inability to load/activate the library is a failed prerequisite, never a skip/fake replacement.
node scripts/c07/enable-safeupdate.mjs | tee "$out/safeupdate.log"
# Existing isolation guards still validate loopback, local keys and synthetic-only tenants.
CI_EVIDENCE_DB_JSON="$out/results.json" node node_modules/vitest/vitest.mjs run -c vitest.db.config.ts \
  tests/db/data-import-pr2.test.ts tests/db/c07-safeupdate.test.ts tests/db/sliq-import.test.ts > "$out/tests.log" 2>&1 || { cat "$out/tests.log"; exit 1; }
node --input-type=module - "$out/results.json" <<'JS'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const all = r.testResults.flatMap((f) => f.assertionResults);
assert(r.success && all.length > 0 && all.every((t) => t.status === 'passed'), 'C07 refuses failed, skipped, pending or empty proof');
assert(r.testResults.length === 3, 'All three required files must execute');
console.log(`C07: ${all.length} executed assertions passed; zero skipped/pending. See private/local evidence directory.`);
JS

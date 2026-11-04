#!/usr/bin/env bash
# C07: the data import and the SliQ cutover importer under the real pg-safeupdate library, on a runner-owned disposable local
# Supabase stack (the same scripts/test-backend.sh start as ci.yml). Never accepts a remote URL and never reuses a stack.
#
#   SAFEUPDATE_BUILD=<dir from scripts/c07/build-safeupdate.sh> bash scripts/c07/run-safeupdate.sh
#
# 1. starts the stack; 2. installs the pinned safeupdate 1.7 build and proves it (scripts/c07/enable-safeupdate.mjs);
# 3. runs the two direct-session suites as a disposable superuser (they LOAD safeupdate themselves, then act as the signed-in
#    user), and the C07 suite plus the SliQ importer suite as the stack's own postgres role (the role scripts/sliq-import uses),
#    with safeupdate preloaded into every new session of that role; 4. the gate (scripts/c07/gate.mjs) requires every test of the
#    four files to PASS, with the five LOADABLE-gated tests named. Evidence: work/c07-*/ (no password in it).
set -euo pipefail
cd "$(dirname "$0")/../.."
SUPABASE="${SUPABASE_BIN:-supabase}"
: "${SAFEUPDATE_BUILD:?set SAFEUPDATE_BUILD to the output of scripts/c07/build-safeupdate.sh}"
[[ -f "$SAFEUPDATE_BUILD/safeupdate.so" && -f "$SAFEUPDATE_BUILD/BUILD-INFO" ]] || { echo "C07: no pinned build in $SAFEUPDATE_BUILD" >&2; exit 1; }
for key in TEST_DATABASE_URL TEST_SUPABASE_URL TEST_SUPABASE_ANON_KEY TEST_SUPABASE_SERVICE_ROLE_KEY PGOPTIONS SLIQ_IMPORT_DATABASE_URL; do
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
private="$(mktemp -d)"
cleanup() { "$SUPABASE" stop --no-backup > "$out/cleanup.log" 2>&1 || true; rm -f .env.test.local; rm -rf "$private"; }
trap cleanup EXIT
export SUPABASE_BIN="$SUPABASE"
echo "C07 evidence directory: $out"
cp "$SAFEUPDATE_BUILD/BUILD-INFO" "$out/BUILD-INFO"

bash scripts/test-backend.sh start > "$out/start.log" 2>&1 || { cat "$out/start.log"; exit 1; }
# Inability to install, load or enforce the library is a failed prerequisite, never a skip or a stand-in.
node scripts/c07/enable-safeupdate.mjs "$SAFEUPDATE_BUILD" "$out" "$private/superuser.url" 2>&1 | tee "$out/safeupdate.log"

rc=0
# Direct-session suites: LOADABLE (tests/db/safeupdate-support.ts) needs a user that may LOAD the library: the disposable superuser.
TEST_DATABASE_URL="$(cat "$private/superuser.url")" CI_EVIDENCE_DB_JSON="$out/direct.json" \
  node node_modules/vitest/vitest.mjs run -c vitest.db.config.ts tests/db/data-import-pr2.test.ts tests/db/data-import-safeupdate.test.ts \
  > "$out/direct.log" 2>&1 || rc=1
# Importer role: postgres, safeupdate preloaded in every new session (no LOAD in the tests or in scripts/sliq-import).
CI_EVIDENCE_DB_JSON="$out/importer.json" \
  node node_modules/vitest/vitest.mjs run -c vitest.db.config.ts tests/db/c07-safeupdate.test.ts tests/db/sliq-import.test.ts \
  > "$out/importer.log" 2>&1 || rc=1
[[ "$rc" == 0 ]] || { echo "C07: a test run failed; the logs follow." >&2; cat "$out/direct.log" "$out/importer.log"; }
[[ -f "$out/direct.json" && -f "$out/importer.json" ]] || { echo "C07: a vitest report is missing." >&2; exit 1; }
node scripts/c07/gate.mjs "$out/direct.json" "$out/importer.json" 2>&1 | tee "$out/gate.log"
exit "$rc"

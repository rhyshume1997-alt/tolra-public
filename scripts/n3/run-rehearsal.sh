#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
for key in TEST_DATABASE_URL TEST_SUPABASE_URL TEST_SUPABASE_ANON_KEY TEST_SUPABASE_SERVICE_ROLE_KEY SLIQ_IMPORT_DATABASE_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE; do
  [[ ! -v "$key" ]] || { echo "N3 refuses inherited $key" >&2; exit 1; }
done
[[ ! -e .env.test.local ]] || { echo 'N3 requires a fresh dedicated checkout' >&2; exit 1; }
: "${N3_PREPROCESS_MODULE:?pinned private source required}"
[[ -f "$N3_PREPROCESS_MODULE" ]] || exit 1
private_root="$(dirname "$N3_PREPROCESS_MODULE")/../.."
[[ "$(git -C "$private_root" rev-parse HEAD)" == 36b1208a83a1d10a9b4bb6562b4e79eb61234007 ]] || { echo 'Wrong private source commit' >&2; exit 1; }
[[ "$(git hash-object "$N3_PREPROCESS_MODULE")" == 6d104c29aa064475171e4371e223600e4cd039da ]] || exit 1
[[ "$(git hash-object "$private_root/scripts/sliq-synthetic-reports.mjs")" == 598f82c3545af564c651182fb9a92a7f8f1c4340 ]] || exit 1
[[ "$(git rev-parse HEAD)" == 9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8 ]] || { echo 'Wrong public candidate' >&2; exit 1; }
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS DOCKER_TLS_VERIFY DOCKER_CERT_PATH
[[ -z "$(docker ps -aq --filter 'name=^supabase_.*_tolra-local-test$')" ]] || { echo 'N3 refuses an existing stack' >&2; exit 1; }
mkdir -p work/n3
printf '%s\n' 'Public candidate: 9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8' 'Private preprocessor: 36b1208a83a1d10a9b4bb6562b4e79eb61234007' > work/n3/source-versions.txt
cleanup() {
  rc=$?
  supabase stop --no-backup > work/n3/cleanup.log 2>&1 || rc=1
  rm -f .env.test.local
  exit "$rc"
}
trap cleanup EXIT
bash scripts/test-backend.sh start > work/n3/start.log 2>&1
# No hosted credentials or SQL inputs. Existing fixtures additionally prove loopback keys and synthetic tenants before writes.
node node_modules/vitest/vitest.mjs run -c vitest.n3.config.ts > work/n3/run.log 2>&1
node scripts/n3/gate.mjs work/n3/results.json

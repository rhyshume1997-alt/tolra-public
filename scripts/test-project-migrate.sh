#!/usr/bin/env bash
# Builds the separate TEST Supabase project the way production was built, for the Vercel preview and as a hosted
# rehearsal of the release (docs/RELEASE-CHECKLIST.md section 3). Never run it against production.
#
#   TEST_DB_URL='postgresql://postgres:...@db.<test-ref>.supabase.co:5432/postgres' \
#   PROTECTED_REFS='<production ref> <legacy ref>' \
#   scripts/test-project-migrate.sh <test-ref> base       # 000-013 as originally applied + the import function
#   ... same env ... scripts/test-project-migrate.sh <test-ref> release    # 014-027 as release text, then checks
#
# Refuses unless TEST_DB_URL names <test-ref> and contains none of PROTECTED_REFS (which must be given), and refuses a
# database holding the real companies unless RESTORE_COPY=yes with the release step (disposable restore copy only).
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${1:-}"; STEP="${2:-}"
[[ -n "$REF" && ( "$STEP" == base || "$STEP" == release ) ]] || { echo "usage: $0 <test-ref> base|release" >&2; exit 2; }
[[ -n "${TEST_DB_URL:-}" ]] || { echo "TEST_DB_URL is not set" >&2; exit 2; }
[[ -n "${PROTECTED_REFS:-}" ]] || { echo "PROTECTED_REFS (production and legacy project refs) must be set" >&2; exit 2; }
[[ "$TEST_DB_URL" == *"$REF"* ]] || { echo "Refusing: TEST_DB_URL does not name the test project $REF" >&2; exit 1; }
for p in $PROTECTED_REFS; do
  [[ "$TEST_DB_URL" != *"$p"* ]] || { echo "Refusing: TEST_DB_URL names a protected project ($p)" >&2; exit 1; }
done
psqlx() { psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }
# A database holding the real companies is never a test project. Exception: the disposable restore copy
# (RESTORE_COPY=yes), for the release step only, to rehearse the release on real data (checklist section 4).
if [[ "$(psqlx -Atc "select count(*) from pg_tables where schemaname='public' and tablename='organizations'")" == 1 ]] &&
   [[ "$(psqlx -Atc "select count(*) from public.organizations where slug in ('jnr-engineering','marpet')")" != 0 ]] &&
   ! [[ "${RESTORE_COPY:-}" == yes && "$STEP" == release ]]; then
  echo "Refusing: this database holds real companies" >&2; exit 1
fi

if [[ "$STEP" == base ]]; then
  for f in supabase/migrations/0{00,01,02,03,04,05,06,07,08,09,10,11,12,13}_*.sql; do
    echo "[base] $f"; psqlx -f "$f" >/dev/null
  done
  echo "[base] import function"; psqlx -f supabase/import/import_legacy_tenant.sql >/dev/null
else
  for f in supabase/migrations/0{14,15,16,17,18,19,20,21,22,23,24,25,26,27}_*.sql; do
    echo "[release] $f"; node scripts/release-sql.mjs "$f" | psqlx >/dev/null
  done
  psqlx -c "notify pgrst, 'reload schema'" -c "notify pgrst, 'reload config'"
  for v in cross_org_links duplicate_conversions document_totals unmarked_bans; do
    echo "[check] $v: $(psqlx -Atf supabase/verify/$v.sql | grep -c . || true) row(s) (expected 0)"
  done
fi
echo "[preflight]"; psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -f supabase/verify/release_preflight.sql

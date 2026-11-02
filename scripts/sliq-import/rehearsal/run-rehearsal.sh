#!/usr/bin/env bash
# The whole SliQ import rehearsal on SYNTHETIC data, end to end, on a LOCAL disposable PostgreSQL 16 (127.0.0.1:5432). Repeatable:
# every run rebuilds the databases from scratch. Never a hosted project (the importer's own URL screening applies to every step).
#
#   PGPASSWORD=localonly scripts/sliq-import/rehearsal/run-rehearsal.sh [work folder]
#
# Steps follow the run sheet (SLIQ-IMPORT "Dry run", "Dry run with the collision check", "Prepare the rehearsal copy",
# "Rehearsal write"), then the checks. Writes <work>/timings.tsv, <work>/results/*.txt and the dry-run reports. Exit 1 on a FAIL.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
HERE="$ROOT/scripts/sliq-import/rehearsal"
W=${1:-$(mktemp -d)}
export PGPASSWORD=${PGPASSWORD:-localonly}
DB=sliq_rehearsal
URL="postgresql://postgres@127.0.0.1:5432/$DB"
RB=sliq_rehearsal_rollback
RB_URL="postgresql://postgres@127.0.0.1:5432/$RB"
RS=sliq_rehearsal_restore
PSQL=(psql -h 127.0.0.1 -p 5432 -U postgres -X -q -At -v ON_ERROR_STOP=1)
CLI=(node "$ROOT/scripts/sliq-import/cli.mjs")
EXCL="INV-0100,INV-0101"   # the duplicate number (both copies, flagged for review) and the 5% discount invoice
rm -rf "$W/results" "$W/r-"*; mkdir -p "$W/results"
: >"$W/timings.tsv"
fail=0
step() { # step <label> <command...>: runs it, records the wall time, keeps its output
  local label=$1; shift
  local t0 t1; t0=$(date +%s.%N)
  "$@" >"$W/results/$label.txt" 2>&1; local rc=$?
  t1=$(date +%s.%N)
  printf '%s\t%.2f\t%s\n' "$label" "$(echo "$t1 - $t0" | bc)" "$rc" | tee -a "$W/timings.tsv"
  return $rc
}
expect_fail() { "$@" && { echo "UNEXPECTED: it succeeded"; return 1; } || { echo "refused as expected (exit $?)"; return 0; }; }
check() { if grep -q '^FAIL' "$W/results/$1.txt"; then echo "FAIL in $1"; fail=1; fi; }

step 01-build-db "$HERE/build-db.sh" "$DB" || exit 1
step 02-generate node "$HERE/generate.mjs" "$W" || exit 1
step 03-tenants "${PSQL[@]}" -d "$DB" -f "$HERE/setup-tenants.sql" || exit 1
ORG=$("${PSQL[@]}" -d "$DB" -c "select id from public.organizations where slug = 'rehearsal-a'")
OPTS=(--mapping synthetic --resolutions "$W/resolutions.json" --exclude "$EXCL")

# Dry run without a database, then the provisional-mapping variant (a write must be refused while the mapping is provisional).
step 04-dry-run "${CLI[@]}" "$W/export" "${OPTS[@]}" --out "$W/r-dry" || exit 1
step 05-dry-run-sliq-provisional "${CLI[@]}" "$W/export-sliq" --mapping sliq --out "$W/r-sliq" || exit 1
step 06-write-refused-provisional expect_fail "${CLI[@]}" "$W/export-sliq" --mapping sliq --write --report "$W/r-sliq/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
# Without the exclusions the write is refused (documents flagged for review).
step 07-prepare-rehearsal "${CLI[@]}" prepare-rehearsal --database-url "$URL" || exit 1
step 08-dry-run-collision-no-exclude "${CLI[@]}" "$W/export" --mapping synthetic --resolutions "$W/resolutions.json" --out "$W/r-noexcl" --database-url "$URL" --organization-id "$ORG" || exit 1
step 09-write-refused-unresolved-review expect_fail "${CLI[@]}" "$W/export" --mapping synthetic --resolutions "$W/resolutions.json" --write --report "$W/r-noexcl/report.json" --database-url "$URL" --organization-id "$ORG" --install-importer || fail=1
step 10a-dry-run-no-resolutions "${CLI[@]}" "$W/export" --mapping synthetic --exclude "$EXCL" --out "$W/r-nores" --database-url "$URL" --organization-id "$ORG" || exit 1
step 10-write-refused-no-resolutions expect_fail "${CLI[@]}" "$W/export" --mapping synthetic --exclude "$EXCL" --write --report "$W/r-nores/report.json" --database-url "$URL" --organization-id "$ORG" --install-importer || fail=1
step 11-dry-run-collision "${CLI[@]}" "$W/export" "${OPTS[@]}" --out "$W/r-coll" --database-url "$URL" --organization-id "$ORG" || exit 1

# The pre-import state: a backup (pg_dump) and a template copy for the failed-write rollback check.
step 12-backup pg_dump -h 127.0.0.1 -U postgres -Fc -f "$W/pre-import.dump" "$DB" || exit 1
"${PSQL[@]}" -d postgres -c "drop database if exists $RB" -c "create database $RB template $DB"

step 13-write "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-coll/report.json" --database-url "$URL" --organization-id "$ORG" --install-importer || exit 1
step 14-checks node "$HERE/checks.mjs" --work "$W" --report "$W/r-coll/report.json" --database-url "$URL" --json "$W/results/checks.json"; check 14-checks
step 15-tenant-checks "${PSQL[@]}" -d "$DB" -f "$HERE/tenant-checks.sql"; check 15-tenant-checks

# Re-run: a fresh dry run against the imported target, then the write again. Nothing new may be created; the checks must still pass.
step 16-rerun-dry-run "${CLI[@]}" "$W/export" "${OPTS[@]}" --out "$W/r-rerun" --database-url "$URL" --organization-id "$ORG" || exit 1
step 17-rerun-write "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-rerun/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q '{"invoices":0,"lines":0,"payments":0,"paymentToConfirm":0,"quoteLines":0}' "$W/results/17-rerun-write.txt" && echo "PASS|re-run creates nothing" || { echo "FAIL|re-run created rows"; fail=1; }
step 18-rerun-old-report "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-coll/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q '{"invoices":0,"lines":0,"payments":0,"paymentToConfirm":0,"quoteLines":0}' "$W/results/18-rerun-old-report.txt" && echo "PASS|re-run with the first report creates nothing" || { echo "FAIL|re-run with the first report created rows"; fail=1; }
step 19-checks-after-rerun node "$HERE/checks.mjs" --work "$W" --report "$W/r-coll/report.json" --database-url "$URL"; check 19-checks-after-rerun
# A changed source file makes the approved report stale: the write is refused.
cp -r "$W/export" "$W/export-changed"; sed -i '2 s/\r$/X\r/' "$W/export-changed/payments.csv"  # one changed reference
step 20-write-refused-stale-report expect_fail "${CLI[@]}" "$W/export-changed" "${OPTS[@]}" --write --report "$W/r-coll/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1

# Rollback 1 (before COMMIT): a failure late in the write (payment 1990 of 1998) rolls the whole import back.
"${PSQL[@]}" -d "$RB" -c "create function public.rehearsal_fail() returns trigger language plpgsql as \$\$ begin if (select count(*) from public.invoice_payments where organization_id = new.organization_id) >= 1990 then raise exception 'rehearsal: injected failure at payment 1990'; end if; return new; end \$\$" \
  -c "create trigger rehearsal_fail before insert on public.invoice_payments for each row execute function public.rehearsal_fail()"
step 21-dry-run-rollback-copy "${CLI[@]}" "$W/export" "${OPTS[@]}" --out "$W/r-rb" --database-url "$RB_URL" --organization-id "$ORG" || exit 1
step 22-write-fails-midway expect_fail "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-rb/report.json" --database-url "$RB_URL" --organization-id "$ORG" --install-importer || fail=1
grep -q "injected failure" "$W/results/22-write-fails-midway.txt" || { echo "FAIL|the injected failure was not what stopped the write"; fail=1; }
left=$("${PSQL[@]}" -d "$RB" -c "select (select count(*) from customers where organization_id = '$ORG') + (select count(*) from suppliers where organization_id = '$ORG') + (select count(*) from invoices where organization_id = '$ORG') + (select count(*) from invoice_payments where organization_id = '$ORG') + (select count(*) from quotes where organization_id = '$ORG') + (select count(*) from purchase_orders where organization_id = '$ORG') + (select count(*) from doc_counters where organization_id = '$ORG' and last > 0)")
mapn=$("${PSQL[@]}" -d "$RB" -c "select to_regclass('public.legacy_import_map') is not null")
[[ "$mapn" == t ]] && left=$((left + $("${PSQL[@]}" -d "$RB" -c "select count(*) from public.legacy_import_map")))
echo "importer tables present after the failed write: $mapn (f = even the --install-importer step was rolled back)"
[[ "$left" == 0 ]] && echo "PASS|failed write left nothing behind (0 rows in A, 0 map rows, no counters)" || { echo "FAIL|failed write left $left rows"; fail=1; }
"${PSQL[@]}" -d "$RB" -c "drop trigger rehearsal_fail on public.invoice_payments" -c "drop function public.rehearsal_fail()"

# Rollback 2 (after COMMIT): the documented way back is the backup taken before the import, restored into a new database.
"${PSQL[@]}" -d postgres -c "drop database if exists $RS" -c "create database $RS"
step 23-restore-backup pg_restore -h 127.0.0.1 -U postgres -d "$RS" --no-owner "$W/pre-import.dump" || true
rs=$("${PSQL[@]}" -d "$RS" -c "select (select count(*) from invoices where organization_id = '$ORG') || '/' || (select count(*) from customers where organization_id = '$ORG') || '/' || (select count(*) from invoices where invoice_ref = 'INV-1000') || '/' || (select count(*) from rehearsal_identity)")
[[ "$rs" == "0/0/1/1" ]] && echo "PASS|restored backup: tenant A empty again, tenant B intact, rehearsal identity kept ($rs)" || { echo "FAIL|restored backup state $rs"; fail=1; }

echo "timings (s):"; cat "$W/timings.tsv"
[[ $fail == 0 ]] && echo "REHEARSAL: all checks PASS" || echo "REHEARSAL: FAIL"
exit $fail

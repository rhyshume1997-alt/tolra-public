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
DB=${REHEARSAL_DB:-sliq_rehearsal}   # another name (containing "rehearsal") keeps parallel runs apart
URL="postgresql://postgres@127.0.0.1:5432/$DB"
RB=${DB}_rollback
RB_URL="postgresql://postgres@127.0.0.1:5432/$RB"
RS=${DB}_restore
PSQL=(psql -h 127.0.0.1 -p 5432 -U postgres -X -q -At -v ON_ERROR_STOP=1)
CLI=(node "$ROOT/scripts/sliq-import/cli.mjs")
# The 5% discount invoice (needs review), the invoice, purchase order and job whose customer or supplier is in no file (unmatched:
# each stops the write until excluded, decision 3). The names layout has no jobs files, so it cannot name the job.
EXCL="INV-0101,INV-0102,PO-0012,J-1508"
NEXCL="INV-0101,INV-0102,PO-0012"
NM=${DB}_names              # the same import from the layout whose documents name the customer (decision 3)
NM_URL="postgresql://postgres@127.0.0.1:5432/$NM"
JD=${DB}_jobdup             # the jobs files with a job and a sales order number SliQ used twice (decisions 2 and 3 on jobs)
JD_URL="postgresql://postgres@127.0.0.1:5432/$JD"
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
# Decision 3: two customers with exactly the same name stop the write until one has its own Tolra name (customerNames).
step 10b-dry-run-same-name "${CLI[@]}" "$W/export" --mapping synthetic --resolutions "$W/resolutions-cn.json" --exclude "$EXCL" --out "$W/r-same" --database-url "$URL" --organization-id "$ORG" || exit 1
step 10c-write-refused-same-name expect_fail "${CLI[@]}" "$W/export" --mapping synthetic --resolutions "$W/resolutions-cn.json" --exclude "$EXCL" --write --report "$W/r-same/report.json" --database-url "$URL" --organization-id "$ORG" --install-importer || fail=1
grep -q "ambiguous or unmatched" "$W/results/10c-write-refused-same-name.txt" && [[ $(grep -c ',yes,' "$W/r-same/ambiguity.csv") == 2 ]] && echo "PASS|same-name customers: ambiguity.csv has the 2 customers and the write is refused" || { echo "FAIL|same-name customers were not refused"; fail=1; }
# Decision 3: without the orphan excluded, its unmatched customer stops the write.
step 10d-dry-run-orphan "${CLI[@]}" "$W/export" --mapping synthetic --resolutions "$W/resolutions.json" --exclude INV-0101 --out "$W/r-orph" --database-url "$URL" --organization-id "$ORG" || exit 1
step 10e-write-refused-orphan expect_fail "${CLI[@]}" "$W/export" --mapping synthetic --resolutions "$W/resolutions.json" --exclude INV-0101 --write --report "$W/r-orph/report.json" --database-url "$URL" --organization-id "$ORG" --install-importer || fail=1
grep -q "invoice INV-0102" "$W/results/10e-write-refused-orphan.txt" && grep -q "^invoice,INV-0102,INV-0102,invoices.csv,5,C9999,unmatched" "$W/r-orph/ambiguity.csv" && echo "PASS|unmatched customer: INV-0102 in ambiguity.csv and the write is refused" || { echo "FAIL|the unmatched customer did not stop the write"; fail=1; }
step 11-dry-run-collision "${CLI[@]}" "$W/export" "${OPTS[@]}" --out "$W/r-coll" --database-url "$URL" --organization-id "$ORG" || exit 1
# Decision 2: the same files give the same numbers every run (the dry run without a database and with one).
node -e 'const [a, b] = process.argv.slice(1).map((f) => JSON.stringify(require(f).renames)); process.exit(a === b && a.includes("INV-0100-B") ? 0 : 1)' "$W/r-dry/report.json" "$W/r-coll/report.json" \
  && echo "PASS|duplicates: the same renames on every run ($(node -e 'console.log(require(process.argv[1]).renames.filter((x) => !x.keeps).map((x) => x.sourceNumber + " -> " + x.number).join(", "))' "$W/r-coll/report.json"))" || { echo "FAIL|duplicate renames differ between runs"; fail=1; }

# The pre-import state: a backup (pg_dump) and a template copy for the failed-write rollback check.
step 12-backup pg_dump -h 127.0.0.1 -U postgres -Fc -f "$W/pre-import.dump" "$DB" || exit 1
"${PSQL[@]}" -d postgres -c "drop database if exists $RB" -c "create database $RB template $DB"
"${PSQL[@]}" -d postgres -c "drop database if exists $NM" -c "create database $NM template $DB"
"${PSQL[@]}" -d postgres -c "drop database if exists $JD" -c "create database $JD template $DB"

step 13-write "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-coll/report.json" --database-url "$URL" --organization-id "$ORG" --install-importer || exit 1
step 14-checks node "$HERE/checks.mjs" --work "$W" --report "$W/r-coll/report.json" --database-url "$URL" --json "$W/results/checks.json"; check 14-checks
step 15-tenant-checks "${PSQL[@]}" -d "$DB" -f "$HERE/tenant-checks.sql"; check 15-tenant-checks
# Part B: open jobs, sales orders, PO statuses and job links, opening WIP, numbering, the verification sheets; then as signed-in users.
grep -q '^Jobs import: {"jobs":34,' "$W/results/13-write.txt" && echo "PASS|the write created the open jobs" || { echo "FAIL|the write did not report the jobs"; fail=1; }
step 15b-jobs-checks node "$HERE/jobs-checks.mjs" --work "$W" --report "$W/r-coll/report.json" --database-url "$URL" --json "$W/results/jobs-checks.json" || { echo "FAIL|jobs checks"; fail=1; }; check 15b-jobs-checks
step 15c-jobs-tenant-checks "${PSQL[@]}" -d "$DB" -f "$HERE/jobs-tenant-checks.sql" || { echo "FAIL|jobs tenant checks"; fail=1; }; check 15c-jobs-tenant-checks

# Re-run: a fresh dry run against the imported target, then the write again. Nothing new may be created; the checks must still pass.
step 16-rerun-dry-run "${CLI[@]}" "$W/export" "${OPTS[@]}" --out "$W/r-rerun" --database-url "$URL" --organization-id "$ORG" || exit 1
step 17-rerun-write "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-rerun/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q '{"invoices":0,"lines":0,"payments":0,"paymentToConfirm":0,"quoteLines":0,"creditNotes":0}' "$W/results/17-rerun-write.txt" && echo "PASS|re-run creates nothing" || { echo "FAIL|re-run created rows"; fail=1; }
JOBS0='{"jobs":0,"salesOrders":0,"jobValues":0,"purchaseOrderJobLinks":0,"wipRows":0,"wipValue":"0.00"'
grep -qF "Jobs import: $JOBS0" "$W/results/17-rerun-write.txt" && echo "PASS|re-run creates no job, order, link or WIP row" || { echo "FAIL|re-run created jobs rows"; fail=1; }
step 18-rerun-old-report "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-coll/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q '{"invoices":0,"lines":0,"payments":0,"paymentToConfirm":0,"quoteLines":0,"creditNotes":0}' "$W/results/18-rerun-old-report.txt" && echo "PASS|re-run with the first report creates nothing" || { echo "FAIL|re-run with the first report created rows"; fail=1; }
grep -qF "Jobs import: $JOBS0" "$W/results/18-rerun-old-report.txt" && echo "PASS|re-run with the first report creates no jobs rows" || { echo "FAIL|re-run with the first report created jobs rows"; fail=1; }
step 19-checks-after-rerun node "$HERE/checks.mjs" --work "$W" --report "$W/r-coll/report.json" --database-url "$URL"; check 19-checks-after-rerun
step 19b-jobs-checks-after-rerun node "$HERE/jobs-checks.mjs" --work "$W" --report "$W/r-coll/report.json" --database-url "$URL" || { echo "FAIL|jobs checks after the re-run"; fail=1; }; check 19b-jobs-checks-after-rerun
# A changed source file makes the approved report stale: the write is refused.
cp -r "$W/export" "$W/export-changed"; sed -i '2 s/\r$/X\r/' "$W/export-changed/payments.csv"  # one changed reference
step 20-write-refused-stale-report expect_fail "${CLI[@]}" "$W/export-changed" "${OPTS[@]}" --write --report "$W/r-coll/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
# The same for a jobs file: one changed byte in jobs.csv makes the approved report stale.
cp -r "$W/export" "$W/export-jobs-changed"; sed -i '2 s/Open/Late/' "$W/export-jobs-changed/jobs.csv"
step 20b-write-refused-stale-jobs-file expect_fail "${CLI[@]}" "$W/export-jobs-changed" "${OPTS[@]}" --write --report "$W/r-coll/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q "report is stale.*(jobs.csv)" "$W/results/20b-write-refused-stale-jobs-file.txt" || { echo "FAIL|the changed jobs file was not what refused the write"; fail=1; }
# Header check: a jobs file with an unknown column, or without a mapped one, is refused with the list (even a dry run).
cp -r "$W/export" "$W/export-jobs-extra"; sed -i '1 s/\r$/,Foreman\r/; 2,$ s/\r$/,\r/' "$W/export-jobs-extra/jobs.csv"
step 20c-dry-run-refused-unknown-column expect_fail "${CLI[@]}" "$W/export-jobs-extra" "${OPTS[@]}" --out "$W/r-extra" || fail=1
grep -q 'jobs.csv: unknown column "Foreman"' "$W/results/20c-dry-run-refused-unknown-column.txt" || { echo "FAIL|the unknown column is not listed"; fail=1; }
cp -r "$W/export" "$W/export-jobs-missing"; python3 -I -c "import csv,sys; p=sys.argv[1]; r=list(csv.reader(open(p, newline=''))); i=r[0].index('Due'); w=csv.writer(open(p, 'w', newline=''), lineterminator='\r\n'); [w.writerow(x[:i] + x[i + 1:]) for x in r]" "$W/export-jobs-missing/jobs.csv"
step 20d-dry-run-refused-missing-column expect_fail "${CLI[@]}" "$W/export-jobs-missing" "${OPTS[@]}" --out "$W/r-missing" || fail=1
grep -q 'jobs.csv: missing column "Due"' "$W/results/20d-dry-run-refused-missing-column.txt" || { echo "FAIL|the missing column is not listed"; fail=1; }
# A strict mapping ("headerCheck": "strict", as mappings/sliq.json) refuses the WRITE when a main file has a column the mapping does not name.
python3 -I -c "import json,sys; m=json.load(open(sys.argv[1])); m['headerCheck']='strict'; json.dump(m, open(sys.argv[2], 'w'), indent=2)" "$ROOT/scripts/sliq-import/mappings/synthetic.json" "$W/synthetic-strict.json"
cp -r "$W/export" "$W/export-cust-extra"; sed -i '1 s/\r$/,Credit Limit\r/; 2,$ s/\r$/,\r/' "$W/export-cust-extra/customers.csv"
SOPTS=(--mapping "$W/synthetic-strict.json" --resolutions "$W/resolutions.json" --exclude "$EXCL")
step 20e-dry-run-strict-lists "${CLI[@]}" "$W/export-cust-extra" "${SOPTS[@]}" --out "$W/r-strict" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q 'customers.csv: unknown column "Credit Limit"' "$W/r-strict/report.md" || { echo "FAIL|the strict report does not list the unknown column"; fail=1; }
step 20f-write-refused-strict-header expect_fail "${CLI[@]}" "$W/export-cust-extra" "${SOPTS[@]}" --write --report "$W/r-strict/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q 'customers.csv: unknown column "Credit Limit"' "$W/results/20f-write-refused-strict-header.txt" || { echo "FAIL|the strict header check was not what refused the write"; fail=1; }
# The same strict check on the purchase orders file (it carries each order's status and job link): an unknown column is listed and
# refuses the write; and the sales orders and WIP files, like the jobs file, are refused with the list even in a dry run.
cp -r "$W/export" "$W/export-po-extra"; sed -i '1 s/\r$/,Buyer\r/; 2,$ s/\r$/,\r/' "$W/export-po-extra/purchase-orders.csv"
step 20g-dry-run-strict-lists-po "${CLI[@]}" "$W/export-po-extra" "${SOPTS[@]}" --out "$W/r-strict-po" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q 'purchase-orders.csv: unknown column "Buyer"' "$W/r-strict-po/report.md" || { echo "FAIL|the strict report does not list the purchase orders' unknown column"; fail=1; }
step 20h-write-refused-strict-po-header expect_fail "${CLI[@]}" "$W/export-po-extra" "${SOPTS[@]}" --write --report "$W/r-strict-po/report.json" --database-url "$URL" --organization-id "$ORG" || fail=1
grep -q 'purchase-orders.csv: unknown column "Buyer"' "$W/results/20h-write-refused-strict-po-header.txt" || { echo "FAIL|the purchase orders' header was not what refused the write"; fail=1; }
cp -r "$W/export" "$W/export-so-extra"; sed -i '1 s/\r$/,Rep\r/; 2,$ s/\r$/,\r/' "$W/export-so-extra/sales-orders.csv"
step 20i-dry-run-refused-so-unknown-column expect_fail "${CLI[@]}" "$W/export-so-extra" "${OPTS[@]}" --out "$W/r-so-extra" || fail=1
grep -q 'sales-orders.csv: unknown column "Rep"' "$W/results/20i-dry-run-refused-so-unknown-column.txt" || { echo "FAIL|the sales orders' unknown column is not listed"; fail=1; }
cp -r "$W/export" "$W/export-wip-missing"; python3 -I -c "import csv,sys; p=sys.argv[1]; r=list(csv.reader(open(p, newline=''))); i=r[0].index('Qty'); w=csv.writer(open(p, 'w', newline=''), lineterminator='\r\n'); [w.writerow(x[:i] + x[i + 1:]) for x in r]" "$W/export-wip-missing/wip.csv"
step 20j-dry-run-refused-wip-missing-column expect_fail "${CLI[@]}" "$W/export-wip-missing" "${OPTS[@]}" --out "$W/r-wip-missing" || fail=1
grep -q 'wip.csv: missing column "Qty"' "$W/results/20j-dry-run-refused-wip-missing-column.txt" || { echo "FAIL|the WIP file's missing column is not listed"; fail=1; }
for f in jobs-verification.csv wip-verification.csv; do [[ -s "$W/r-coll/$f" ]] && echo "PASS|the approved dry run wrote $f ($(($(wc -l <"$W/r-coll/$f"))) lines)" || { echo "FAIL|$f missing"; fail=1; }; done

# Decision 3 on the layout whose documents name the customer: 106 documents of the two same-name customers are ambiguous and stop the
# write; with each one's account named in resolutions-names.json the write goes through and every document is on the right customer.
NOPTS=(--mapping "$W/synthetic-names.json" --exclude "$NEXCL")
step 24-names-dry-run-unresolved "${CLI[@]}" "$W/export-names" "${NOPTS[@]}" --resolutions "$W/resolutions.json" --out "$W/r-names-unres" --database-url "$NM_URL" --organization-id "$ORG" || exit 1
step 25-names-write-refused expect_fail "${CLI[@]}" "$W/export-names" "${NOPTS[@]}" --resolutions "$W/resolutions.json" --write --report "$W/r-names-unres/report.json" --database-url "$NM_URL" --organization-id "$ORG" --install-importer || fail=1
amb=$(($(grep -c ',yes,' "$W/r-names-unres/ambiguity.csv")))
want=$(node -e 'console.log(require(process.argv[1]).expected.namesLayoutAmbiguousDocuments)' "$W/manifest.json")
[[ "$amb" == "$want" ]] && grep -q "ambiguous or unmatched" "$W/results/25-names-write-refused.txt" && echo "PASS|names layout: ambiguity.csv lists the $amb documents of the same-name customers and the write is refused" || { echo "FAIL|names layout: $amb ambiguous (expected $want) or the write was not refused"; fail=1; }
step 26-names-dry-run-resolved "${CLI[@]}" "$W/export-names" "${NOPTS[@]}" --resolutions "$W/resolutions-names.json" --out "$W/r-names" --database-url "$NM_URL" --organization-id "$ORG" || exit 1
step 27-names-write "${CLI[@]}" "$W/export-names" "${NOPTS[@]}" --resolutions "$W/resolutions-names.json" --write --report "$W/r-names/report.json" --database-url "$NM_URL" --organization-id "$ORG" --install-importer || fail=1
step 28-names-checks node "$HERE/checks.mjs" --work "$W" --report "$W/r-names/report.json" --database-url "$NM_URL"; check 28-names-checks

# Decisions 2 and 3 on the jobs files: J-1512 and SO-0205 used twice. Both copies are kept (J-1512-B, SO-0205-B); every link that
# names them (WIP lines and a purchase order on J-1512, job J-1515's order) is ambiguous and stops the write; with the Tolra number
# of each named in resolutions-jobdup.json (jobLinks) the write goes through and every link is the one named: 0 wrong attachments.
step 29-jobdup-dry-run-unresolved "${CLI[@]}" "$W/export-jobdup" "${OPTS[@]}" --out "$W/r-jobdup-unres" --database-url "$JD_URL" --organization-id "$ORG" || exit 1
step 30-jobdup-write-refused expect_fail "${CLI[@]}" "$W/export-jobdup" "${OPTS[@]}" --write --report "$W/r-jobdup-unres/report.json" --database-url "$JD_URL" --organization-id "$ORG" --install-importer || fail=1
jamb=$(($(grep -c ',yes,' "$W/r-jobdup-unres/ambiguity.csv")))
jwant=$(node -e 'console.log(require(process.argv[1]).jobDup.ambiguous)' "$W/manifest.json")
[[ "$jamb" == "$jwant" ]] && grep -q "ambiguous or unmatched" "$W/results/30-jobdup-write-refused.txt" && echo "PASS|jobs layout: ambiguity.csv lists the $jamb links SliQ's repeated job and order numbers cannot make, and the write is refused" || { echo "FAIL|jobs layout: $jamb ambiguous (expected $jwant) or the write was not refused"; fail=1; }
step 31-jobdup-dry-run-resolved "${CLI[@]}" "$W/export-jobdup" --mapping synthetic --resolutions "$W/resolutions-jobdup.json" --exclude "$EXCL" --out "$W/r-jobdup" --database-url "$JD_URL" --organization-id "$ORG" || exit 1
step 32-jobdup-write "${CLI[@]}" "$W/export-jobdup" --mapping synthetic --resolutions "$W/resolutions-jobdup.json" --exclude "$EXCL" --write --report "$W/r-jobdup/report.json" --database-url "$JD_URL" --organization-id "$ORG" --install-importer || fail=1
step 33-jobdup-checks node "$HERE/jobdup-checks.mjs" --work "$W" --report "$W/r-jobdup/report.json" --database-url "$JD_URL"; check 33-jobdup-checks

# Rollback 1 (before COMMIT): a failure late in the write (payment 1990 of 1999) rolls the whole import back.
"${PSQL[@]}" -d "$RB" -c "create function public.rehearsal_fail() returns trigger language plpgsql as \$\$ begin if (select count(*) from public.invoice_payments where organization_id = new.organization_id) >= 1990 then raise exception 'rehearsal: injected failure at payment 1990'; end if; return new; end \$\$" \
  -c "create trigger rehearsal_fail before insert on public.invoice_payments for each row execute function public.rehearsal_fail()"
step 21-dry-run-rollback-copy "${CLI[@]}" "$W/export" "${OPTS[@]}" --out "$W/r-rb" --database-url "$RB_URL" --organization-id "$ORG" || exit 1
step 22-write-fails-midway expect_fail "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-rb/report.json" --database-url "$RB_URL" --organization-id "$ORG" --install-importer || fail=1
grep -q "injected failure" "$W/results/22-write-fails-midway.txt" || { echo "FAIL|the injected failure was not what stopped the write"; fail=1; }
left=$("${PSQL[@]}" -d "$RB" -c "select (select count(*) from customers where organization_id = '$ORG') + (select count(*) from suppliers where organization_id = '$ORG') + (select count(*) from invoices where organization_id = '$ORG') + (select count(*) from invoice_payments where organization_id = '$ORG') + (select count(*) from quotes where organization_id = '$ORG') + (select count(*) from purchase_orders where organization_id = '$ORG') + (select count(*) from credit_notes where organization_id = '$ORG') + (select count(*) from doc_counters where organization_id = '$ORG' and last > 0) + (select count(*) from jobs where organization_id = '$ORG') + (select count(*) from job_values where organization_id = '$ORG') + (select count(*) from sales_orders where organization_id = '$ORG') + (select count(*) from opening_wip where organization_id = '$ORG')")
mapn=$("${PSQL[@]}" -d "$RB" -c "select to_regclass('public.legacy_import_map') is not null")
[[ "$mapn" == t ]] && left=$((left + $("${PSQL[@]}" -d "$RB" -c "select count(*) from public.legacy_import_map")))
echo "importer tables present after the failed write: $mapn (f = even the --install-importer step was rolled back)"
[[ "$left" == 0 ]] && echo "PASS|failed write left nothing behind (0 rows in A, 0 map rows, no counters)" || { echo "FAIL|failed write left $left rows"; fail=1; }
"${PSQL[@]}" -d "$RB" -c "drop trigger rehearsal_fail on public.invoice_payments" -c "drop function public.rehearsal_fail()"
# A target without migration 136 (no public.opening_wip) refuses a write that has WIP rows; the dry run says so.
"${PSQL[@]}" -d "$RB" -c "drop table public.opening_wip"
step 22b-dry-run-no-136 "${CLI[@]}" "$W/export" "${OPTS[@]}" --out "$W/r-no136" --database-url "$RB_URL" --organization-id "$ORG" || exit 1
step 22c-write-refused-no-136 expect_fail "${CLI[@]}" "$W/export" "${OPTS[@]}" --write --report "$W/r-no136/report.json" --database-url "$RB_URL" --organization-id "$ORG" --install-importer || fail=1
grep -q "migration 136 is not applied" "$W/results/22c-write-refused-no-136.txt" || { echo "FAIL|the missing WIP table was not what refused the write"; fail=1; }

# Rollback 2 (after COMMIT): the documented way back is the backup taken before the import, restored into a new database.
"${PSQL[@]}" -d postgres -c "drop database if exists $RS" -c "create database $RS"
step 23-restore-backup pg_restore -h 127.0.0.1 -U postgres -d "$RS" --no-owner "$W/pre-import.dump" || true
rs=$("${PSQL[@]}" -d "$RS" -c "select (select count(*) from invoices where organization_id = '$ORG') || '/' || (select count(*) from customers where organization_id = '$ORG') || '/' || (select count(*) from invoices where invoice_ref = 'INV-1000') || '/' || (select count(*) from rehearsal_identity)")
[[ "$rs" == "0/0/1/1" ]] && echo "PASS|restored backup: tenant A empty again, tenant B intact, rehearsal identity kept ($rs)" || { echo "FAIL|restored backup state $rs"; fail=1; }

echo "timings (s):"; cat "$W/timings.tsv"
[[ $fail == 0 ]] && echo "REHEARSAL: all checks PASS" || echo "REHEARSAL: FAIL"
exit $fail

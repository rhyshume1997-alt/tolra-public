#!/usr/bin/env bash
# Go-live smoke, SMOKE 3-6: the one-time post-144 releases 145, 146 and 147 on the disposable database, in that order, by the same
# mechanism as ci.yml's integration step "Install one-time releases 145, 146 and 147 on the disposable database" (the preflight marker
# read from supabase/verify/release_preflight.sql, the release file through psql, the marker again, the release's own verify file with
# every row true, then a PostgREST schema reload). On this fresh database each marker must say "not applied" first: a marker already
# applied means the database is not the fresh one this job built, and that is a FAIL (a release file is never applied twice).
# Then SMOKE 6: release 147 holds every company that existed when it was installed (public.dln_numbering_pending), so the smoke
# company, made before the releases as JNR exists before them, must be held.
#
#   bash scripts/golive-smoke/install-releases.sh <smoke company slug>
set -uo pipefail
cd "$(dirname "$0")/../.."
. scripts/golive-smoke/lib.sh
load_test_env || exit 1
slug="${1:?usage: install-releases.sh <smoke company slug>}"
rc=0
n=3
for phase in "145_company_setup|company_setup_145|post-144 marker 145 company_setup" \
             "146_tolra_provided_ai|tolra_provided_ai_146|post-144 marker 146 tolra_provided_ai" \
             "147_job_delivery_note|job_delivery_note_147|post-144 marker 147 job_delivery_note"; do
  IFS='|' read -r release verify marker <<< "$phase"
  name="release-${release%%_*}"
  sum="$(sha256sum "supabase/release/${release}.release.sql" | cut -c1-16)"
  before="$(psql_q -f supabase/verify/release_preflight.sql | awk -F'|' -v m="$marker" '$1==m {print $2}')"
  if [ "$before" != "not applied" ]; then
    smoke_line "$n" "$name" FAIL "marker '$marker' before the release is '${before:-missing}', expected 'not applied' on the fresh database; nothing applied"
    rc=1; n=$((n + 1)); continue
  fi
  if ! psql_q -f "supabase/release/${release}.release.sql" > "$GOLIVE_SMOKE_DIR/${release}.log" 2>&1; then
    smoke_line "$n" "$name" FAIL "release file refused: $(grep -m1 -E 'ERROR' "$GOLIVE_SMOKE_DIR/${release}.log")"
    rc=1; n=$((n + 1)); continue
  fi
  after="$(psql_q -f supabase/verify/release_preflight.sql | awk -F'|' -v m="$marker" '$1==m {print $2}')"
  rows="$(psql_q -f "supabase/verify/${verify}.sql")"
  total="$(printf '%s\n' "$rows" | grep -c . || true)"
  good="$(printf '%s\n' "$rows" | awk -F'|' '$NF == "t"' | grep -c . || true)"
  printf '%s\n' "$rows" > "$GOLIVE_SMOKE_DIR/${verify}.verify.txt"
  if [ "$after" = "applied" ] && [ "$total" -gt 0 ] && [ "$good" = "$total" ]; then
    smoke_line "$n" "$name" PASS "marker not applied -> applied; supabase/verify/${verify}.sql $good/$total true; release sha256 ${sum}..."
  else
    smoke_line "$n" "$name" FAIL "marker after '${after:-missing}'; verify $good/$total true: $(printf '%s\n' "$rows" | awk -F'|' '$NF != "t" {print $1}' | head -3 | tr '\n' ';')"
    rc=1
  fi
  n=$((n + 1))
done
psql_q -c "NOTIFY pgrst, 'reload schema'" > /dev/null
sleep 3

# SMOKE 6: the hold. psql variables (never pasted into the SQL text) carry the slug.
held="$(psql_q -v slug="$slug" <<'SQL'
SELECT (SELECT count(*) FROM public.dln_numbering_pending p JOIN public.organizations o ON o.id = p.organization_id WHERE o.slug = :'slug')
       || '|' || (SELECT count(*) FROM public.dln_numbering_pending)
       || '|' || (SELECT count(*) FROM public.organizations)
       || '|' || coalesce((SELECT last::text FROM public.doc_counters d JOIN public.organizations o ON o.id = d.organization_id WHERE o.slug = :'slug' AND d.prefix = 'DLN'), 'none');
SQL
)"
IFS='|' read -r mine all orgs counter <<< "$held"
if [ "$mine" = 1 ] && [ "$all" = "$orgs" ]; then
  smoke_line 6 dln-hold-recorded PASS "release 147 holds the smoke company (held $all of $orgs companies, every company present at install); its DLN counter: $counter"
else
  smoke_line 6 dln-hold-recorded FAIL "smoke company held: $mine; held $all of $orgs companies"
  rc=1
fi
exit "$rc"

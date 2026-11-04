#!/usr/bin/env bash
# Read-only. Prints the SCHEMA MARKER block for releases 138, 144, 145, 146 on the disposable database, straight from the
# real release preflight rows, and runs each verify file (every row must be t). A line is printed only when the marker
# query returned "applied"; otherwise the script exits 1. Loopback database only.
set -euo pipefail
set -a; . ./.env.test.local; set +a
case "$TEST_DATABASE_URL" in postgresql://*@127.0.0.1:*) ;; *) echo "Refusing: not the local disposable database" >&2; exit 1 ;; esac
psql_q() { psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -X -At -F '|' "$@"; }
pre="$(psql_q -f supabase/verify/release_preflight.sql)"
echo "SCHEMA MARKER (read from release_preflight.sql and the verify files just now)"
for row in "marker 138 chase steps|chase_steps_138|138 chase steps applied" "marker 144 accounting connections|accounting_connections_144|144 accounting connections applied" \
           "post-144 marker 145 company_setup|company_setup_145|145 company_setup applied" "post-144 marker 146 tolra_provided_ai|tolra_provided_ai_146|146 tolra_provided_ai applied"; do
  IFS='|' read -r marker verify label <<< "$row"
  line="$(printf '%s\n' "$pre" | awk -F'|' -v m="$marker" '$1==m')"
  state="$(printf '%s\n' "$line" | awk -F'|' '{print $2}')"
  [ "$state" = "applied" ] || { echo "FAIL marker '$marker' is '${state:-missing}', not applied" >&2; exit 1; }
  rows="$(psql_q -f "supabase/verify/${verify}.sql")"
  [ -n "$rows" ] || { echo "FAIL ${verify}.sql returned no rows" >&2; exit 1; }
  if printf '%s\n' "$rows" | awk -F'|' '$NF != "t" {bad=1} END {exit !bad}'; then echo "FAIL ${verify}.sql has a row that is not t" >&2; printf '%s\n' "$rows" >&2; exit 1; fi
  echo "  ${label}   [preflight row: ${line}] [verify rows all t: $(printf '%s\n' "$rows" | wc -l)]"
done

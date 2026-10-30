#!/usr/bin/env bash
# Migration 115 proof: applies 115 to a COPY of a database that has 000..101 (template, default sec_base), runs
# tests/scripts/browser-error-alert-115.proof.sql, and checks the proof really bites:
#   MUTATE budget  : the person budget (5) raised to 500 in the function -> the proof must FAIL.
#   MUTATE shared  : browser claims counted in the server's table (the original finding) -> the proof must FAIL.
# Needs a local PostgreSQL (PGHOST/PGUSER/PGPASSWORD as for psql). Not part of CI (CI has no stand-in template; tests/db covers 115 there).
#   PGPASSWORD=localonly PGHOST=127.0.0.1 PGUSER=postgres bash tests/scripts/browser-error-alert-115.test.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
TEMPLATE="${TEMPLATE:-sec_base}"
DB="${DB:-s7_alert}"
RELEASE=supabase/release/115_browser_error_alert_budget.release.sql
PROOF=tests/scripts/browser-error-alert-115.proof.sql
P=(psql -X -q -v ON_ERROR_STOP=1 -d)

fresh() { psql -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $TEMPLATE" >/dev/null; }
fail=0

echo "== 1. real migration: proof must pass"
fresh
"${P[@]}" "$DB" -f "$RELEASE" >/dev/null || { echo "release failed"; exit 1; }
if "${P[@]}" "$DB" -f "$PROOF" 2>&1 | grep -q 'PROOF OK'; then echo "PASS"; else echo "FAIL: proof did not pass on the real migration"; fail=1; fi

mutate() { # name, sed expression
  echo "== mutation: $1 (proof must FAIL)"
  fresh
  sed -E "$2" "$RELEASE" > "/tmp/115-mutant-$$.sql"
  if cmp -s "$RELEASE" "/tmp/115-mutant-$$.sql"; then echo "FAIL: mutation did not change the file"; fail=1; return; fi
  "${P[@]}" "$DB" -f "/tmp/115-mutant-$$.sql" >/dev/null || { echo "FAIL: mutant did not apply"; fail=1; return; }
  if "${P[@]}" "$DB" -f "$PROOF" >/tmp/115-mutant-out-$$.txt 2>&1 && grep -q 'PROOF OK' /tmp/115-mutant-out-$$.txt; then echo "FAIL: proof passed on the mutant"; fail=1
  else echo "PASS (proof failed as it should: $(grep -m1 'PROOF FAILED' /tmp/115-mutant-out-$$.txt | sed 's/.*PROOF FAILED/PROOF FAILED/'))"; fi
  rm -f "/tmp/115-mutant-$$.sql" "/tmp/115-mutant-out-$$.txt"
}
mutate "person budget 5 -> 500" 's/WHERE user_id = p_user_id AND claimed_at > now\(\) - INTERVAL .1 day.\) >= 5 THEN/WHERE user_id = p_user_id AND claimed_at > now() - INTERVAL '"'"'1 day'"'"') >= 500 THEN/'
mutate "company budget 10 -> 1000" 's/>= 10 THEN/>= 1000 THEN/'
mutate "platform browser budget 20 -> 2000" 's/WHERE claimed_at > now\(\) - INTERVAL .1 day.\) >= 20 THEN/WHERE claimed_at > now() - INTERVAL '"'"'1 day'"'"') >= 2000 THEN/'
mutate "no per-fingerprint dedupe" 's/fingerprint = p_fingerprint AND claimed_at/fingerprint = repeat('"'"'f'"'"', 12) AND claimed_at/'
mutate "browser claims written to the server table (the original finding)" 's/INSERT INTO security_audit.browser_error_alerts \(fingerprint, user_id, company_id\) VALUES \(p_fingerprint, p_user_id, p_company_id\);/INSERT INTO security_audit.error_alerts (fingerprint) VALUES (p_fingerprint);/'

fresh; psql -X -q -d postgres -c "drop database if exists $DB" >/dev/null
[ "$fail" = 0 ] && echo "ALL OK" || { echo "SOME FAILED"; exit 1; }

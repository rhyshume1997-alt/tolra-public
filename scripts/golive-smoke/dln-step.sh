#!/usr/bin/env bash
# The cutover-day DLN counter step (supabase/cutover, at the candidate), run on the disposable database exactly as the operator and
# the verifier run it on the day (docs C16-17a: psql with -v company_slug and -v last_pad_number, the files unchanged). Called by
# the browser walk (tests/e2e/golive-smoke/walk.smoke.ts) between "creation refused before the step" and "allowed after".
#
#   bash scripts/golive-smoke/dln-step.sh set    <slug> <last pad number>   # set_dln_next_number.sql; psql's exit code; its output
#   bash scripts/golive-smoke/dln-step.sh verify <slug> <last pad number>   # verify_dln_next_number.sql; rows "check|value|PASS/FAIL"
#
# Loopback database only (TEST_DATABASE_URL from .env.test.local, refused otherwise).
set -uo pipefail
cd "$(dirname "$0")/../.."
. scripts/golive-smoke/lib.sh
load_test_env || exit 2
mode="${1:?usage: dln-step.sh set|verify <slug> <last pad number>}"; slug="${2:?slug}"; last="${3:?last pad number}"
case "$mode" in
  set)
    psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v company_slug="$slug" -v last_pad_number="$last" \
      -f supabase/cutover/set_dln_next_number.sql 2>&1
    ;;
  verify)
    psql "$TEST_DATABASE_URL" -X -At -F '|' -v company_slug="$slug" -v last_pad_number="$last" \
      -f supabase/cutover/verify_dln_next_number.sql 2>&1
    ;;
  *) echo "usage: dln-step.sh set|verify <slug> <last pad number>" >&2; exit 2 ;;
esac

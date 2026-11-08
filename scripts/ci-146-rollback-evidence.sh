#!/usr/bin/env bash
# Informational evidence for 146: after a rollback is accepted, is a reinstall refused? Prints exactly one status word:
#   PASS       rollback accepted AND reinstall refused with the EXPECTED refusal: the retained key_source column (SQLSTATE 42701,
#              'column "key_source" of relation "ai_helper_requests" already exists', 146 release line 37)
#   FAIL       rollback accepted AND reinstall accepted            (exit 1)
#   NOT-PROVEN anything else (rollback refused, reinstall failed with no ERROR line, or failed with any OTHER error): the expected refusal was not shown (exit 0)
# Usage: ci-146-rollback-evidence.sh <evidence-dir>   (needs TEST_DATABASE_URL and psql on PATH; run from the repo root)
set -u
dir="${1:?evidence dir}"
mkdir -p "$dir"
reinstall=supabase/release/146_tolra_provided_ai.release.sql
if psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f supabase/release/146_tolra_provided_ai.rollback.sql > "$dir/rollback146.log" 2>&1; then
  echo "146 rollback accepted (no outstanding reservation)"
  if psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f "$reinstall" > "$dir/reinstall146.log" 2>&1; then
    echo "FAIL reinstall of 146 after rollback was ACCEPTED without a reset"
    exit 1
  fi
  err=$(grep -m1 -E 'ERROR' "$dir/reinstall146.log" || true)
  expected='column "key_source" of relation "ai_helper_requests" already exists'
  if [ -z "$err" ]; then
    echo "NOT-PROVEN reinstall failed but no ERROR line was captured"
  elif printf '%s\n' "$err" | grep -Eq "ERROR: +(42701: )?${expected}"; then
    echo "PASS reinstall of 146 after rollback was refused as expected: $err"
  else
    echo "NOT-PROVEN reinstall failed with an unexpected error (not the retained key_source column): $err"
  fi
else
  echo "NOT-PROVEN 146 rollback refused, so the reinstall was not tried: $(grep -m1 -E 'ERROR' "$dir/rollback146.log" || true)"
fi
exit 0

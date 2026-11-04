#!/usr/bin/env bash
# Records and checks the SHAs of the go-live smoke, offline (no network), as scripts/money-parity/shas.sh did for its one-off:
#   * the candidate under test 31f965e7f0cbb2d9caf336b0a2067411bec8fb45 (draft PR #359, branch claude/delivery-notes-golive) must be an
#     ancestor of HEAD, and lib, app, components, supabase (and the package files, middleware, next config, tests/support,
#     tests/e2e/helpers.ts, global-setup.ts, paths.ts, playwright.config.ts) must equal it byte for byte, in the commit and the working tree;
#   * every other difference from the candidate must be an ADDED file of this smoke (its workflow, scripts, specs, configs, runbook).
#
#   bash scripts/golive-smoke/shas.sh        (prints "SHA check PASSED" or exits 1)
set -euo pipefail
cd "$(dirname "$0")/../.."
CANDIDATE=31f965e7f0cbb2d9caf336b0a2067411bec8fb45
ADDED_RE='^(\.github/workflows/golive-smoke\.yml|scripts/golive-smoke/.+|tests/e2e/golive-smoke/.+|docs/handover/GOLIVE-SMOKE-RUNBOOK\.md|playwright\.golive-smoke\.config\.ts|vitest\.golive-smoke\.config\.ts)$'
PROTECTED=(lib app components supabase package.json package-lock.json middleware.ts next.config.mjs tests/support
           tests/e2e/helpers.ts tests/e2e/global-setup.ts tests/e2e/paths.ts playwright.config.ts)
fail=0
git cat-file -e "$CANDIDATE^{commit}" || { echo "FAIL candidate $CANDIDATE is not in this checkout (fetch-depth 0 needed)"; exit 1; }
git merge-base --is-ancestor "$CANDIDATE" HEAD || { echo "FAIL candidate $CANDIDATE is not an ancestor of HEAD"; exit 1; }
echo "candidate (app tree under test): $CANDIDATE"
echo "branch head: $(git rev-parse HEAD)"
for t in lib app components supabase; do
  echo "tree $t: candidate $(git rev-parse "$CANDIDATE:$t")  HEAD $(git rev-parse "HEAD:$t")"
done
if ! git diff --quiet "$CANDIDATE" HEAD -- "${PROTECTED[@]}"; then
  echo "FAIL the app tree differs from the candidate:"; git diff --stat "$CANDIDATE" HEAD -- "${PROTECTED[@]}"; fail=1
else
  echo "PASS lib app components supabase (and package files, middleware, next config, tests/support, e2e helpers and config): identical to $CANDIDATE"
fi
if ! git diff --quiet HEAD -- "${PROTECTED[@]}"; then echo "FAIL the working tree differs from HEAD in the app tree"; fail=1; fi
added=0
while IFS=$'\t' read -r status path; do
  [ -n "$status" ] || continue
  if [ "$status" != "A" ]; then echo "FAIL not an addition: $status $path"; fail=1; continue; fi
  if ! [[ "$path" =~ $ADDED_RE ]]; then echo "FAIL $path is added outside the smoke's own files"; fail=1; continue; fi
  added=$((added + 1))
done < <(git diff --name-status --no-renames "$CANDIDATE" HEAD)
echo "files added by this smoke: $added (all additions, all under its own paths)"
[ "$fail" = 0 ] || { echo "SHA check FAILED"; exit 1; }
echo "PASS every difference from the candidate is an added smoke file"
echo "SHA check PASSED"

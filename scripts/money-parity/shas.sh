#!/usr/bin/env bash
# Records and checks the three SHAs of the one-off money parity proof, offline (no network):
#   * the candidate under test: 9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8 must be an ancestor of HEAD, and lib, supabase, app,
#     components (and package.json, package-lock.json, vitest.db.config.ts, tests/support) must equal it byte for byte;
#   * the branch head (HEAD);
#   * the draft PR #284 head d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d the test was taken from: the copied files' git blob ids
#     and sha256 must equal the values recorded here from that commit.
# Anything else that differs from the candidate must be one of the files this one-off adds.
set -euo pipefail
cd "$(dirname "$0")/../.."
CANDIDATE=9c3f5c6cf51cfb3c41b1fe23fe532b5ddb5254a8
PR284_HEAD=d7d6ff9dbd915becdc096d1eb365e4a73b4ae21d
# path  git-blob-id-at-PR284_HEAD  sha256
FROM_284=(
  "tests/db/money-rounding-parity.test.ts 9b3ea9bc53f4bb4326a42b7d9ac3031da0251ad8 548aeaf0d5587f60c182de0f86633e72cf50f01aa47fe39d0374c4049a9ca495"
  "tests/fixtures/money-rounding-cases.ts 8bd79d140d4fcb7736d49332d1dbdf4451a3d284 835cd867d745bc539641bcc74c4a9dddbcd780a51ac6740b69b59c69a0206af7"
)
ADDED=(
  .github/workflows/money-parity.yml
  scripts/money-parity/gate.mjs
  scripts/money-parity/run.sh
  scripts/money-parity/shas.sh
  tests/db/money-parity-ties.test.ts
  tests/db/money-rounding-parity.test.ts
  tests/fixtures/money-rounding-cases.ts
)
fail=0
git cat-file -e "$CANDIDATE^{commit}" || { echo "FAIL candidate $CANDIDATE is not in this checkout"; exit 1; }
git merge-base --is-ancestor "$CANDIDATE" HEAD || { echo "FAIL candidate $CANDIDATE is not an ancestor of HEAD"; exit 1; }
echo "candidate (app tree under test): $CANDIDATE"
echo "branch head: $(git rev-parse HEAD)"
echo "test source: draft PR #284 head $PR284_HEAD"
echo "candidate tree lib: $(git rev-parse "$CANDIDATE:lib")  HEAD tree lib: $(git rev-parse HEAD:lib)"
echo "candidate tree supabase: $(git rev-parse "$CANDIDATE:supabase")  HEAD tree supabase: $(git rev-parse HEAD:supabase)"
echo "lib/money.ts blob: $(git rev-parse HEAD:lib/money.ts) (candidate $(git rev-parse "$CANDIDATE:lib/money.ts"))"

PROTECTED=(lib supabase app components package.json package-lock.json vitest.db.config.ts tests/support)
if ! git diff --quiet "$CANDIDATE" -- "${PROTECTED[@]}"; then
  echo "FAIL the app tree differs from the candidate:"; git diff --stat "$CANDIDATE" -- "${PROTECTED[@]}"; fail=1
else
  echo "PASS lib supabase app components package files vitest.db.config.ts tests/support: identical to $CANDIDATE"
fi
# The working tree too (nothing generated on the runner may stand in for a candidate file).
if ! git diff --quiet HEAD -- "${PROTECTED[@]}"; then echo "FAIL the working tree differs from HEAD in the app tree"; fail=1; fi

while IFS= read -r path; do
  printf '%s\n' "${ADDED[@]}" | grep -qxF -- "$path" || { echo "FAIL $path differs from the candidate but is not one of this one-off's added files"; fail=1; }
done < <(git diff --name-only --no-renames "$CANDIDATE" HEAD)
while IFS= read -r line; do
  [[ "${line:0:1}" == "A" ]] || { echo "FAIL not an addition: $line"; fail=1; }
done < <(git diff --name-status --no-renames "$CANDIDATE" HEAD)

for entry in "${FROM_284[@]}"; do
  read -r path blob sum <<< "$entry"
  got_blob="$(git hash-object -- "$path")"; got_sum="$(sha256sum -- "$path" | cut -d' ' -f1)"
  if [[ "$got_blob" == "$blob" && "$got_sum" == "$sum" && "$(git rev-parse "HEAD:$path")" == "$blob" ]]; then
    echo "PASS $path = PR #284 $PR284_HEAD blob $blob sha256 $sum"
  else
    echo "FAIL $path: blob $got_blob sha256 $got_sum, expected PR #284 blob $blob sha256 $sum"; fail=1
  fi
done
[[ "$fail" == 0 ]] || { echo "SHA check FAILED"; exit 1; }
echo "SHA check PASSED"

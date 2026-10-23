#!/usr/bin/env bash
# Backup consistency drill on synthetic data only (audit A1). No hosted project, no cost. Docker required.
#
#   scripts/backup-consistency-drill.sh
#
# Source: the local test stack (scripts/test-backend.sh start). Target: a second, EMPTY local stack (ports 553xx)
# created here and deleted afterwards. While scripts/backup-run.sh runs, a writer keeps inserting and updating
# synthetic rows (customers, and the audit rows their triggers write) on the source, and during the Storage copy one
# file is replaced, one deleted and one added (the added one isn't in the snapshot, so on its own it would not need a
# retry; the replace and delete do). The backup must either be consistent, which means it restores with
# every row count, table fingerprint, money total and file checksum matching (scripts/restore-backup.sh), or fail
# explicitly and publish nothing:
#   1. one change during the copy: the attempt is thrown away and retried; the retried backup restores consistently,
#      with the replaced file's new content, without the deleted file;
#   2. files that keep changing on every attempt: the backup fails and leaves nothing behind;
#   3. a file only ADDED during the copy: no retry (that snapshot doesn't reference it) and the backup succeeds.
set -euo pipefail
cd "$(dirname "$0")/.."
SUPABASE="${SUPABASE_BIN:-supabase}"
EXCLUDE="studio,realtime,edge-runtime,logflare,vector,imgproxy,supavisor,postgres-meta"
[[ -f .env.test.local ]] || { echo "Start the local test stack first: scripts/test-backend.sh start" >&2; exit 1; }
# shellcheck disable=SC1091
source .env.test.local
for value in "$TEST_SUPABASE_URL" "$TEST_DATABASE_URL"; do
  case "$value" in http://127.0.0.1:*|postgresql://*@127.0.0.1:*) ;; *) echo "Refusing: $value is not local" >&2; exit 1 ;; esac
done

WORK="$(mktemp -d)"
TARGET="$WORK/target"
mkdir -p "$TARGET/supabase" "$WORK/out" "$WORK/bad" "$WORK/added"
WRITER=""
cleanup() {
  [[ -n "$WRITER" ]] && kill "$WRITER" 2>/dev/null || true
  (cd "$TARGET" && "$SUPABASE" stop --no-backup > /dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "[target] new empty local project on ports 553xx"
sed -e 's/^project_id = .*/project_id = "tolra-consistency-drill"/' -e 's/= 543\([0-9][0-9]\)$/= 553\1/' supabase/config.toml > "$TARGET/supabase/config.toml"
(cd "$TARGET" && "$SUPABASE" start -x "$EXCLUDE" > /dev/null)
eval "$(cd "$TARGET" && "$SUPABASE" status -o env 2>/dev/null | sed 's/^/TARGET_/')"
case "$TARGET_API_URL $TARGET_DB_URL" in http://127.0.0.1:553*" postgresql://"*@127.0.0.1:553*) ;; *) echo "Refusing: unexpected target $TARGET_API_URL" >&2; exit 1 ;; esac

echo "[seed] synthetic user, drawing and quote attachment on the source"
node scripts/backup-drill.mjs seed "$TEST_SUPABASE_URL" "$TEST_SUPABASE_SERVICE_ROLE_KEY" "$WORK/state.json"
DRAWING="$(jq -r '.files[0].name' "$WORK/state.json")"
ATTACHMENT="$(jq -r '.files[1].name' "$WORK/state.json")"
TAG="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
ORG="$(psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -Atc \
  "insert into public.organizations(name, slug) values ('Consistency drill $TAG', 't-consistency-drill-$TAG') returning id")"

echo "[writer] synthetic inserts and updates on the source for as long as the backup runs"
(
  i=0
  while :; do
    i=$((i + 1))
    psql "$TEST_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c \
      "insert into public.customers(organization_id, name) values ('$ORG', 'Drill customer $TAG $i');
       update public.customers set notes = 'changed ' || clock_timestamp() where organization_id = '$ORG' and name = 'Drill customer $TAG ' || greatest($i - 1, 1);" \
      > /dev/null 2>&1 || true
    sleep 0.05
  done
) &
WRITER=$!

store() {  # store <method> <bucket/path> [file]   (local source only)
  local method="$1" object="$2" file="${3:-}"
  local path; path="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$object")"
  curl -fsS -X "$method" -H "Authorization: Bearer $TEST_SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $TEST_SUPABASE_SERVICE_ROLE_KEY" \
    ${file:+-H "x-upsert: true" -H "Content-Type: application/pdf" --data-binary "@$file"} \
    "$TEST_SUPABASE_URL/storage/v1/object/$path" > /dev/null
}
export -f store
export TEST_SUPABASE_URL TEST_SUPABASE_SERVICE_ROLE_KEY
printf 'REPLACED DRAWING %s\n' "$TAG" > "$WORK/replacement.bin"
printf 'ADDED DURING THE COPY %s\n' "$TAG" > "$WORK/added.bin"

PASSPHRASE="drill-$(head -c 12 /dev/urandom | base64)"
run_backup() {  # run_backup <out dir> <hook>
  BACKUP_DB_URL="$TEST_DATABASE_URL" BACKUP_PASSPHRASE="$PASSPHRASE" BACKUP_SUPABASE_URL="$TEST_SUPABASE_URL" \
    BACKUP_SERVICE_KEY="$TEST_SUPABASE_SERVICE_ROLE_KEY" BACKUP_RETRY_DELAY=1 BACKUP_TEST_DURING_COPY="$2" \
    scripts/backup-run.sh "$1"
}

echo "[case 2] files that change on every attempt: the backup must fail and publish nothing"
if BACKUP_ATTEMPTS=2 run_backup "$WORK/bad" "set -e; store POST 'job-drawings/$DRAWING' '$WORK/replacement.bin'; printf 'x%s' \$RANDOM >> '$WORK/replacement.bin'" > "$WORK/bad.log" 2>&1; then
  echo "[FAIL] the backup succeeded although stored files changed on every attempt" >&2; exit 1
fi
grep -q "kept changing" "$WORK/bad.log" || { echo "[FAIL] the backup failed, but not for the changing files:" >&2; tail -5 "$WORK/bad.log" >&2; exit 1; }
[[ -z "$(ls "$WORK/bad")" ]] || { echo "[FAIL] a failed backup left a file behind" >&2; exit 1; }
echo "         refused: $(grep "kept changing" "$WORK/bad.log")"
printf 'REPLACED DRAWING %s\n' "$TAG" > "$WORK/replacement.bin"

echo "[case 3] a file only added during the copy: no retry, the backup succeeds"
run_backup "$WORK/added" "set -e; store POST 'quote-attachments/drill-only-added-$TAG.pdf' '$WORK/added.bin'" > "$WORK/added.log" 2>&1 \
  || { echo "[FAIL] the backup failed when a file was only added during the copy:" >&2; tail -5 "$WORK/added.log" >&2; exit 1; }
if grep -q "^\[retry\]" "$WORK/added.log"; then echo "[FAIL] a file added after the snapshot triggered a retry" >&2; exit 1; fi
ls "$WORK"/added/tolra-backup-*.tar.gz.gpg > /dev/null
echo "         no retry; backup published"

echo "[case 1] one replace, one delete and one add during the copy, rows changing throughout"
HOOK="set -e; [ -e '$WORK/hook-ran' ] || { touch '$WORK/hook-ran';
  store POST 'job-drawings/$DRAWING' '$WORK/replacement.bin';
  store DELETE 'quote-attachments/$ATTACHMENT';
  store POST 'quote-attachments/drill-added-$TAG.pdf' '$WORK/added.bin'; }"
run_backup "$WORK/out" "$HOOK" | tee "$WORK/backup.log"
grep -q "^\[retry\]" "$WORK/backup.log" || { echo "[FAIL] the change during the copy wasn't detected (no retry)" >&2; exit 1; }
kill "$WRITER" 2>/dev/null || true; WRITER=""
FILE="$(ls "$WORK"/out/tolra-backup-*.tar.gz.gpg)"

echo "[restore] into the empty target: every count, fingerprint, money total and file checksum must match"
RESTORE_DB_URL="$TARGET_DB_URL" BACKUP_PASSPHRASE="$PASSPHRASE" PROTECTED_REFS="qngvemzbdsvtydkbplpo qtgqliczvyyrkibvxfqv" \
  RESTORE_SUPABASE_URL="$TARGET_API_URL" RESTORE_SERVICE_KEY="$TARGET_SERVICE_ROLE_KEY" REQUIRE_FINGERPRINTS=1 \
  scripts/restore-backup.sh "$FILE"

echo "[verify] the restored files are the retried snapshot's: new drawing, no deleted attachment"
fetch() { curl -fsS -H "Authorization: Bearer $TARGET_SERVICE_ROLE_KEY" -H "apikey: $TARGET_SERVICE_ROLE_KEY" \
  "$TARGET_API_URL/storage/v1/object/$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1")"; }
cmp -s <(fetch "job-drawings/$DRAWING") "$WORK/replacement.bin" || { echo "[FAIL] the restored drawing isn't the replaced version" >&2; exit 1; }
if fetch "quote-attachments/$ATTACHMENT" > /dev/null 2>&1; then echo "[FAIL] the deleted attachment came back" >&2; exit 1; fi
restored="$(psql "$TARGET_DB_URL" -X -Atc "select count(*) from public.customers where organization_id = '$ORG'")"
[[ "$restored" -gt 0 ]] || { echo "[FAIL] none of the writer's rows were in the backup" >&2; exit 1; }
echo "         $restored of the writer's customers restored, consistent with the snapshot"
echo "[drill ok]"

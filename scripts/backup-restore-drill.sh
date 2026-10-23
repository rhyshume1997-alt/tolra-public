#!/usr/bin/env bash
# Backup and restore drill on synthetic data only (audit L4). No hosted project, no cost. Docker required.
#
#   scripts/backup-restore-drill.sh
#
# Source: the local test stack (scripts/test-backend.sh start). Target: a second, EMPTY local stack (ports 553xx)
# created here and deleted afterwards. Seeds a synthetic user, a drawing (PDF) and a quote attachment (PNG) on the
# source, runs scripts/backup-run.sh (encrypted), restores it with scripts/restore-backup.sh into the target
# (PROTECTED_REFS set as in production), then opens the restored drawing and attachment, compares them byte for byte
# and signs the restored user in. Fails on any difference.
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
mkdir -p "$TARGET" "$WORK/out"
stop_target() { (cd "$TARGET" && "$SUPABASE" stop --no-backup > /dev/null 2>&1) || true; rm -rf "$WORK"; }
trap stop_target EXIT

echo "[target] new empty local project on ports 553xx"
# The repo's own stack settings (same service versions as the source), other ports, no migrations: an empty project.
mkdir -p "$TARGET/supabase"
sed -e 's/^project_id = .*/project_id = "tolra-restore-drill"/' -e 's/= 543\([0-9][0-9]\)$/= 553\1/' supabase/config.toml > "$TARGET/supabase/config.toml"
(cd "$TARGET" && "$SUPABASE" start -x "$EXCLUDE" > /dev/null)
eval "$(cd "$TARGET" && "$SUPABASE" status -o env 2>/dev/null | sed 's/^/TARGET_/')"
case "$TARGET_API_URL $TARGET_DB_URL" in http://127.0.0.1:553*" postgresql://"*@127.0.0.1:553*) ;; *) echo "Refusing: unexpected target $TARGET_API_URL" >&2; exit 1 ;; esac

echo "[seed] synthetic user, drawing and quote attachment on the source"
node scripts/backup-drill.mjs seed "$TEST_SUPABASE_URL" "$TEST_SUPABASE_SERVICE_ROLE_KEY" "$WORK/state.json"

PASSPHRASE="drill-$(head -c 12 /dev/urandom | base64)"
echo "[negative] a backup that can't fetch every stored file must fail"
expect_fail() {
  local why="$1"; shift
  if env "$@" scripts/backup-run.sh "$WORK/bad" > "$WORK/bad.log" 2>&1; then echo "[FAIL] backup succeeded $why" >&2; exit 1; fi
  grep -Eq "storage|BACKUP_SUPABASE_URL" "$WORK/bad.log" || { echo "[FAIL] backup failed $why, but not on storage or its credentials:" >&2; tail -5 "$WORK/bad.log" >&2; exit 1; }
  [[ -z "$(ls "$WORK/bad" 2>/dev/null)" ]] || { echo "[FAIL] a failed backup left a file behind" >&2; exit 1; }
  echo "         refused $why"
}
expect_fail "without storage credentials" BACKUP_DB_URL="$TEST_DATABASE_URL" BACKUP_PASSPHRASE="$PASSPHRASE"
expect_fail "when downloads are refused" BACKUP_DB_URL="$TEST_DATABASE_URL" BACKUP_PASSPHRASE="$PASSPHRASE" \
  BACKUP_SUPABASE_URL="$TEST_SUPABASE_URL" BACKUP_SERVICE_KEY="not-a-key"

echo "[backup]"
BACKUP_DB_URL="$TEST_DATABASE_URL" BACKUP_PASSPHRASE="$PASSPHRASE" BACKUP_SUPABASE_URL="$TEST_SUPABASE_URL" \
  BACKUP_SERVICE_KEY="$TEST_SUPABASE_SERVICE_ROLE_KEY" scripts/backup-run.sh "$WORK/out"
FILE="$(ls "$WORK"/out/tolra-backup-*.tar.gz.gpg)"

echo "[versions] the backup's recorded Auth / Storage versions are accepted as restore-check reads them and match the target"
for svc in auth storage; do
  v="$(gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 --decrypt "$FILE" <<< "$PASSPHRASE" | tar -xzO --wildcards "*/$svc-version")"
  [[ "$v" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "[FAIL] backup's $svc-version is not a version: '$v'" >&2; exit 1; }
  if [[ $svc == auth ]]; then live="$(curl -fsS "$TARGET_API_URL/auth/v1/health" -H "apikey: $TARGET_ANON_KEY" | jq -r .version)"
  else live="$(curl -fsS "$TARGET_API_URL/storage/v1/version" -H "apikey: $TARGET_SERVICE_ROLE_KEY" -H "Authorization: Bearer $TARGET_SERVICE_ROLE_KEY" | tr -d '[:space:]')"; fi
  [[ "v${v#v}" == "v${live#v}" ]] || { echo "[FAIL] backup records $svc $v but the target runs $live" >&2; exit 1; }
  echo "         $svc $v = target"
done

echo "[restore]"
RESTORE_DB_URL="$TARGET_DB_URL" BACKUP_PASSPHRASE="$PASSPHRASE" PROTECTED_REFS="qngvemzbdsvtydkbplpo qtgqliczvyyrkibvxfqv" \
  RESTORE_SUPABASE_URL="$TARGET_API_URL" RESTORE_SERVICE_KEY="$TARGET_SERVICE_ROLE_KEY" scripts/restore-backup.sh "$FILE"

echo "[verify] on the restored project"
node scripts/backup-drill.mjs verify "$TARGET_API_URL" "$TARGET_ANON_KEY" "$TARGET_SERVICE_ROLE_KEY" "$WORK/state.json"
echo "[drill ok]"

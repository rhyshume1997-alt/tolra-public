#!/usr/bin/env bash
# Behavioural tests for scripts/backup-run.sh. No database, no Docker, no network beyond 127.0.0.1: psql, the supabase
# CLI and docker are stubs (tests/scripts/fixtures/backup-stubs, an empty database), and the Auth / Storage version
# endpoints are a tiny local HTTP server (tests/scripts/fixtures/version-stub.py).  Run: bash tests/scripts/backup-run.test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
FIX="$PWD/tests/scripts/fixtures"
T="$(mktemp -d)"; SRV=""
trap '[[ -z "$SRV" ]] || kill "$SRV" 2>/dev/null; rm -rf "$T"' EXIT
fail=0
ok()  { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
KEY="test-service-key"; PASS="test-passphrase"; export STUB_KEY="$KEY"

serve() {   # <mode>: starts the version stub, sets URL
  [[ -z "$SRV" ]] || { kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; }
  rm -f "$T/port"; python3 -I "$FIX/version-stub.py" "$1" "$T/port" & SRV=$!
  for _ in $(seq 1 50); do [[ -s "$T/port" ]] && break; sleep 0.1; done
  URL="http://127.0.0.1:$(cat "$T/port")"
}
run() {     # <out dir> [VAR=value ...]: runs backup-run.sh with the stubs; log in $T/log, status in $STATUS
  local out="$1"; shift
  set +e
  local unset_args=(); if [[ "${1:-}" == -u ]]; then unset_args=(-u "$2"); shift 2; fi
  env PATH="$FIX/backup-stubs:$PATH" BACKUP_DB_URL="postgresql://stub@127.0.0.1:1/postgres" BACKUP_PASSPHRASE="$PASS" \
    BACKUP_SUPABASE_URL="$URL" BACKUP_SERVICE_KEY="$KEY" BACKUP_ATTEMPTS=1 "$@" \
    env "${unset_args[@]}" scripts/backup-run.sh "$out" > "$T/log" 2>&1
  STATUS=$?; set -e
}
no_success() {   # <case>: non-zero exit, no success line, nothing published
  [[ "$STATUS" != 0 ]] && ok "$1: exits non-zero ($STATUS)" || bad "$1: exited 0"
  ! grep -q '\[done\]' "$T/log" && ok "$1: no [done] line" || bad "$1: printed [done]"
  [[ -z "$(ls "$2" 2>/dev/null)" ]] && ok "$1: no archive left in the output dir" || bad "$1: archive was written"
}

# (a) empty storage + valid version metadata: success; the encrypted archive holds both version files, valid.
serve ok; run "$T/a"
[[ "$STATUS" == 0 ]] && ok "(a) empty storage, valid versions: exits 0" || { bad "(a) exited $STATUS"; cat "$T/log"; }
grep -q '^\[done\]' "$T/log" && ok "(a) prints [done]" || bad "(a) no [done] line"
grep -q 'Auth v2.180.0, Storage 1.28.2' "$T/log" && ok "(a) logs the recorded versions" || bad "(a) versions not logged"
F="$(ls "$T"/a/tolra-backup-*.tar.gz.gpg 2>/dev/null | head -1 || true)"
if [[ -n "$F" ]]; then
  ok "(a) encrypted archive written"
  (cd "$T/a" && sha256sum -c "$(basename "$F").sha256" > /dev/null) && ok "(a) .sha256 matches" || bad "(a) .sha256 mismatch"
  mkdir "$T/x"; gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 --decrypt "$F" <<< "$PASS" | tar -C "$T/x" -xz
  D="$(echo "$T"/x/tolra-backup-*)"
  [[ "$(cat "$D/auth-version")" == "v2.180.0" ]] && ok "(a) archive auth-version = v2.180.0" || bad "(a) auth-version: '$(cat "$D/auth-version" 2>/dev/null)'"
  [[ "$(cat "$D/storage-version")" == "1.28.2" ]] && ok "(a) archive storage-version = 1.28.2" || bad "(a) storage-version: '$(cat "$D/storage-version" 2>/dev/null)'"
  for svc in auth storage; do
    grep -Eqx 'v?[0-9]+\.[0-9]+\.[0-9]+' "$D/$svc-version" && ok "(a) $svc-version is a valid version (restore-check's pattern)" || bad "(a) $svc-version invalid"
  done
  [[ -s "$D/data.sql" && -s "$D/schema.sql" && -e "$D/storage/files.tsv" && ! -s "$D/storage/files.tsv" ]] \
    && ok "(a) schema.sql, data.sql present; no stored files" || bad "(a) archive layout"
else bad "(a) no archive"; fi

# (b) missing BACKUP_SUPABASE_URL / BACKUP_SERVICE_KEY (unset, and set but empty).
for v in BACKUP_SUPABASE_URL BACKUP_SERVICE_KEY; do
  for how in unset empty; do
    rm -rf "$T/b"
    if [[ $how == unset ]]; then run "$T/b" -u "$v"; else run "$T/b" "$v="; fi
    no_success "(b) $v $how" "$T/b"
    grep -q "$v is not set" "$T/log" && ok "(b) $v $how: error names $v" || bad "(b) $v $how: error doesn't name it"
  done
done

# (c) version request fails: HTTP 500; unreachable; wrong key (401).
serve http500; rm -rf "$T/c1"; run "$T/c1"; no_success "(c) HTTP 500" "$T/c1"
URL="http://127.0.0.1:9"; rm -rf "$T/c2"; run "$T/c2"; no_success "(c) unreachable" "$T/c2"
serve ok; rm -rf "$T/c3"; run "$T/c3" BACKUP_SERVICE_KEY=wrong-key; no_success "(c) rejected key (401)" "$T/c3"

# (d) malformed version response: not JSON, JSON without a version, malformed storage version.
serve auth-malformed; rm -rf "$T/d1"; run "$T/d1"; no_success "(d) auth health is not JSON" "$T/d1"
serve no-version;     rm -rf "$T/d2"; run "$T/d2"; no_success "(d) auth health has no version" "$T/d2"
grep -q "couldn't read a valid auth version" "$T/log" && ok "(d) says which version is invalid" || bad "(d) no clear error"
serve storage-malformed; rm -rf "$T/d3"; run "$T/d3"; no_success "(d) storage version malformed" "$T/d3"
grep -q "couldn't read a valid storage version" "$T/log" && ok "(d) says which version is invalid" || bad "(d) no clear error"
exit $fail

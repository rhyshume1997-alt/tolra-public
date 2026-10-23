#!/usr/bin/env bash
# Nightly off-site backup of quoteflow-prod (run by .github/workflows/nightly-backup.yml; docs/RESTORE.md).
#
#   BACKUP_DB_URL='postgresql://...'      database connection string (session pooler, port 5432)
#   BACKUP_PASSPHRASE='...'               encryption passphrase (Rhys keeps a copy; needed to restore)
#   BACKUP_SUPABASE_URL='https://<ref>.supabase.co'  and  BACKUP_SERVICE_KEY='...'   storage files (required as soon
#                                         as any file is stored: drawings, quote attachments, logos)
#   scripts/backup-run.sh <output dir>
#
# Writes <output dir>/tolra-backup-<UTC stamp>.tar.gz.gpg (AES-256, passphrase) and a .sha256 next to it. Inside:
# roles.sql, schema.sql, data.sql (supabase db dump), counts.tsv (rows per table, checked on restore),
# fingerprints.tsv (content hash of every table and money-column totals, checked on restore),
# storage/manifest.tsv (every stored file in every bucket), storage/files/<bucket>/<path> (every one of those files:
# job-drawings, quote-attachments, org-logos, ...) and storage/files.tsv (bucket, path, size, sha256 of each file).
# A file that is listed but not downloaded, or arrives with a different size, fails the backup. Everything except
# roles.sql comes from one database snapshot; a file in that snapshot that is replaced or deleted during the copy makes
# the attempt retry (below). Files added after the snapshot don't: that backup's database doesn't reference them.
# Don't change database roles or the schema (migrations) while a backup runs: roles.sql is dumped separately, just
# before the snapshot, so a role change in between would leave it out of step with the schema and data.
# auth-version and storage-version record the Auth and Storage service versions of the project (read-only version
# lookups). They are ALWAYS written, also when no file is stored, and the backup fails if they can't be recorded
# (BACKUP_SUPABASE_URL / BACKUP_SERVICE_KEY are therefore always required) or aren't in the final archive. A test
# restore starts its target on exactly those versions, since their tables in data.sql follow them.
# Reads only: nothing is written to the database. The workflow fails (and opens a "Nightly backup failed" issue for
# the owner) on any error, including a backup that doesn't decrypt.
set -euo pipefail
: "${BACKUP_DB_URL:?BACKUP_DB_URL is not set}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is not set}"
: "${BACKUP_SUPABASE_URL:?BACKUP_SUPABASE_URL is not set (needed to record the Auth and Storage versions, even with no stored files)}"
: "${BACKUP_SERVICE_KEY:?BACKUP_SERVICE_KEY is not set (needed to record the Auth and Storage versions, even with no stored files)}"
OUT="${1:?usage: scripts/backup-run.sh <output dir>}"
mkdir -p "$OUT"
STAMP="$(date -u +%Y-%m-%dT%H%MZ)"
NAME="tolra-backup-$STAMP"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
DIR="$WORK/$NAME"
mkdir -p "$DIR/storage"
SUPABASE="${SUPABASE_BIN:-supabase}"

# One database snapshot for everything (audit A1). A read-only repeatable-read transaction is held open and its snapshot
# exported; the schema and data dumps (the CLI's own pg_dump scripts from `db dump --dry-run`, run with --snapshot in a
# locally available Supabase Postgres image whose pg_dump is at least the server's major version: see pg_image) and the
# counts, fingerprints and Storage manifest all read that one snapshot, so concurrent writes can't make
# the manifest describe a different state from the dump. Roles (pg_dumpall) can't share a snapshot; they are dumped
# first, as before. Stored files are copied over HTTP afterwards: each file's Storage row must still be the version in
# the snapshot once its copy is done (a file replaced or deleted mid-copy is detected); if anything changed, the whole
# attempt is thrown away and retried with a fresh snapshot, and after BACKUP_ATTEMPTS failed attempts the backup fails.
# Nothing is written to $OUT until an attempt is consistent.
BACKUP_ATTEMPTS="${BACKUP_ATTEMPTS:-3}"
BACKUP_RETRY_DELAY="${BACKUP_RETRY_DELAY:-20}"
CHANGED=75   # exit status of an attempt that saw the data change under it (retried); anything else is fatal

hold_snapshot() {   # starts the holding transaction; sets SNAPSHOT
  rm -f "$WORK/snap.in"; mkfifo "$WORK/snap.in"
  psql "$BACKUP_DB_URL" -X -q -At -v ON_ERROR_STOP=1 < "$WORK/snap.in" > "$WORK/snap.out" 2> "$WORK/snap.err" &
  SNAP_PID=$!
  exec 7> "$WORK/snap.in"
  printf '%s\n' "SET idle_in_transaction_session_timeout = '30min';" \
    "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;" "SELECT pg_export_snapshot();" >&7
  for _ in $(seq 1 60); do [[ -s "$WORK/snap.out" ]] && break; kill -0 "$SNAP_PID" 2>/dev/null || break; sleep 0.5; done
  SNAPSHOT="$(head -1 "$WORK/snap.out" 2>/dev/null || true)"
  [[ "$SNAPSHOT" =~ ^[0-9A-Fa-f]+-[0-9A-Fa-f]+(-[0-9]+)?$ ]] || { echo "couldn't open the backup snapshot: $(cat "$WORK/snap.err" 2>/dev/null)" >&2; exit 1; }
}
release_snapshot() {
  { echo "COMMIT;" >&7; } 2>/dev/null || true
  { exec 7>&-; } 2>/dev/null || true   # (not `exec 7>&- 2>/dev/null`: that would silence stderr for the rest of the attempt)
  wait "$SNAP_PID" 2>/dev/null || true
}
in_snapshot() {     # psql inside the snapshot; extra args are -f / -c items
  psql "$BACKUP_DB_URL" -X -q -v ON_ERROR_STOP=1 -AtF $'\t' \
    -c "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY" -c "SET TRANSACTION SNAPSHOT '$SNAPSHOT'" "$@" -c "COMMIT"
}
# A compatible image, not necessarily the exact one the CLI would pick: the first local supabase/postgres image
# (normally the one the roles dump just pulled; BACKUP_PG_IMAGE overrides) whose pg_dump major version is >= the server's.
pg_image() {
  local server image
  server="$(psql "$BACKUP_DB_URL" -X -Atc "show server_version_num")"
  for image in ${BACKUP_PG_IMAGE:-} $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)supabase/postgres:' || true); do
    local major; major="$(docker run --rm --entrypoint pg_dump "$image" --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
    [[ -n "$major" && "$major" -ge $(( server / 10000 )) ]] && { echo "$image"; return; }
  done
  echo "no Postgres image with pg_dump >= $(( server / 10000 )) found (the CLI pulls one for 'db dump')" >&2; exit 1
}
dump_in_snapshot() {  # <output file> <supabase db dump flags...>
  local out="$1"; shift
  "$SUPABASE" db dump --db-url "$BACKUP_DB_URL" --dry-run "$@" 2>/dev/null | sed -n '/^#!\/usr\/bin\/env bash/,$p' > "$WORK/dump.sh"
  [[ "$(grep -c '^pg_dump \\$' "$WORK/dump.sh")" == 1 ]] || { echo "unexpected dump script from the Supabase CLI" >&2; exit 1; }
  sed -i 's/^pg_dump \\$/pg_dump --snapshot "$BACKUP_SNAPSHOT" \\/' "$WORK/dump.sh"
  docker run --rm -i --network host --entrypoint bash -e BACKUP_SNAPSHOT="$SNAPSHOT" "$PG_IMAGE" -s < "$WORK/dump.sh" > "$out"
  rm -f "$WORK/dump.sh"
}
# Each stored file's identity in Storage: bucket, name, version, size. Live (outside the snapshot) or from the snapshot.
IDENTITY_SQL="select bucket_id, name, coalesce(version, ''), coalesce(metadata->>'size', '') from storage.objects order by 1, 2"

attempt() {
  rm -rf "$DIR"; mkdir -p "$DIR/storage"
  echo "[dump] roles"
  "$SUPABASE" db dump --db-url "$BACKUP_DB_URL" -f "$DIR/roles.sql" --role-only
  PG_IMAGE="$(pg_image)"
  hold_snapshot
  trap release_snapshot EXIT   # this attempt runs in a subshell: the work folder is removed by the main trap
  echo "[snapshot] schema, data, counts, fingerprints and Storage manifest from one database snapshot"
  in_snapshot -c "select now(), txid_current_snapshot()" > "$DIR/snapshot.tsv"
  dump_in_snapshot "$DIR/schema.sql"
  dump_in_snapshot "$DIR/data.sql" --use-copy --data-only
  grep -q 'TABLE IF NOT EXISTS "public"."jobs"' "$DIR/schema.sql" || { echo "schema dump has no public.jobs: refusing to store it" >&2; exit 1; }
  echo "[counts] rows per table"
  in_snapshot -f scripts/backup-counts.sql > "$DIR/counts.tsv"
  echo "[fingerprint] content of every table and money totals"
  in_snapshot -f scripts/backup-fingerprints.sql > "$DIR/fingerprints.tsv"
  echo "[storage] manifest"
  in_snapshot -c "select bucket_id, name, coalesce(metadata->>'size', ''), coalesce(metadata->>'mimetype', ''), updated_at from storage.objects order by bucket_id, name" \
    > "$DIR/storage/manifest.tsv"
  in_snapshot -c "$IDENTITY_SQL" > "$WORK/identity.snapshot"
  release_snapshot
  trap - EXIT

  # Always recorded, even when no file is stored: restore-check refuses a backup without them, so a backup that
  # couldn't record them must fail now rather than turn out unrestorable later.
  if [[ -z "${BACKUP_SUPABASE_URL:-}" || -z "${BACKUP_SERVICE_KEY:-}" ]]; then
    echo "BACKUP_SUPABASE_URL / BACKUP_SERVICE_KEY are not set: the Auth and Storage versions can't be recorded, so this backup couldn't be restore-checked" >&2
    exit 1
  fi
  echo "[versions] Auth and Storage service versions"
  curl -fsS "$BACKUP_SUPABASE_URL/auth/v1/health" -H "apikey: $BACKUP_SERVICE_KEY" | jq -r '.version // empty' | tr -d '[:space:]' > "$DIR/auth-version"
  curl -fsS "$BACKUP_SUPABASE_URL/storage/v1/version" -H "apikey: $BACKUP_SERVICE_KEY" \
    -H "Authorization: Bearer $BACKUP_SERVICE_KEY" | tr -d '[:space:]' > "$DIR/storage-version"
  for svc in auth storage; do
    [[ "$(cat "$DIR/$svc-version")" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "couldn't read a valid $svc version (got '$(cat "$DIR/$svc-version")')" >&2; exit 1; }
  done
  echo "[versions] Auth $(cat "$DIR/auth-version"), Storage $(cat "$DIR/storage-version")"

  LISTED="$(wc -l < "$DIR/storage/manifest.tsv")"
  : > "$DIR/storage/files.tsv"
  if [[ "$LISTED" != 0 ]]; then
    echo "[storage] $LISTED files from every bucket"
    # Test hook only (scripts/backup-consistency-drill.sh): changes Storage after the snapshot, during the copy.
    if [[ -n "${BACKUP_TEST_DURING_COPY:-}" ]]; then bash -c "$BACKUP_TEST_DURING_COPY"; fi
    local failed=""
    while IFS=$'\t' read -r bucket name size _; do
      target="$DIR/storage/files/$bucket/$name"
      mkdir -p "$(dirname "$target")"
      path="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$name")"
      if ! curl -fsS -H "Authorization: Bearer $BACKUP_SERVICE_KEY" -H "apikey: $BACKUP_SERVICE_KEY" \
          "$BACKUP_SUPABASE_URL/storage/v1/object/$bucket/$path" -o "$target"; then
        failed="storage file not downloaded: $bucket/$name"; break
      fi
      got="$(stat -c %s "$target")"
      if [[ -n "$size" && "$size" != "$got" ]]; then failed="storage file $bucket/$name: $got bytes, the manifest says $size"; break; fi
      printf '%s\t%s\t%s\t%s\n' "$bucket" "$name" "$got" "$(sha256sum "$target" | cut -d' ' -f1)" >> "$DIR/storage/files.tsv"
    done < "$DIR/storage/manifest.tsv"
    # Every file in the snapshot must still be the same version now that its copy is done. A file added after the
    # snapshot isn't in this backup's database either, so it isn't needed; one replaced or deleted makes it inconsistent.
    psql "$BACKUP_DB_URL" -X -q -v ON_ERROR_STOP=1 -AtF $'\t' -c "$IDENTITY_SQL" > "$WORK/identity.live"
    changed="$(comm -23 <(awk -F'\t' '{print $1"/"$2"\t"$3"\t"$4}' "$WORK/identity.snapshot" | sort) \
                        <(awk -F'\t' '{print $1"/"$2"\t"$3"\t"$4}' "$WORK/identity.live" | sort) | wc -l)"
    if [[ "$changed" != 0 ]]; then
      echo "[storage] $changed stored file(s) were replaced or deleted during the copy: this attempt is not consistent" >&2
      exit "$CHANGED"
    fi
    [[ -z "$failed" ]] || { echo "$failed" >&2; exit 1; }
    saved="$(wc -l < "$DIR/storage/files.tsv")"
    [[ "$saved" == "$LISTED" ]] || { echo "storage: $LISTED files listed but $saved saved" >&2; exit 1; }
  else
    echo "[storage] no stored files"
  fi
}

for n in $(seq 1 "$BACKUP_ATTEMPTS"); do
  set +e; ( set -e; attempt ); status=$?; set -e
  [[ "$status" == 0 ]] && break
  [[ "$status" == "$CHANGED" ]] || exit "$status"
  if [[ "$n" == "$BACKUP_ATTEMPTS" ]]; then
    echo "stored files kept changing during the copy ($BACKUP_ATTEMPTS attempts): no consistent backup, nothing published" >&2
    exit 1
  fi
  echo "[retry] attempt $n wasn't consistent; starting again with a fresh snapshot in ${BACKUP_RETRY_DELAY}s"
  sleep "$BACKUP_RETRY_DELAY"
done
LISTED="$(wc -l < "$DIR/storage/manifest.tsv")"

echo "[encrypt] $NAME.tar.gz.gpg"
tar -C "$WORK" -czf "$WORK/$NAME.tar.gz" "$NAME"
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 --symmetric --cipher-algo AES256 \
  -o "$OUT/$NAME.tar.gz.gpg" "$WORK/$NAME.tar.gz" <<< "$BACKUP_PASSPHRASE"
(cd "$OUT" && sha256sum "$NAME.tar.gz.gpg" > "$NAME.tar.gz.gpg.sha256")

echo "[verify] decrypts and lists"
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 --decrypt "$OUT/$NAME.tar.gz.gpg" <<< "$BACKUP_PASSPHRASE" | tar -tz > "$WORK/listing.txt"
for f in auth-version storage-version; do
  grep -qx "$NAME/$f" "$WORK/listing.txt" || { echo "the encrypted backup doesn't contain $f" >&2; exit 1; }
done
grep -q "$NAME/data.sql" "$WORK/listing.txt" || { echo "the encrypted backup doesn't contain data.sql" >&2; exit 1; }
inside="$(grep -c "^$NAME/storage/files/.*[^/]\$" "$WORK/listing.txt" || true)"
[[ "$inside" == "$LISTED" ]] || { echo "the encrypted backup holds $inside stored files, $LISTED were listed" >&2; exit 1; }
echo "[done] $(du -h "$OUT/$NAME.tar.gz.gpg" | cut -f1) $OUT/$NAME.tar.gz.gpg; $(wc -l < "$DIR/counts.tsv") tables counted; $LISTED stored files listed and saved"

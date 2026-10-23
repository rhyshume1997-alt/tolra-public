#!/usr/bin/env bash
# Restores a nightly backup (scripts/backup-run.sh) into an EMPTY Supabase project and checks it (docs/RESTORE.md).
#
#   RESTORE_DB_URL='postgresql://...'   the target: a NEW, empty Supabase project (session pooler, port 5432)
#   BACKUP_PASSPHRASE='...'             the passphrase the backup was encrypted with
#   PROTECTED_REFS='<prod ref> <legacy ref>'   project refs this script must never write to
#   RESTORE_SUPABASE_URL='https://<new ref>.supabase.co' and RESTORE_SERVICE_KEY='...'   the same new project's API:
#                                       stored files are uploaded to it (needed when the backup holds files)
#   scripts/restore-backup.sh tolra-backup-<stamp>.tar.gz.gpg
#
# Steps: check the .sha256 if present, decrypt, restore roles + schema + data in ONE transaction (all or nothing),
# re-apply the PostgREST request hook (017; role settings are not in a dump), compare row counts with the backup's
# counts.tsv and every table's content and money totals with its fingerprints.tsv (required with
# REQUIRE_FINGERPRINTS=1), then upload every stored file (drawings, quote attachments, logos) to its bucket and
# download each one back to compare its checksum with the backup's. Restoring over production is deliberately not offered here.
set -euo pipefail
FILE="${1:?usage: scripts/restore-backup.sh <backup .tar.gz.gpg>}"
: "${RESTORE_DB_URL:?RESTORE_DB_URL is not set}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is not set}"
: "${PROTECTED_REFS:?PROTECTED_REFS (production and legacy project refs) must be set}"
for ref in $PROTECTED_REFS; do
  [[ "$RESTORE_DB_URL" != *"$ref"* ]] || { echo "Refusing: RESTORE_DB_URL names a protected project ($ref). Restore into a new project." >&2; exit 1; }
  [[ "${RESTORE_SUPABASE_URL:-}" != *"$ref"* ]] || { echo "Refusing: RESTORE_SUPABASE_URL names a protected project ($ref)." >&2; exit 1; }
done
psqlx() { psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }
if [[ "$(psqlx -Atc "select count(*) from information_schema.tables where table_schema = 'public'")" != 0 ]]; then
  echo "Refusing: the target already has tables in public. Use a new, empty project." >&2; exit 1
fi
if [[ -f "$FILE.sha256" ]]; then (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256"); fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 --decrypt "$FILE" <<< "$BACKUP_PASSPHRASE" | tar -C "$WORK" -xz
DIR="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'tolra-backup-*' -print -quit)"
[[ -n "$DIR" ]] || { echo "Not a Tolra backup." >&2; exit 1; }
echo "[restore] $(basename "$DIR") (one transaction: all or nothing)"
# roles.sql comes from the source project, which also holds Supabase's own platform roles. Every Supabase project
# creates and manages those itself, and the postgres login may not create, alter or grant them (supautils), so a
# statement in roles.sql that names one of the roles below is left out and printed. Nothing else is touched:
# application roles (anon, authenticated, authenticator, service_role, postgres), and all grants and ownership in
# schema.sql, are restored as dumped, and any other error still fails the whole restore.
PLATFORM_ROLES="supabase_admin supabase_auth_admin supabase_storage_admin supabase_functions_admin
  supabase_realtime_admin supabase_replication_admin supabase_read_only_user supabase_etl_admin
  supabase_privileged_role dashboard_user pgbouncer"
awk -v roles="$PLATFORM_ROLES" '
  BEGIN { n = split(roles, r, /[ \n]+/); for (i = 1; i <= n; i++) if (r[i] != "") platform["\"" r[i] "\""] = 1 }
  {
    line = $0; hit = 0
    while (match(line, /"[^"]+"/)) { if (substr(line, RSTART, RLENGTH) in platform) { hit = 1; break }; line = substr(line, RSTART + RLENGTH) }
    if (hit) { sub(/PASSWORD .*/, "PASSWORD [hidden]"); print > "/dev/stderr"; next }
    print
  }' "$DIR/roles.sql" > "$WORK/roles-target.sql" 2> "$WORK/roles-excluded.sql"
if [[ -s "$WORK/roles-excluded.sql" ]]; then
  echo "[roles] left out $(wc -l < "$WORK/roles-excluded.sql") statement(s) about Supabase platform roles (the platform manages them):"
  sed 's/^/[roles]   /' "$WORK/roles-excluded.sql"
fi
# A COPY with no rows restores nothing, but still needs write access to its table, and newer Supabase versions keep
# some of their own tables (e.g. storage.buckets_vectors) out of the postgres login's reach. So empty COPY blocks are
# left out (each one named); every COPY that carries rows runs, and fails the restore if it can't. The filter tracks
# COPY state, so a data row that merely looks like a COPY header is never touched (scripts/restore-data-filter.awk).
awk -f "$(dirname "$0")/restore-data-filter.awk" "$DIR/data.sql" > "$WORK/data-target.sql" 2> "$WORK/empty-copies"
if [[ -s "$WORK/empty-copies" ]]; then echo "[data] $(wc -l < "$WORK/empty-copies") empty table(s), nothing to copy: $(tr '\n' ' ' < "$WORK/empty-copies")"; fi
psql "$RESTORE_DB_URL" --single-transaction -v ON_ERROR_STOP=1 -q \
  -f "$WORK/roles-target.sql" -f "$DIR/schema.sql" -c 'SET session_replication_role = replica' -f "$WORK/data-target.sql" > /dev/null

echo "[hook] PostgREST request check (017)"
psqlx -c "DO \$\$ BEGIN IF to_regprocedure('public.check_request_session()') IS NOT NULL THEN
            EXECUTE 'ALTER ROLE authenticator SET pgrst.db_pre_request = ''public.check_request_session''';
          END IF; END \$\$;" -c "NOTIFY pgrst, 'reload schema'" -c "NOTIFY pgrst, 'reload config'"

echo "[check] row counts against the backup"
psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -AtF $'\t' -f scripts/backup-counts.sql > "$WORK/restored.tsv"
if diff -u "$DIR/counts.tsv" "$WORK/restored.tsv"; then
  echo "[ok] every table has the same number of rows as the backup ($(wc -l < "$DIR/counts.tsv") tables)"
else
  echo "[FAIL] row counts differ (above)." >&2; exit 1
fi
if [[ -f "$DIR/fingerprints.tsv" ]]; then
  echo "[check] content of every table and money totals against the backup"
  psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -AtF $'\t' -f scripts/backup-fingerprints.sql > "$WORK/fingerprints.tsv"
  # Only names are printed, never values.
  bad="$(join -t $'\t' -j1 -a1 -a2 -e MISSING -o 0,1.2,2.2 \
          <(awk -F'\t' '{print $1":"$2"\t"$3}' "$DIR/fingerprints.tsv" | sort) \
          <(awk -F'\t' '{print $1":"$2"\t"$3}' "$WORK/fingerprints.tsv" | sort) | awk -F'\t' '$2 != $3 {print $1}')"
  if [[ -n "$bad" ]]; then echo "[FAIL] differs from the backup: $(echo "$bad" | tr '\n' ' ')" >&2; exit 1; fi
  echo "[ok] every table's content and every money total match the backup ($(grep -c '^table' "$DIR/fingerprints.tsv") tables, $(grep -c '^money' "$DIR/fingerprints.tsv") money totals)"
elif [[ "${REQUIRE_FINGERPRINTS:-0}" == 1 ]]; then
  echo "[FAIL] this backup has no content fingerprint (made before fingerprints were added): take a new backup first" >&2; exit 1
else
  echo "[skip] this backup has no content fingerprint (made before fingerprints were added)"
fi
FILES="$DIR/storage/files.tsv"
COUNT="$( [[ -f "$FILES" ]] && wc -l < "$FILES" || echo 0)"
if [[ "$COUNT" == 0 ]]; then
  echo "[storage] no stored files in this backup"
elif [[ -z "${RESTORE_SUPABASE_URL:-}" || -z "${RESTORE_SERVICE_KEY:-}" ]]; then
  echo "[FAIL] the backup holds $COUNT stored files: set RESTORE_SUPABASE_URL and RESTORE_SERVICE_KEY (the new project) to restore them." >&2
  exit 1
else
  echo "[storage] uploading $COUNT files, then checking each one"
  auth=(-H "Authorization: Bearer $RESTORE_SERVICE_KEY" -H "apikey: $RESTORE_SERVICE_KEY")
  while IFS=$'\t' read -r bucket name size sum; do
    path="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$name")"
    type="$(awk -F'\t' -v b="$bucket" -v n="$name" '$1 == b && $2 == n { print $4; exit }' "$DIR/storage/manifest.tsv")"
    curl -fsS "${auth[@]}" -H "x-upsert: true" -H "Content-Type: ${type:-application/octet-stream}" \
      --data-binary "@$DIR/storage/files/$bucket/$name" "$RESTORE_SUPABASE_URL/storage/v1/object/$bucket/$path" > /dev/null \
      || { echo "[FAIL] upload of $bucket/$name" >&2; exit 1; }
    back="$(curl -fsS "${auth[@]}" "$RESTORE_SUPABASE_URL/storage/v1/object/$bucket/$path" | sha256sum | cut -d' ' -f1)"
    [[ "$back" == "$sum" ]] || { echo "[FAIL] $bucket/$name reads back different from the backup" >&2; exit 1; }
  done < "$FILES"
  echo "[ok] $COUNT stored files restored and identical to the backup"
fi

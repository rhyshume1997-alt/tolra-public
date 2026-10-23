#!/usr/bin/env bash
# Monthly backup copy (docs/RESTORE.md): on the 1st of the month (or MONTHLY=true), stores the encrypted nightly
# backup as the asset of a pre-release "backup-monthly-YYYY-MM", then removes monthly copies older than 12 months.
# Release assets don't expire (unlike artifacts, whose retention a repository setting can cap). Needs gh + GH_TOKEN
# with contents: write. The daily 30-day artifacts are separate and untouched.
set -euo pipefail
DIR="${1:?usage: scripts/backup-monthly.sh <dir with the .tar.gz.gpg>}"
if [[ "$(date -u +%d)" != "01" && "${MONTHLY:-}" != "true" ]]; then echo "[monthly] not the 1st: nothing to do"; exit 0; fi
MONTH="$(date -u +%Y-%m)"
TAG="backup-monthly-$MONTH"
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "[monthly] $TAG already stored: kept as it is"
else
  gh release create "$TAG" "$DIR"/*.tar.gz.gpg "$DIR"/*.tar.gz.gpg.sha256 --prerelease --title "Monthly backup $MONTH (encrypted)" \
    --notes "Encrypted backup of quoteflow-prod for $MONTH (docs/RESTORE.md). Kept 12 months. Needs BACKUP_PASSPHRASE to restore."
  echo "[monthly] stored $TAG"
fi
CUTOFF="$(date -u -d "$(date -u +%Y-%m-01) -11 months" +%Y-%m)"  # keeps this month and the 11 before: 12 copies
gh release list --limit 200 --json tagName --jq '.[].tagName' | while read -r tag; do
  [[ "$tag" =~ ^backup-monthly-([0-9]{4}-[0-9]{2})$ ]] || continue
  if [[ "${BASH_REMATCH[1]}" < "$CUTOFF" ]]; then
    gh release delete "$tag" --cleanup-tag --yes
    echo "[monthly] removed $tag (older than 12 months)"
  fi
done

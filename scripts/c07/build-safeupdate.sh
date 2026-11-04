#!/usr/bin/env bash
# C07: build eradman/pg-safeupdate at ONE pinned commit (tag 1.7) against the given pg_config, for the disposable test
# container only. Nothing here touches a hosted database.
#
#   PG_CONFIG=/usr/lib/postgresql/17/bin/pg_config bash scripts/c07/build-safeupdate.sh <output dir>
#
# Writes <output dir>/safeupdate.so and <output dir>/BUILD-INFO (commit, version, PostgreSQL headers, sha256). Fails unless the
# fetched commit is exactly the pin and its NEWS names 1.7 as the newest release.
set -euo pipefail
PIN=37dbc9c4acf5e2504adf2b218e9c6b41751022f3
VERSION=1.7
REPO=https://github.com/eradman/pg-safeupdate.git
: "${PG_CONFIG:?set PG_CONFIG to the pg_config of the PostgreSQL major the container runs}"
out="${1:?usage: build-safeupdate.sh <output dir>}"
mkdir -p "$out"
src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT

git -C "$src" init -q
git -C "$src" fetch -q --depth 1 "$REPO" "$PIN"
git -C "$src" checkout -q --detach FETCH_HEAD
head="$(git -C "$src" rev-parse HEAD)"
[[ "$head" == "$PIN" ]] || { echo "C07: fetched $head, not the pinned $PIN" >&2; exit 1; }
newest="$(sed -n 's/^== \([0-9][0-9.]*\):.*/\1/p' "$src/NEWS" | head -1)"
[[ "$newest" == "$VERSION" ]] || { echo "C07: NEWS at $PIN names $newest, not $VERSION" >&2; exit 1; }
release="$(sed -n 's/^RELEASE = //p' "$src/Makefile")"
[[ "$release" == "$VERSION" ]] || { echo "C07: Makefile at $PIN says RELEASE $release, not $VERSION" >&2; exit 1; }

# with_llvm=no: only the shared library is needed (no JIT bitcode, so no clang).
make -C "$src" PG_CONFIG="$PG_CONFIG" with_llvm=no
cp "$src/safeupdate.so" "$out/safeupdate.so"
{
  echo "repository=$REPO"
  echo "commit=$head"
  echo "version=$newest"
  echo "makefile_release=$release"
  echo "news_head=$(grep -m1 '^== ' "$src/NEWS")"
  echo "pg_config=$PG_CONFIG"
  echo "pg_config_version=$("$PG_CONFIG" --version)"
  echo "source_sha256=$(sha256sum "$src/safeupdate.c" | cut -d' ' -f1)"
  echo "library_sha256=$(sha256sum "$out/safeupdate.so" | cut -d' ' -f1)"
} > "$out/BUILD-INFO"
cat "$out/BUILD-INFO"

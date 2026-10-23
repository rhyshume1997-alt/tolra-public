#!/usr/bin/env bash
# Regression test for scripts/restore-data-filter.awk (empty-COPY filter used by scripts/restore-backup.sh).
# The fixture's COPY data holds rows that look like a COPY header and like a terminator; they must come through
# byte for byte, while genuinely empty COPY blocks are dropped and named. Local, no database: bash tests/scripts/restore-data-filter.test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
FIX=tests/scripts/fixtures
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
fail=0
check() { if "$@"; then echo "ok   $DESC"; else echo "FAIL $DESC"; fail=1; fi; }

awk -f scripts/restore-data-filter.awk "$FIX/restore-copy-lookalikes.sql" > "$OUT/data" 2> "$OUT/empty"
DESC="data rows that look like COPY headers / terminators are unchanged, empty blocks dropped"
check diff -u "$FIX/restore-copy-lookalikes.expected.sql" "$OUT/data"
DESC="exactly the empty tables are reported"
check diff -u "$FIX/restore-copy-lookalikes.empty" "$OUT/empty"
DESC="lookalike header row is still present"
check grep -qxF 'COPY public.example FROM stdin;' "$OUT/data"

# Data with no empty blocks passes through untouched; an empty block at end of file (no trailing data) is dropped.
printf 'COPY public.t (a) FROM stdin;\n1\n\\.\n' > "$OUT/plain"
awk -f scripts/restore-data-filter.awk "$OUT/plain" > "$OUT/plain.out" 2> /dev/null
DESC="normal block is unchanged"; check cmp -s "$OUT/plain" "$OUT/plain.out"
printf 'COPY public.t (a) FROM stdin;\n' > "$OUT/trunc"
awk -f scripts/restore-data-filter.awk "$OUT/trunc" > "$OUT/trunc.out" 2> /dev/null
DESC="truncated header at end of file is kept (not silently dropped)"; check cmp -s "$OUT/trunc" "$OUT/trunc.out"
exit $fail

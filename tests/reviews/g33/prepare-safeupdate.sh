#!/usr/bin/env bash
# Build genuine unmodified pg-safeupdate for PostgreSQL 17. No database or credentials used.
set -euo pipefail
out="${1:?Choose a new temporary dependency directory}"
mkdir -p "$out"
curl -fsSL https://deb.debian.org/debian/pool/main/p/postgresql-17/postgresql-server-dev-17_17.11-0+deb13u1_amd64.deb -o "$out/pg-dev.deb"
curl -fsSL https://raw.githubusercontent.com/eradman/pg-safeupdate/37dbc9c4acf5e2504adf2b218e9c6b41751022f3/safeupdate.c -o "$out/safeupdate.c"
printf '%s  %s\n' 59cb25f0a1def045aa334a9c025befc4a72dfc72d4a370f97d7d3f7342803d7e "$out/pg-dev.deb" 1351fc18b9a1e2dcc72185d349c178244458b5d9eb30007609c3d599b38aeb38 "$out/safeupdate.c" | sha256sum -c -
dpkg-deb -x "$out/pg-dev.deb" "$out/pg-dev"
gcc -fPIC -shared -I"$out/pg-dev/usr/include/postgresql/17/server" -o "$out/safeupdate.so" "$out/safeupdate.c"
chmod 0755 "$out/safeupdate.so"
sha256sum "$out/safeupdate.so"

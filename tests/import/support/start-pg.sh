#!/usr/bin/env bash
# Starts (or reports) the DISPOSABLE PostgreSQL 16 the SliQ import rehearsal tests use: loopback only, port 55511, data under /var/tmp,
# owned by the postgres OS user. Nothing here ever talks to a hosted database. Stop and delete with:  start-pg.sh stop
set -euo pipefail
BIN=/usr/lib/postgresql/16/bin
DIR=${SLIQ_REHEARSAL_PGDIR:-/var/tmp/sliq-rehearsal-pg}
PORT=55511
case "${1:-start}" in
  start)
    [ -d "$DIR/data" ] || { mkdir -p "$DIR"; chown postgres:postgres "$DIR"; su postgres -c "$BIN/initdb -D $DIR/data -A trust -U postgres >/dev/null"; }
    su postgres -c "$BIN/pg_ctl -D $DIR/data -o '-p $PORT -k $DIR -c listen_addresses=127.0.0.1 -c fsync=off' -l $DIR/log -w start" ;;
  stop)
    su postgres -c "$BIN/pg_ctl -D $DIR/data -m fast stop" || true
    rm -rf "$DIR" ;;
  *) echo "usage: start-pg.sh [start|stop]" >&2; exit 2 ;;
esac

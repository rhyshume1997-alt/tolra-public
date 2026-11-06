#!/usr/bin/env bash
# PQ database checks: the loaded database must reproduce the dataset's counts and money to the penny (read-only).
#   tests/pq/verify.sh --yes-this-is-a-disposable-database [same --seed/--base-date/--scale you gave setup.sh]
# With no options it reuses the ones setup.sh recorded in .env.pq.run.
set -euo pipefail
cd "$(dirname "$0")/../.."
case " $* " in *" --yes-this-is-a-disposable-database "*) ;; *) echo "Refusing: pass --yes-this-is-a-disposable-database." >&2; exit 2 ;; esac
args=("$@")
if [ -f .env.pq.run ] && ! printf '%s ' "$@" | grep -q -- '--seed\|--base-date\|--scale'; then
  # shellcheck disable=SC1091
  . ./.env.pq.run
  args+=(--seed "$PQ_SEED" --base-date "$PQ_BASE_DATE" --scale "$PQ_SCALE")
fi
exec node tests/pq/seed/cli.mjs verify "${args[@]}"

#!/usr/bin/env bash
# PQ environment setup: loads the synthetic JNR dataset into the repo's DISPOSABLE Supabase stack.
#
#   npm run test:backend                      # (or: scripts/test-backend.sh start)  starts the disposable stack, writes .env.test.local
#   tests/pq/setup.sh --yes-this-is-a-disposable-database [--seed S] [--base-date YYYY-MM-DD] [--scale N] [--auth sql|api]
#
# Idempotent: if this seed's run is already loaded it stops without writing (run tests/pq/reset.sh first to load again).
# Refuses, before any write, unless TEST_DATABASE_URL (and the API URL, if set) are on loopback, the database holds only
# synthetic companies and @example.test users, and the confirmation flag is given. See tests/pq/README.md.
#   --auth api   creates real Auth users through the local stack's Auth admin API (sign-in works; passwords go to .env.pq.credentials)
#   --auth sql   (default) inserts auth.users rows only: enough for the database checks, you cannot sign in with them
set -euo pipefail
cd "$(dirname "$0")/../.."
case " $* " in *" --yes-this-is-a-disposable-database "*) ;; *) echo "Refusing: pass --yes-this-is-a-disposable-database (this writes ~1000 rows of synthetic data)." >&2; exit 2 ;; esac
[ -e node_modules/pg ] || { echo "Refusing: run npm ci first (needs the pg driver)." >&2; exit 2; }
exec node tests/pq/seed/cli.mjs load "$@"

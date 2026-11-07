#!/usr/bin/env bash
# PQ environment reset.
#
#   tests/pq/reset.sh --yes-this-is-a-disposable-database             removes ONLY the marker-tagged PQ companies and their users
#   tests/pq/reset.sh --yes-this-is-a-disposable-database --recreate  rebuilds the whole disposable database (scripts/test-backend.sh reset)
#
# Marker = organisation slug t-<8 hex>-(jnr|practice) AND name "Synthetic (JNR|Practice) PQ <same hex>" AND users
# <role><n>.(jnr|practice).<same hex>@example.test. Anything else in the database is left alone. Idempotent: a second run removes nothing.
# Both modes run the identity guard first (loopback only; no non-synthetic company; no user outside @example.test).
set -euo pipefail
cd "$(dirname "$0")/../.."
case " $* " in *" --yes-this-is-a-disposable-database "*) ;; *) echo "Refusing: pass --yes-this-is-a-disposable-database." >&2; exit 2 ;; esac
[ -e node_modules/pg ] || { echo "Refusing: run npm ci first (needs the pg driver)." >&2; exit 2; }
node tests/pq/seed/cli.mjs identity --yes-this-is-a-disposable-database
case " $* " in
  *" --recreate "*)
    # scripts/test-backend.sh itself talks only to the local stack (127.0.0.1) and needs Supabase CLI 2.40.7 + Docker.
    scripts/test-backend.sh reset
    rm -f .env.pq.run .env.pq.credentials
    ;;
  *)
    node tests/pq/seed/cli.mjs reset --yes-this-is-a-disposable-database
    rm -f .env.pq.run .env.pq.credentials
    ;;
esac

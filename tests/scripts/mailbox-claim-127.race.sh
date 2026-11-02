#!/usr/bin/env bash
# Local race proof for migration 127's throttle (mailbox_sync_claim): callers on SEPARATE connections at the same moment (two office users,
# several tabs, the server's pass) start ONE inbox check for a company, not several. Run on a disposable COPY with the chain plus 127:
#   createdb x -T <chain db>; psql -d x -f supabase/release/127_mailbox_read.release.sql
#   PSQL="psql" tests/scripts/mailbox-claim-127.race.sh x
# It commits a small fixture (company "Race 127"; audit rows keep it, so use a throwaway copy). Prints PASS lines; exits non-zero on any FAIL.
set -euo pipefail
DB="${1:?database name (a disposable copy)}"
PSQL="${PSQL:-psql}"
q() { $PSQL -v ON_ERROR_STOP=1 -qtA -d "$DB" "$@"; }
ORG=12700000-0000-0000-0000-0000000000e0
USR=12700000-0000-0000-0000-0000000000e1
SVC="SET ROLE service_role; SELECT set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false);"


q -c "INSERT INTO public.organizations (id, name, slug) VALUES ('$ORG', 'Race 127', 't-race-127') ON CONFLICT DO NOTHING;
      INSERT INTO auth.users (id, email) VALUES ('$USR', 'admin.race@example.test') ON CONFLICT DO NOTHING;
      INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES ('$USR', 'admin.race@example.test', 'admin', '$ORG') ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.organization_members (user_id, organization_id, role, hidden_sections) VALUES ('$USR', '$ORG', 'admin', '{}') ON CONFLICT DO NOTHING;" >/dev/null
q -c "$SVC SELECT public.integration_store_connection('$ORG', '$USR', 'microsoft', 'mbx-race', 'mbx-race@example.test', NULL, 'v1.aaaa.bbbb.cccc', 'v1.aaaa.bbbb.dddd', now() + interval '1 hour', 1);
      SELECT public.mailbox_sync_connected('$ORG', 'mbx-race', TRUE);" >/dev/null

claim() { q -c "$SVC SELECT public.mailbox_sync_claim('$ORG', 90) ->> 'state';" | tail -n1; }

# 1. One caller holds its claim open (its transaction is still running) while a second asks: the second waits for the row lock, then
#    re-checks claimed_at and answers 'recent'.
q -c "UPDATE public.integration_mailbox_sync SET claimed_at = NULL WHERE organization_id = '$ORG';" >/dev/null
OUT1=$(mktemp); OUT2=$(mktemp)
( q -c "BEGIN; $SVC SELECT 'first:' || (public.mailbox_sync_claim('$ORG', 90) ->> 'state'); SELECT pg_sleep(2); COMMIT;" > "$OUT1" ) &
P1=$!
sleep 0.5
START=$(date +%s.%N)
claim > "$OUT2"
END=$(date +%s.%N)
wait $P1
FIRST=$(grep -o 'first:[a-z_]*' "$OUT1" | cut -d: -f2); SECOND=$(cat "$OUT2")
WAITED=$(awk -v a="$START" -v b="$END" 'BEGIN { print (b - a >= 1.0) ? 1 : 0 }')
if [ "$FIRST" = claimed ] && [ "$SECOND" = recent ] && [ "$WAITED" = 1 ]; then
  echo "PASS 1 overlapping callers: first=claimed, second waited for the lock then answered recent"
else
  echo "FAIL 1 first=$FIRST second=$SECOND waited=$WAITED"; exit 1
fi

# 2. Twelve callers on twelve connections released at the same instant: exactly one 'claimed'.
q -c "UPDATE public.integration_mailbox_sync SET claimed_at = NULL WHERE organization_id = '$ORG';" >/dev/null
DIR=$(mktemp -d)
for i in $(seq 1 12); do ( claim > "$DIR/$i" ) & done
wait
CLAIMED=$(cat "$DIR"/* | grep -c '^claimed$' || true); RECENT=$(cat "$DIR"/* | grep -c '^recent$' || true)
if [ "$CLAIMED" = 1 ] && [ "$RECENT" = 11 ]; then
  echo "PASS 2 twelve simultaneous callers: 1 claimed, 11 recent"
else
  echo "FAIL 2 claimed=$CLAIMED recent=$RECENT"; exit 1
fi

# 3. After the interval, one more caller starts a check again.
q -c "UPDATE public.integration_mailbox_sync SET claimed_at = now() - interval '91 seconds' WHERE organization_id = '$ORG';" >/dev/null
[ "$(claim)" = claimed ] && echo "PASS 3 after 90 seconds a check starts again" || { echo "FAIL 3"; exit 1; }
rm -rf "$DIR" "$OUT1" "$OUT2"

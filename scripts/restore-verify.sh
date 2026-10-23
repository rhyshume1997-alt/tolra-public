#!/usr/bin/env bash
# After scripts/restore-backup.sh: checks that the RESTORED copy works as an app backend, on a throwaway local stack
# only (.github/workflows/restore-check.yml). Refuses anything but the local Supabase on 127.0.0.1:54321 / 54322.
#
#   VERIFY_DB_URL  VERIFY_API_URL  VERIFY_ANON_KEY  VERIFY_SERVICE_KEY   the local stack (supabase status -o env)
#
# 1. every public table still has row-level security on;
# 2. a restored login signs in (a temporary password is set on the throwaway copy only);
# 3. company isolation: signed in, it sees exactly its own company's rows of a table that holds two companies' rows,
#    and none of the other company's; signed out (anon key only) it sees nothing;
# 4. the session check (017): after that login is signed out everywhere, its still-unexpired token is refused.
# Prints pass/fail lines only: no emails, ids, names or values.
set -euo pipefail
: "${VERIFY_DB_URL:?}" "${VERIFY_API_URL:?}" "${VERIFY_ANON_KEY:?}" "${VERIFY_SERVICE_KEY:?}"
[[ "$VERIFY_API_URL" == "http://127.0.0.1:54321" ]] || { echo "Refusing: $VERIFY_API_URL is not the runner's local stack" >&2; exit 1; }
[[ "$VERIFY_DB_URL" == postgresql://*@127.0.0.1:54322/postgres ]] || { echo "Refusing: the database is not the runner's local stack" >&2; exit 1; }
q() { psql "$VERIFY_DB_URL" -v ON_ERROR_STOP=1 -Atq -c "$1"; }
fail() { echo "[FAIL] $*" >&2; exit 1; }

no_rls="$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity")"
[[ "$no_rls" == 0 ]] || fail "$no_rls public tables without row-level security"
echo "[ok] every public table has row-level security on"

# A table holding rows of at least two companies, and an active login whose CURRENT company (user_profiles) is one
# of them. Row-level security shows only the current company, even to someone who belongs to several companies.
pick="$(q "
  create temp table orgs_in(tbl text, org uuid);
  do \$\$ declare t text; begin
    for t in select c.table_name from information_schema.columns c join information_schema.tables x
               on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
             where c.table_schema = 'public' and c.column_name = 'organization_id'
               and c.table_name not in ('organization_members', 'user_profiles', 'organizations') order by c.table_name loop
      execute format('insert into orgs_in select %L, organization_id from public.%I where organization_id is not null group by 1, 2', t, t);
    end loop; end \$\$;
  select a.tbl, u.organization_id, b.org, u.id
  from public.user_profiles u
  join public.organization_members m on m.user_id = u.id and m.organization_id = u.organization_id and m.active
  join auth.users au on au.id = u.id
  join orgs_in a on a.org = u.organization_id
  join orgs_in b on b.tbl = a.tbl and b.org <> a.org
  where u.active
  order by u.must_change_password, a.tbl limit 1;" | tail -1)"
[[ -n "$pick" ]] || fail "no table in the backup holds two companies' rows with an active member: isolation can't be checked"
IFS='|' read -r TBL ORG OTHER USER_ID <<< "$pick"

# Throwaway copy only: a temporary password and no forced password change, so the login can be used here.
q "update public.user_profiles set must_change_password = false where id = '$USER_ID'" > /dev/null
PASSWORD="Rc-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')9"
echo "::add-mask::$PASSWORD"
code="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$VERIFY_API_URL/auth/v1/admin/users/$USER_ID" \
  -H "apikey: $VERIFY_SERVICE_KEY" -H "Authorization: Bearer $VERIFY_SERVICE_KEY" -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}")"
[[ "$code" == 200 ]] || fail "couldn't set a temporary password on the restored login (HTTP $code)"
EMAIL="$(q "select email from auth.users where id = '$USER_ID'")"
TOKEN="$(curl -sS -X POST "$VERIFY_API_URL/auth/v1/token?grant_type=password" -H "apikey: $VERIFY_ANON_KEY" \
  -H 'Content-Type: application/json' -d "$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email: $e, password: $p}')" | jq -r '.access_token // empty')"
[[ -n "$TOKEN" ]] || fail "a restored login can't sign in"
echo "::add-mask::$TOKEN"
echo "[ok] a restored login signs in"

expected="$(q "select count(*) from public.$TBL where organization_id = '$ORG'")"
rows="$(curl -sS "$VERIFY_API_URL/rest/v1/$TBL?select=organization_id" -H "apikey: $VERIFY_ANON_KEY" -H "Authorization: Bearer $TOKEN")"
seen="$(jq 'length' <<< "$rows")"
foreign="$(jq --arg o "$ORG" '[.[] | select(.organization_id != $o)] | length' <<< "$rows")"
[[ "$seen" == "$expected" && "$foreign" == 0 ]] || fail "isolation: saw $seen rows ($foreign from another company), expected $expected own rows"
other="$(curl -sS "$VERIFY_API_URL/rest/v1/$TBL?select=organization_id&organization_id=eq.$OTHER" -H "apikey: $VERIFY_ANON_KEY" -H "Authorization: Bearer $TOKEN" | jq 'length')"
[[ "$other" == 0 ]] || fail "isolation: asking for the other company's rows returned $other"
anon="$(curl -sS -o /tmp/rc-anon.json -w '%{http_code}' "$VERIFY_API_URL/rest/v1/$TBL?select=organization_id" -H "apikey: $VERIFY_ANON_KEY")"
anon_rows="$(jq 'if type == "array" then length else 0 end' /tmp/rc-anon.json 2>/dev/null || echo 0)"; rm -f /tmp/rc-anon.json
[[ "$anon_rows" == 0 ]] || fail "signed out, $anon_rows rows were readable (HTTP $anon)"
echo "[ok] company isolation: own company's rows only ($expected), none of the other company's, nothing signed out"

code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$VERIFY_API_URL/auth/v1/logout?scope=global" -H "apikey: $VERIFY_ANON_KEY" -H "Authorization: Bearer $TOKEN")"
[[ "$code" == 204 ]] || fail "sign-out everywhere failed (HTTP $code)"
after="$(curl -sS -o /tmp/rc-after.json -w '%{http_code}' "$VERIFY_API_URL/rest/v1/$TBL?select=organization_id" -H "apikey: $VERIFY_ANON_KEY" -H "Authorization: Bearer $TOKEN")"
if [[ "$after" =~ ^4 ]] && grep -q -e '28000' -e 'session has ended' /tmp/rc-after.json; then
  rm -f /tmp/rc-after.json
  echo "[ok] session check (017): a signed-out session's token is refused"
else
  rm -f /tmp/rc-after.json
  fail "session check (017): a signed-out session's token got HTTP $after"
fi

# 137 hosted check (a NON-production Supabase project only)

What it proves on real hosted Supabase Auth: migration 137's trigger is accepted on `auth.users`, a password changed
through the app works, a direct `PUT /auth/v1/user` is refused, recovery, sign-in, invite and "Add user" still work, and
a ticket is used once. Then 137 is rolled back. **Never run any of this on production.** Use a throwaway test project
with the full migration chain applied and a test deployment of the app pointed at it.

You need, from the TEST project's dashboard (Settings > API): the project URL (`$URL`), the anon key (`$ANON`) and the
service-role key (`$SERVICE`). Keep the service-role key out of chat and out of files. Use a test login of your own
(`$EMAIL`, `$PASSWORD`) that is an ordinary office member, and a second admin login of a test company.

```bash
export URL=https://<test-project-ref>.supabase.co ANON=<anon key> SERVICE=<service-role key>
export EMAIL=<test login e-mail> PASSWORD=<its current password>
```

## 1. Apply 137 (SQL editor, as postgres)

1. Run `supabase/verify/release_preflight.sql`. Row "137 needs" must read `true / 5 / 0 / <any number>`. Marker 137 must read `not applied`.
2. Paste the whole of `supabase/release/137_password_change_ticket.release.sql` and run it. It must end without an error.
3. Run `supabase/verify/password_change_ticket_137.sql`. All 6 rows must be `true`.
4. Run this. Expect one row with `enabled = O`, `fn_owner = postgres`, `definer = true`, `tgtype = 19`:

```sql
SELECT t.tgname, t.tgenabled AS enabled, t.tgtype, p.proname, pg_get_userbyid(p.proowner) AS fn_owner, p.prosecdef AS definer,
       pg_get_userbyid(c.relowner) AS table_owner
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_class c ON c.oid = t.tgrelid
WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'password_change_ticket';
```

5. Run the preflight again: marker 137 must read `applied`.

## 2. Sign in still works

```bash
curl -s "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | tee /tmp/t137.json | head -c 200; echo
export TOKEN=$(python3 -c 'import json;print(json.load(open("/tmp/t137.json"))["access_token"])')
```

Expect a JSON body with `access_token`. Also sign in once in the test app in a browser: it must work as before.

## 3. A direct PUT /auth/v1/user is refused

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$URL/auth/v1/user" -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"password":"Direct-Bypass-Attempt-137"}'
```

Expect `500` (Auth says "Error during password storage"). Then sign in again with `$PASSWORD` (step 2): it must still work,
and signing in with `Direct-Bypass-Attempt-137` must fail.

## 4. Own password change through the app works

In the test app, signed in as `$EMAIL`: menu > Change password, enter the current password and a new one. Expect
"saved". Sign out and sign in with the new password. Set `PASSWORD` to the new one for the next steps.
Repeat as the test admin (with the second step on): the app asks for a fresh authenticator code, then saves.

## 5. A ticket is used once

In the SQL editor (replace the id with the test login's `auth.users.id`):

```sql
SELECT public.issue_password_change_ticket('<user id>', 'operator');
```

Within 60 seconds, run step 2 again for a fresh `$TOKEN`, then send step 3's PUT twice with two different new passwords.
Expect the first `200` and the second `500`. Then:

```sql
SELECT purpose, used_at IS NOT NULL AS used FROM security_audit.password_change_tickets WHERE user_id = '<user id>' ORDER BY created_at DESC LIMIT 1;
```

Expect `operator | true`. Change the password back through the app (step 4) if you want to keep using that login.

## 6. Password recovery works

On the test app's sign-in page, press Forgot password for `$EMAIL`. Open the e-mail's link. It opens "Choose your
password". Save a new password. Expect success, then sign in with it.

## 7. Invite and Add user work

1. In the test app, Admin > Users > Add a new person with a password. Expect success, and that person can sign in.
2. Send an accountant invite (Integrations) to a new test e-mail address. Open the invite e-mail and accept it. Then
   choose a password on "Choose your password". Expect success.
3. Admin > Users > Set password for an ordinary member. Expect success. That member signs in with it.

## 8. Roll back 137

1. Paste the whole of `supabase/release/137_password_change_ticket.rollback.sql` and run it. It must end without an error.
2. Run the preflight: marker 137 must read `not applied`.
3. Optional: step 3's PUT now returns `200`. That is the gap 137 closes, so only do it with a throwaway password.

Record the results of each step (pass or fail, and any error text) for the reviewers.

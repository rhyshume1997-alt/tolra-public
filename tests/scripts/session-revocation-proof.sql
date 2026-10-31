-- =====================================================================================================
-- S6: session-revocation proof. READ-ONLY on the schema: every case runs in a transaction that is rolled back.
--
-- Runs on a plain PostgreSQL copy with the migration chain applied and the Supabase role/auth stand-ins, NEVER on a hosted project:
--
--   create database s6_revoke template sec_base;
--   PGPASSWORD=localonly psql -h 127.0.0.1 -U postgres -d s6_revoke -v ON_ERROR_STOP=1 -f tests/scripts/session-revocation-proof.sql
--
-- A signed-in user is simulated as the API does it: `set local role authenticated` plus the token's claims in request.jwt.claims.
-- Every result line is `PASS|FAIL | case | what came back`. Short form: add -q and pipe through grep -E '^(PASS|FAIL|===)'; a clean run has
-- no FAIL line (the script does not set an exit code for a FAIL). Mirrored against the real Auth service in tests/db/session-revocation.test.ts.
--
-- What is enforced where (migration numbers in brackets):
--   * the database itself, on EVERY row read or write (RLS helpers via _session_membership, 036): the membership is active, the
--     profile is active and has no forced password change, the company is 'active', the role still allows the table, a support
--     membership is unexpired / unrevoked / under the grant the session chose, and the token passed aal2 for a platform owner.
--   * the PostgREST request hook check_request_session -> session_is_active (017/033): the token's session row still exists and has
--     not passed not_after. Deliberately NOT in the row helpers (8.5x slower on a 20,000-row read), so a plain SQL select with a dead
--     session still returns rows here; the hook is what refuses it for every REST/RPC request (and Storage policies call it, 033).
--   * a sign-in ban (auth.users.banned_until): Auth refuses sign-in and token refresh, and from migration 119 the database refuses
--     too: a banned login resolves no membership (rows=0) and the request hook raises 28000, so an access token already issued
--     stops working at once (before 119 it kept working until it expired: that was the documented gap). Case 3 records it.
-- =====================================================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin;

-- ---- helpers (live only in this throwaway database copy) ---------------------------------------------------------------
create or replace function public.zz_probe() returns text
language plpgsql security invoker as $$
declare
  v_rows bigint; v_hook text := 'ok';
begin
  select count(*) into v_rows from public.customers;
  begin
    perform public.check_request_session();
  exception when others then
    v_hook := sqlstate;
  end;
  return format('rows=%s org=%s role=%s session_active=%s hook=%s', v_rows,
    left(coalesce(public.current_user_organization_id()::text, '-'), 1), coalesce(public.current_user_role(), '-'),
    public.session_is_active()::text, v_hook);
end $$;

create or replace function public.zz_insert(p_org uuid) returns text
language plpgsql security invoker as $$
begin
  insert into public.customers (organization_id, name) values (p_org, 'zz-revocation-probe');
  return 'inserted';
exception when others then
  return sqlstate;
end $$;

create or replace function public.zz_check(p_case text, p_got text, p_want text) returns text
language sql as $$
  select case when p_got = p_want then 'PASS' else 'FAIL' end || ' | ' || p_case || ' | ' || p_got
         || case when p_got = p_want then '' else '   (wanted ' || p_want || ')' end
$$;
grant usage on schema public to authenticated;
grant execute on function public.zz_probe(), public.zz_insert(uuid), public.zz_check(text, text, text) to authenticated;

-- ---- two companies, four logins ---------------------------------------------------------------------------------------
\set A 'aaaaaaaa-0000-4000-8000-00000000000a'
\set B 'bbbbbbbb-0000-4000-8000-00000000000b'
\set U '11111111-1111-4111-8111-111111111111'
\set V '22222222-2222-4222-8222-222222222222'
\set P '33333333-3333-4333-8333-333333333333'
\set SU 'aaaa1111-0000-4000-8000-000000000001'
\set SV 'aaaa2222-0000-4000-8000-000000000002'
\set SP 'aaaa3333-0000-4000-8000-000000000003'
\set GRANT '99999999-0000-4000-8000-000000000009'

insert into public.organizations (id, name, slug) values (:'A', 'S6 company A', 's6-a'), (:'B', 'S6 company B', 's6-b');
insert into auth.users (id, email) values (:'U', 'u@s6.example.test'), (:'V', 'v@s6.example.test'), (:'P', 'p@s6.example.test');
insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values
  (:'U', 'u@s6.example.test', 'U', 'admin', :'A', true, false),
  (:'V', 'v@s6.example.test', 'V', 'admin', :'B', true, false),
  (:'P', 'p@s6.example.test', 'P', 'admin', :'A', true, false)
  on conflict (id) do update set organization_id = excluded.organization_id, active = true, must_change_password = false;
-- U: admin of A only. V: admin of B only. P: platform owner with a SUPPORT membership in A (2 hours, one grant).
insert into public.organization_members (user_id, organization_id, role, active) values (:'U', :'A', 'admin', true), (:'V', :'B', 'admin', true);
insert into security_audit.platform_admins (user_id, note) values (:'P', 'S6 synthetic platform owner');
insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
  values (:'P', :'A', 'admin', true, true, now() + interval '2 hours', :'GRANT');
insert into public.customers (organization_id, name) values (:'A', 'A customer 1'), (:'A', 'A customer 2'), (:'B', 'B customer 1');
-- Live sign-in sessions. U and V have exactly one company each, so the session needs no explicit choice. P chose A under its grant.
insert into auth.sessions (id, user_id) values (:'SU', :'U'), (:'SV', :'V'), (:'SP', :'P');
insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values (:'SP', :'P', :'A', :'GRANT');

-- claims as the API would hand them to the database
\set cU  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aud":"authenticated","aal":"aal1","session_id":"aaaa1111-0000-4000-8000-000000000001"}'
\set cV  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","aud":"authenticated","aal":"aal1","session_id":"aaaa2222-0000-4000-8000-000000000002"}'
\set cP2 '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","aud":"authenticated","aal":"aal2","session_id":"aaaa3333-0000-4000-8000-000000000003"}'
\set cP1 '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","aud":"authenticated","aal":"aal1","session_id":"aaaa3333-0000-4000-8000-000000000003"}'
-- U's token, but the session id of V's session / no session id / a session that never existed
\set cUother '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aud":"authenticated","aal":"aal1","session_id":"aaaa2222-0000-4000-8000-000000000002"}'
\set cUnone  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aud":"authenticated","aal":"aal1"}'
\set cUghost '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aud":"authenticated","aal":"aal1","session_id":"aaaa9999-0000-4000-8000-000000000009"}'
\set cAnon '{"role":"anon"}'

commit;

-- Each case: begin; change the world as the database owner; become the user; print the probe; rollback. The want string is the
-- whole probe: rows visible, the company and role the database resolves, whether the session is live, and the request hook's answer.

\echo === 0. baseline: signed in, member of A, live session ===
begin; set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('0a U (admin of A) reads A, session live', public.zz_probe(), 'rows=2 org=a role=admin session_active=true hook=ok');
select public.zz_check('0b U writes in A', public.zz_insert(:'A'::uuid), 'inserted');
select public.zz_check('0c U cannot write into B', public.zz_insert(:'B'::uuid), '42501');
rollback;
begin; set local role authenticated; select set_config('request.jwt.claims', :'cV', true);
select public.zz_check('0d V (admin of B only) sees only B', public.zz_probe(), 'rows=1 org=b role=admin session_active=true hook=ok');
rollback;

\echo === 1. membership / account revoked while the session is still alive: the DATABASE refuses every row ===
begin; update public.organization_members set active = false where user_id = :'U' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('1a membership switched off (active=false)', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
select public.zz_check('1a-w   ... and a write is refused', public.zz_insert(:'A'::uuid), '42501');
rollback;
begin; delete from public.organization_members where user_id = :'U' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('1b membership deleted', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin; update public.organization_members set role = 'workshop' where user_id = :'U' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('1c role lowered admin -> workshop: the office tables close at once', public.zz_probe(), 'rows=0 org=a role=workshop session_active=true hook=ok');
select public.zz_check('1c-w   ... and a write is refused', public.zz_insert(:'A'::uuid), '42501');
rollback;
begin; update public.organization_members set role = 'viewer' where user_id = :'U' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('1d role lowered admin -> viewer', public.zz_probe(), 'rows=0 org=a role=viewer session_active=true hook=ok');
rollback;
begin; update public.user_profiles set active = false where id = :'U';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('1e profile disabled (user_profiles.active=false)', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
select public.zz_check('1e-w   ... and a write is refused', public.zz_insert(:'A'::uuid), '42501');
rollback;
begin; update public.user_profiles set must_change_password = true where id = :'U';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('1f forced password change pending (admin-set password)', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin; update public.organizations set status = 'paused' where id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('1g company paused (organizations.status)', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin; update public.organizations set status = 'closed' where id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('1h company closed (organizations.status)', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
-- A is the only company with the revocation; B is untouched.
begin; update public.organization_members set active = false where user_id = :'U' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cV', true);
select public.zz_check('1i revoking U in A changes nothing for V in B', public.zz_probe(), 'rows=1 org=b role=admin session_active=true hook=ok');
rollback;

\echo === 2. the session itself ends (sign-out, password change, timeout): the REQUEST HOOK refuses (SQLSTATE 28000) ===
begin; delete from auth.sessions where id = :'SU';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('2a session row deleted (sign-out elsewhere / password change)', public.zz_probe(), 'rows=2 org=a role=admin session_active=false hook=28000');
rollback;
begin; update auth.sessions set not_after = now() - interval '1 second' where id = :'SU';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('2b session past its not_after (timebox)', public.zz_probe(), 'rows=2 org=a role=admin session_active=false hook=28000');
rollback;
begin; update auth.sessions set not_after = now() + interval '1 hour' where id = :'SU';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('2c session with a future not_after is still live', public.zz_probe(), 'rows=2 org=a role=admin session_active=true hook=ok');
rollback;
begin; set local role authenticated; select set_config('request.jwt.claims', :'cUother', true);
select public.zz_check('2d U''s token carrying ANOTHER user''s live session id', public.zz_probe(), 'rows=2 org=a role=admin session_active=false hook=28000');
rollback;
begin; set local role authenticated; select set_config('request.jwt.claims', :'cUnone', true);
select public.zz_check('2e signed-in token with no session_id claim', public.zz_probe(), 'rows=2 org=a role=admin session_active=false hook=28000');
rollback;
begin; set local role authenticated; select set_config('request.jwt.claims', :'cUghost', true);
select public.zz_check('2f token for a session that never existed', public.zz_probe(), 'rows=2 org=a role=admin session_active=false hook=28000');
rollback;
begin; delete from auth.sessions where id = :'SU';
set local role authenticated; select set_config('request.jwt.claims', :'cV', true);
select public.zz_check('2g ending U''s session does not end V''s', public.zz_probe(), 'rows=1 org=b role=admin session_active=true hook=ok');
rollback;
begin; set local role anon; select set_config('request.jwt.claims', :'cAnon', true);
do $$ begin perform public.check_request_session(); end $$;
select public.zz_check('2h anon requests are not session-checked (the hook lets them through)', 'hook=ok', 'hook=ok');
rollback;
begin; delete from auth.users where id = :'U';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('2i login deleted: sessions cascade away, membership and profile with them', public.zz_probe(), 'rows=0 org=- role=- session_active=false hook=28000');
rollback;

\echo === 3. sign-in ban (auth.users.banned_until): with 119 the database refuses too (no rows, hook 28000); before 119 an issued token lived to its expiry ===
begin; update auth.users set banned_until = now() + interval '100 years' where id = :'U';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('3a banned_until set, nothing else: REFUSED with 119 (the former gap is closed)', public.zz_probe(), 'rows=0 org=- role=- session_active=false hook=28000');
rollback;
begin; update auth.users set banned_until = now() + interval '100 years' where id = :'U';
update public.organization_members set active = false where user_id = :'U' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('3b ban AND membership deactivated (what Deactivate does): refused', public.zz_probe(), 'rows=0 org=- role=- session_active=false hook=28000');
rollback;

\echo === 4. two companies: one chosen for the session; revoking the chosen one must not fall through to data it should not see ===
begin;
insert into public.organization_members (user_id, organization_id, role, active) values (:'U', :'B', 'admin', true);
insert into security_audit.session_company (session_id, user_id, organization_id) values (:'SU', :'U', :'A');
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('4a member of A and B, A chosen: reads A only', public.zz_probe(), 'rows=2 org=a role=admin session_active=true hook=ok');
rollback;
begin;
insert into public.organization_members (user_id, organization_id, role, active) values (:'U', :'B', 'admin', true);
insert into security_audit.session_company (session_id, user_id, organization_id) values (:'SU', :'U', :'A');
update public.organization_members set active = false where user_id = :'U' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('4b chosen company A revoked: lands on B (their only one left), reads nothing of A', public.zz_probe(), 'rows=1 org=b role=admin session_active=true hook=ok');
select public.zz_check('4b-w   ... and cannot write into A', public.zz_insert(:'A'::uuid), '42501');
rollback;
begin;
insert into public.organization_members (user_id, organization_id, role, active) values (:'U', :'B', 'admin', true);
insert into security_audit.session_company (session_id, user_id, organization_id) values (:'SU', :'U', :'A');
update public.organization_members set active = false where user_id = :'U';
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('4c both memberships revoked', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin;
insert into public.organization_members (user_id, organization_id, role, active) values (:'U', :'B', 'admin', true);
set local role authenticated; select set_config('request.jwt.claims', :'cU', true);
select public.zz_check('4d member of A and B, none chosen in this session: nothing resolves', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;

\echo === 5. support session (platform owner inside company A through a support membership) ===
begin; set local role authenticated; select set_config('request.jwt.claims', :'cP2', true);
select public.zz_check('5a support at aal2 under its grant: reads the company', public.zz_probe(), 'rows=2 org=a role=admin session_active=true hook=ok');
select public.zz_check('5b ... but read-only: the write is refused (support_read_only)', public.zz_insert(:'A'::uuid), '42501');
select public.zz_check('5c ... session_read_only() is true', public.session_read_only()::text, 'true');
rollback;
begin; update security_audit.session_company set elevated_until = now() + interval '30 minutes' where session_id = :'SP';
set local role authenticated; select set_config('request.jwt.claims', :'cP2', true);
select public.zz_check('5d elevated: writes allowed while the elevation lasts', public.zz_insert(:'A'::uuid), 'inserted');
rollback;
begin; update security_audit.session_company set elevated_until = now() - interval '1 second' where session_id = :'SP';
set local role authenticated; select set_config('request.jwt.claims', :'cP2', true);
select public.zz_check('5e elevation ran out: read-only again', public.zz_insert(:'A'::uuid), '42501');
rollback;
begin; update public.organization_members set expires_at = now() - interval '1 second' where user_id = :'P' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cP2', true);
select public.zz_check('5f support window expired: the open session sees nothing', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin; update public.organization_members set active = false where user_id = :'P' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cP2', true);
select public.zz_check('5g company admin revoked the support access: the open session sees nothing', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin; update public.organization_members set support_grant = gen_random_uuid() where user_id = :'P' and organization_id = :'A';
set local role authenticated; select set_config('request.jwt.claims', :'cP2', true);
select public.zz_check('5h window reopened under a NEW grant: the earlier session gets nothing back', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin; set local role authenticated; select set_config('request.jwt.claims', :'cP1', true);
select public.zz_check('5i platform owner on a password-only (aal1) token: no company at all', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin; delete from security_audit.platform_admins where user_id = :'P';
set local role authenticated; select set_config('request.jwt.claims', :'cP2', true);
select public.zz_check('5j taken off the platform list: the support membership stops counting', public.zz_probe(), 'rows=0 org=- role=- session_active=true hook=ok');
rollback;
begin; delete from auth.sessions where id = :'SP';
set local role authenticated; select set_config('request.jwt.claims', :'cP2', true);
select public.zz_check('5k support session signed out (its company choice goes with it): hook refuses, nothing resolves', public.zz_probe(), 'rows=0 org=- role=- session_active=false hook=28000');
rollback;

\echo === done: the helpers and all test rows live only in this throwaway database ===

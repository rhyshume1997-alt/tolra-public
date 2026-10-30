-- =====================================================================================================
-- 116 proof (finding S6-1): a disabled sign-in (auth.users.banned_until in the future) ends the session in the database at once.
-- READ ONLY: the whole run is ONE transaction that is rolled back at the end (each case is a savepoint rolled back), so it can be
-- run again and again on the same copy and leaves nothing behind.
--
-- Runs on a plain PostgreSQL copy with the migration chain (000 to 116) and the Supabase role/auth stand-ins, NEVER on a hosted project:
--
--   create database s6b template sec_base;      -- then apply supabase/release/116_ban_ends_session.release.sql to it
--   PGPASSWORD=localonly psql -h 127.0.0.1 -U postgres -d s6b -v ON_ERROR_STOP=1 -q -f tests/scripts/ban-ends-session-116.proof.sql
--
-- A signed-in user is simulated as the API does it: `set local role authenticated` plus the token's claims in request.jwt.claims.
-- Every result line is `PASS|FAIL | case | what came back`; a clean run has no FAIL line (the script sets no exit code for a FAIL).
-- The probe reads: customers visible (row rules), org-logos objects visible (033's Storage rule calls session_is_active), the company
-- and role the database resolves, how many rows _session_membership() gives, session_is_active(), and the request hook's answer
-- (check_request_session, which PostgREST runs before every signed-in REST/RPC request: 28000 = "Your session has ended").
-- Set-up copied from tests/scripts/session-revocation-proof.sql (S6). Mirrored in tests/db/session-revocation.test.ts, case 3.
-- Without 116 (rolled back, or either banned_until test removed) M, B1, B3a, B5b and B8 FAIL (and B1-w, B8-w without 036's half).
-- =====================================================================================================
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

begin;

-- ---- helpers (rolled back with everything else) ------------------------------------------------------------------------------
-- _session_membership() is callable by no API role (036), so the probe asks it through this definer wrapper (same claims).
create or replace function public.zz_membership_rows() returns bigint
language sql stable security definer set search_path = pg_catalog, public as $$ select count(*) from public._session_membership() $$;

create or replace function public.zz_probe() returns text
language plpgsql security invoker as $$
declare
  v_rows bigint; v_logos bigint; v_hook text := 'ok';
begin
  select count(*) into v_rows from public.customers;
  select count(*) into v_logos from storage.objects where bucket_id = 'org-logos';
  begin
    perform public.check_request_session();
  exception when others then
    v_hook := sqlstate;
  end;
  return format('rows=%s logos=%s org=%s role=%s membership=%s session_active=%s hook=%s', v_rows, v_logos,
    left(coalesce(public.current_user_organization_id()::text, '-'), 1), coalesce(public.current_user_role(), '-'),
    public.zz_membership_rows(), public.session_is_active()::text, v_hook);
end $$;

create or replace function public.zz_insert(p_org uuid) returns text
language plpgsql security invoker as $$
begin
  insert into public.customers (organization_id, name) values (p_org, 'zz-ban-probe');
  return 'inserted';
exception when others then
  return sqlstate;
end $$;

create or replace function public.zz_check(p_case text, p_got text, p_want text) returns text
language sql as $$
  select case when p_got = p_want then 'PASS' else 'FAIL' end || ' | ' || p_case || ' | ' || p_got
         || case when p_got = p_want then '' else '   (wanted ' || p_want || ')' end
$$;
grant execute on function public.zz_probe(), public.zz_insert(uuid), public.zz_check(text, text, text), public.zz_membership_rows() to authenticated;

-- ---- two companies, three logins (as S6) ------------------------------------------------------------------------------------
\set A 'aaaaaaaa-0000-4000-8000-00000000000a'
\set B 'bbbbbbbb-0000-4000-8000-00000000000b'
\set U '11111111-1111-4111-8111-111111111111'
\set V '22222222-2222-4222-8222-222222222222'
\set P '33333333-3333-4333-8333-333333333333'
\set SU 'aaaa1111-0000-4000-8000-000000000001'
\set SV 'aaaa2222-0000-4000-8000-000000000002'
\set SP 'aaaa3333-0000-4000-8000-000000000003'
\set GRANT '99999999-0000-4000-8000-000000000009'

insert into public.organizations (id, name, slug) values (:'A', 'S6b company A', 's6b-a'), (:'B', 'S6b company B', 's6b-b');
insert into auth.users (id, email) values (:'U', 'u@s6b.example.test'), (:'V', 'v@s6b.example.test'), (:'P', 'p@s6b.example.test');
insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values
  (:'U', 'u@s6b.example.test', 'U', 'admin', :'A', true, false),
  (:'V', 'v@s6b.example.test', 'V', 'admin', :'B', true, false),
  (:'P', 'p@s6b.example.test', 'P', 'admin', :'A', true, false)
  on conflict (id) do update set organization_id = excluded.organization_id, active = true, must_change_password = false;
-- U: admin of A only. V: admin of B only. P: platform owner with a SUPPORT membership in A (2 hours, one grant).
insert into public.organization_members (user_id, organization_id, role, active) values (:'U', :'A', 'admin', true), (:'V', :'B', 'admin', true);
insert into security_audit.platform_admins (user_id, note) values (:'P', 'S6b synthetic platform owner');
insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
  values (:'P', :'A', 'admin', true, true, now() + interval '2 hours', :'GRANT');
insert into public.customers (organization_id, name) values (:'A', 'A customer 1'), (:'A', 'A customer 2'), (:'B', 'B customer 1');
insert into storage.objects (bucket_id, name) values ('org-logos', :'A' || '/logo.png'), ('org-logos', :'B' || '/logo.png');
insert into auth.sessions (id, user_id) values (:'SU', :'U'), (:'SV', :'V'), (:'SP', :'P');
insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values (:'SP', :'P', :'A', :'GRANT');

\set cU  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aud":"authenticated","aal":"aal1","session_id":"aaaa1111-0000-4000-8000-000000000001"}'
\set cV  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","aud":"authenticated","aal":"aal1","session_id":"aaaa2222-0000-4000-8000-000000000002"}'
\set cP2 '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","aud":"authenticated","aal":"aal2","session_id":"aaaa3333-0000-4000-8000-000000000003"}'
\set cP1 '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","aud":"authenticated","aal":"aal1","session_id":"aaaa3333-0000-4000-8000-000000000003"}'
\set cAnon '{"role":"anon"}'
\set ban   'update auth.users set banned_until = now() + interval ''100 years'''
\set live  '''rows=2 logos=1 org=a role=admin membership=1 session_active=true hook=ok'''
\set ended '''rows=0 logos=0 org=- role=- membership=0 session_active=false hook=28000'''

\echo === 116 applied? ===
select public.zz_check('M  marker: session_is_active and _session_membership are 116''s',
  (exists (select 1 from pg_proc where oid = 'public.session_is_active()'::regprocedure and md5(regexp_replace(prosrc, '\s', '', 'g')) = 'af6457cae4d8b89cd34b5963574fbe58')
   and exists (select 1 from pg_proc where oid = 'public._session_membership()'::regprocedure and md5(regexp_replace(prosrc, '\s', '', 'g')) = 'b9c4e5c7147e1c7893b4e586dae0be2e'))::text, 'true');

\echo === B0. baseline: U signed in, member of A, live session ===
savepoint c; set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B0 U reads A (rows, logo), one membership, session live', public.zz_probe(), :live);
select public.zz_check('B0-w U writes in A', public.zz_insert(:'A'::uuid), 'inserted');
rollback to savepoint c;

\echo === B1. sign-in disabled (ban only, membership kept: what Admin > Users "Disable sign-in" does) ===
savepoint c; :ban where id = :'U';
set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B1 the same live token: request hook refuses (28000), no membership, no rows, no Storage', public.zz_probe(), :ended);
select public.zz_check('B1-w ... and a write is refused', public.zz_insert(:'A'::uuid), '42501');
rollback to savepoint c;

\echo === B2. a ban that has run out is no ban (as Auth rules it: banned_until > now()) ===
savepoint c; update auth.users set banned_until = now() - interval '1 second' where id = :'U';
set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B2 banned_until in the past: works', public.zz_probe(), :live);
rollback to savepoint c;

\echo === B3. unban: the same token works again (while it is still valid) ===
savepoint c; :ban where id = :'U';
set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B3a banned', public.zz_probe(), :ended);
reset role;
update auth.users set banned_until = null where id = :'U';
set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B3b unbanned (banned_until NULL, what ban_duration none stores): works again', public.zz_probe(), :live);
select public.zz_check('B3b-w ... and writes again', public.zz_insert(:'A'::uuid), 'inserted');
rollback to savepoint c;

\echo === B4. only the banned login is affected ===
savepoint c; :ban where id = :'U';
set local role authenticated; set local request.jwt.claims = :'cV';
select public.zz_check('B4 U banned: V in B unchanged', public.zz_probe(), 'rows=1 logos=1 org=b role=admin membership=1 session_active=true hook=ok');
rollback to savepoint c;

\echo === B5. Deactivate (membership off) is unchanged; with a ban on top the hook refuses too ===
savepoint c; update public.organization_members set active = false where user_id = :'U' and organization_id = :'A';
set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B5a membership off, no ban: as before 116 (no rows, session still live)', public.zz_probe(), 'rows=0 logos=0 org=- role=- membership=0 session_active=true hook=ok');
select public.zz_check('B5a-w ... write refused', public.zz_insert(:'A'::uuid), '42501');
rollback to savepoint c;
savepoint c; :ban where id = :'U';
update public.organization_members set active = false where user_id = :'U' and organization_id = :'A';
set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B5b ban AND membership off (what Deactivate does): refused, hook 28000', public.zz_probe(), :ended);
rollback to savepoint c;

\echo === B6. the other session rules are unchanged ===
savepoint c; delete from auth.sessions where id = :'SU';
set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B6a session row deleted, not banned: hook 28000, row rules still answer (as 017)', public.zz_probe(), 'rows=2 logos=0 org=a role=admin membership=1 session_active=false hook=28000');
rollback to savepoint c;
savepoint c; update public.user_profiles set active = false where id = :'U';
set local role authenticated; set local request.jwt.claims = :'cU';
select public.zz_check('B6b profile disabled, not banned: as before', public.zz_probe(), 'rows=0 logos=0 org=- role=- membership=0 session_active=true hook=ok');
rollback to savepoint c;
savepoint c; set local role anon; set local request.jwt.claims = :'cAnon';
do $$ begin perform public.check_request_session(); end $$;
select public.zz_check('B6c anon requests still pass the hook untouched', 'hook=ok', 'hook=ok');
rollback to savepoint c;

\echo === B7. support sessions: unchanged unless the platform owner login itself is banned ===
savepoint c; set local role authenticated; set local request.jwt.claims = :'cP2';
select public.zz_check('B7a support at aal2 under its grant: reads A', public.zz_probe(), :live);
select public.zz_check('B7b ... read-only (support_read_only)', public.zz_insert(:'A'::uuid), '42501');
rollback to savepoint c;
savepoint c; update security_audit.session_company set elevated_until = now() + interval '30 minutes' where session_id = :'SP';
set local role authenticated; set local request.jwt.claims = :'cP2';
select public.zz_check('B7c elevated: writes', public.zz_insert(:'A'::uuid), 'inserted');
rollback to savepoint c;
savepoint c; update public.organization_members set expires_at = now() - interval '1 second' where user_id = :'P' and organization_id = :'A';
set local role authenticated; set local request.jwt.claims = :'cP2';
select public.zz_check('B7d support window expired: nothing (as before)', public.zz_probe(), 'rows=0 logos=0 org=- role=- membership=0 session_active=true hook=ok');
rollback to savepoint c;
savepoint c; set local role authenticated; set local request.jwt.claims = :'cP1';
select public.zz_check('B7e platform owner at aal1: nothing (as before)', public.zz_probe(), 'rows=0 logos=0 org=- role=- membership=0 session_active=true hook=ok');
rollback to savepoint c;
savepoint c; :ban where id = :'U';
set local role authenticated; set local request.jwt.claims = :'cP2';
select public.zz_check('B7f another login banned: the support session is unchanged', public.zz_probe(), :live);
rollback to savepoint c;

\echo === B8. the platform owner login itself banned: the support session ends too ===
savepoint c; :ban where id = :'P';
update security_audit.session_company set elevated_until = now() + interval '30 minutes' where session_id = :'SP';
set local role authenticated; set local request.jwt.claims = :'cP2';
select public.zz_check('B8 banned platform owner, elevated support session: refused', public.zz_probe(), :ended);
select public.zz_check('B8-w ... and the elevated write is refused', public.zz_insert(:'A'::uuid), '42501');
rollback to savepoint c;

rollback;
\echo === done: everything above was rolled back ===

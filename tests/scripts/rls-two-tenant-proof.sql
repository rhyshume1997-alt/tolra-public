-- Two-company row-level-security proof over EVERY table with an organization_id (S1, pre-go-live security pass).
--
-- tests/db/tenancy.test.ts proves cross-company CRUD through the real API for 12 business tables, and
-- tests/db/definer-functions.test.ts points every SECURITY DEFINER function at the other company's ids. This script closes the
-- gap between them: it finds every table that carries an organization_id (from the catalogue, so a new table is covered without
-- an edit), puts one row of company ALPHA and one of company BETA in each, then, signed in as each of alpha's four roles exactly
-- as PostgREST runs a request (role authenticated + request.jwt.claims), tries to read, insert, update, move and delete beta's
-- rows. Every attempt must see / change 0 rows or be refused. Signed-out (anon) requests are tried too.
--
-- "RLS only" mode: the attacks run with session_replication_role = replica, so NO trigger fires (no organization_id-filling
-- trigger, no guard, no foreign key): the row-level-security policies alone must refuse. That is the strictest form of the proof.
-- The inserts are tried a second time with every trigger on ("as deployed").
--
-- Seeding is not under test: rows are written as the owner with triggers off, and where the generic row breaks a table's CHECK
-- rule those rules are dropped inside this transaction. Everything (rows, users, dropped constraints) is rolled back at the end: the script leaves no trace.
--
-- Run:  psql -X -v ON_ERROR_STOP=1 -d <disposable database> -f tests/scripts/rls-two-tenant-proof.sql
-- CI:   tests/db/rls-two-tenant-proof.test.ts runs this file against the local stack. It raises (and psql exits non-zero) on any
--       failure, naming each table, role and attempt.

begin;

create temp table s1_result (
  tbl text, who text, attempt text, outcome text, ok boolean
) on commit drop;

-- 1. Two companies, one person per role in each, each with a live session bound to their company (as sign-in leaves it).
create temp table s1_people (tenant text, role text, uid uuid, sess uuid, org uuid) on commit drop;

do $$
declare
  v_tenant text; v_role text; v_org uuid; v_uid uuid; v_sess uuid;
begin
  foreach v_tenant in array array['alpha', 'beta'] loop
    insert into public.organizations (name, slug) values ('S1 proof ' || v_tenant, 't-s1proof-' || v_tenant) returning id into v_org;
    foreach v_role in array array['admin', 'office', 'workshop', 'viewer'] loop
      v_uid := gen_random_uuid(); v_sess := gen_random_uuid();
      insert into auth.users (id, email) values (v_uid, v_role || '.' || v_tenant || '.s1proof@example.test');
      insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
        values (v_uid, v_role || '.' || v_tenant || '.s1proof@example.test', 'S1 ' || v_role || ' ' || v_tenant, v_role, v_org, true, false);
      insert into public.organization_members (user_id, organization_id, role, active) values (v_uid, v_org, v_role, true);
      insert into auth.sessions (id, user_id) values (v_sess, v_uid);
      insert into security_audit.session_company (session_id, user_id, organization_id) values (v_sess, v_uid, v_org);
      insert into s1_people values (v_tenant, v_role, v_uid, v_sess, v_org);
    end loop;
  end loop;
end $$;

-- Every table under test: each base table (public, security_audit) with an organization_id column that is not dropped.
create temp table s1_tables on commit drop as
  select c.oid::regclass as tbl, format('%I.%I', n.nspname, c.relname) as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
  where n.nspname in ('public', 'security_audit') and c.relkind in ('r', 'p');

-- A generic INSERT for a table: organization_id given, every NOT NULL column without a default filled by type, columns that
-- name a person (user_id, *_by) set to p_actor so a "this is me" check is satisfied and the company is the only thing wrong.
create function pg_temp.s1_insert_sql(p_tbl regclass, p_org uuid, p_actor uuid) returns text language plpgsql as $f$
declare
  r record; v_cols text[] := array['organization_id']; v_vals text[] := array[quote_literal(p_org) || '::uuid'];
  v_type text; v_base oid; v_kind char;
begin
  for r in
    select a.attname, a.atttypid, a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity
    from pg_attribute a where a.attrelid = p_tbl and a.attnum > 0 and not a.attisdropped and a.attname <> 'organization_id'
    order by a.attnum
  loop
    continue when r.attgenerated <> '' or r.attidentity <> '';
    continue when not (r.attnotnull and not r.atthasdef) and not (r.attname ~ '(^user_id$|_by$)' and r.atttypid = 'uuid'::regtype);
    v_base := r.atttypid;
    select t.typtype into v_kind from pg_type t where t.oid = v_base;
    if v_kind = 'd' then select t.typbasetype into v_base from pg_type t where t.oid = v_base; select t.typtype into v_kind from pg_type t where t.oid = v_base; end if;
    v_type := format_type(v_base, null);
    v_cols := v_cols || quote_ident(r.attname);
    v_vals := v_vals || case
      when v_type = 'uuid' and (r.attname ~ '(^user_id$|_by$)' or (p_tbl = 'public.user_profiles'::regclass and r.attname = 'id')) then quote_literal(p_actor) || '::uuid'
      when v_type = 'uuid' then 'gen_random_uuid()'
      when v_kind = 'e' then quote_literal((select e.enumlabel from pg_enum e where e.enumtypid = v_base order by e.enumsortorder limit 1)) || '::' || v_type
      when v_type like '%[]' then quote_literal('{}') || '::' || v_type
      when v_type in ('text', 'character varying', 'citext', 'name', 'character') then quote_literal('s1-' || left(md5(random()::text), 12))
      when v_type in ('integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision') then '1'
      when v_type = 'boolean' then 'false'
      when v_type = 'date' then 'current_date'
      when v_type like 'timestamp%' then 'now()'
      when v_type like 'time%' then quote_literal('08:00') || '::' || v_type
      when v_type = 'interval' then quote_literal('1 hour') || '::interval'
      when v_type in ('jsonb', 'json') then quote_literal('{}') || '::' || v_type
      when v_type in ('inet', 'cidr') then quote_literal('10.0.0.1') || '::' || v_type
      when v_type = 'bytea' then quote_literal('\x00') || '::bytea'
      when v_type = 'tstzrange' then 'tstzrange(now(), now() + interval ''1 hour'')'
      when v_type = 'daterange' then 'daterange(current_date, current_date + 1)'
      else 'null' end;
  end loop;
  -- user_profiles' id is a person: a fresh one each time, unless the caller is inserting themselves (never here).
  if p_tbl = 'public.user_profiles'::regclass and not ('id' = any (v_cols)) then v_cols := v_cols || 'id'::text; v_vals := v_vals || 'gen_random_uuid()'; end if;
  return format('insert into %s (%s) values (%s)', p_tbl, array_to_string(v_cols, ', '), array_to_string(v_vals, ', '));
end $f$;

-- 2. Seed: one row of each company in every table (as the owner, with triggers off; CHECK rules set aside only where needed).
do $$
declare
  t record; c record; v_org uuid; v_actor uuid; v_tenant text; v_err text;
begin
  set local session_replication_role = replica;
  for t in select * from s1_tables order by name loop
    foreach v_tenant in array array['alpha', 'beta'] loop
      select org, uid into v_org, v_actor from s1_people where tenant = v_tenant and role = 'admin';
      begin
        execute pg_temp.s1_insert_sql(t.tbl, v_org, v_actor);
      exception when unique_violation then null;  -- the company already has its one row here (made with the company or person)
      when check_violation then
        -- The generic row breaks one of the table's CHECK rules (a status list, a positive amount): those rules are not under test,
        -- so they are dropped for this transaction only and the row is written again.
        for c in select conname from pg_constraint where conrelid = t.tbl and contype = 'c' loop
          execute format('alter table %s drop constraint %I', t.tbl, c.conname);
        end loop;
        insert into s1_result values (t.name, 'owner', 'CHECK rules set aside to seed', 'dropped until rollback', true);
        begin
          execute pg_temp.s1_insert_sql(t.tbl, v_org, v_actor);
        exception when unique_violation then null;
        when others then
          get stacked diagnostics v_err = message_text;
          insert into s1_result values (t.name, 'owner', 'seed ' || v_tenant, v_err, false);
        end;
      when others then
        get stacked diagnostics v_err = message_text;
        insert into s1_result values (t.name, 'owner', 'seed ' || v_tenant, v_err, false);
      end;
    end loop;
  end loop;
  set local session_replication_role = origin;
  -- Not vacuous: every table holds at least one row of each company.
  insert into s1_result
    select s.name, 'owner', 'seeded both companies',
           format('alpha %s, beta %s', a.n, b.n), a.n > 0 and b.n > 0
    from s1_tables s
    cross join lateral (select 1) x
    cross join lateral (select 0) y,
    lateral (select (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s where organization_id = %L', s.tbl, (select org from s1_people where tenant = 'alpha' limit 1)), false, true, '')))[1]::text::int as n) a,
    lateral (select (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s where organization_id = %L', s.tbl, (select org from s1_people where tenant = 'beta' limit 1)), false, true, '')))[1]::text::int as n) b;
end $$;

-- A fingerprint of everything beta owns, to compare at the end.
create temp table s1_beta_before on commit drop as
  select s.name, (xpath('/row/h/text()', query_to_xml(format(
    'select md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) as h from %s t where organization_id = %L',
    s.tbl, (select org from s1_people where tenant = 'beta' limit 1)), false, true, '')))[1]::text as h
  from s1_tables s;

-- 3. The attacks. One request = one subtransaction as role authenticated with that person's claims; every attempt is rolled
-- back (a sentinel exception) after its row count is taken, so no attempt can affect the next.
-- p_check, when given, runs as the owner straight after the attempt (still inside it) and its count is reported as "beta=<n>":
-- it is how an UNFILTERED update or delete is judged, since the caller cannot see what it did to rows it cannot read.
create function pg_temp.s1_try(p_sql text, p_uid uuid, p_sess uuid, p_anon boolean, p_replica boolean, p_check text default null) returns text language plpgsql as $f$
declare v_n bigint; v_c bigint; v_state text; v_msg text;
begin
  begin
    if p_replica then set local session_replication_role = replica; end if;
    if p_anon then
      set local role anon;
      perform set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('request.jwt.claim.sub', '', true);
    else
      set local role authenticated;
      perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal2', 'session_id', p_sess)::text, true),
              set_config('request.jwt.claim.sub', p_uid::text, true);
    end if;
    if p_sql ~* '^\s*select' then execute p_sql into v_n; else execute p_sql; get diagnostics v_n = row_count; end if;
    if p_check is not null then
      reset role;
      execute p_check into v_c;
      raise exception using errcode = 'S1000', message = v_n::text || ' beta=' || v_c::text;
    end if;
    raise exception using errcode = 'S1000', message = v_n::text;
  exception
    when sqlstate 'S1000' then get stacked diagnostics v_msg = message_text; return 'rows=' || v_msg;
    when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text; return 'error ' || v_state || ': ' || v_msg;
  end;
end $f$;

do $$
declare
  t record; p record; v_alpha uuid; v_beta uuid; v_out text; v_sql text; v_who text;
begin
  select org into v_alpha from s1_people where tenant = 'alpha' limit 1;
  select org into v_beta from s1_people where tenant = 'beta' limit 1;
  for p in select * from s1_people where tenant = 'alpha' union all select 'alpha', 'anon', null, null, v_alpha order by role loop
    v_who := case when p.role = 'anon' then 'anon' else 'alpha ' || p.role end;
    for t in select s.*, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s where organization_id = %L', s.tbl, v_beta), false, true, '')))[1]::text as beta_rows
             from s1_tables s order by name loop
      -- Sanity: what the person sees of their own company (informational: the role matrix tests pin who may read what).
      v_out := pg_temp.s1_try(format('select count(*) from %s where organization_id = %L', t.tbl, v_alpha), p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'read own company', v_out, v_out like 'rows=%' or v_out like 'error 42501%');
      -- READ: nothing of any other company (by organization_id, and with no filter at all).
      v_out := pg_temp.s1_try(format('select count(*) from %s where organization_id is distinct from %L', t.tbl, v_alpha), p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'read beta rows', v_out, v_out = 'rows=0' or v_out like 'error 42501%');
      -- INSERT a row for beta: RLS alone must refuse (42501), and also refused with every trigger on.
      v_sql := pg_temp.s1_insert_sql(t.tbl, v_beta, coalesce(p.uid, gen_random_uuid()));
      v_out := pg_temp.s1_try(v_sql, p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'insert beta row (RLS only)', v_out, v_out like 'error 42501%');
      v_out := pg_temp.s1_try(v_sql, p.uid, p.sess, p.role = 'anon', false);
      insert into s1_result values (t.name, v_who, 'insert beta row (as deployed)', v_out, v_out like 'error %');
      -- INSERT a row for alpha (informational: shows the generic row is accepted where the role may write, so the refusal
      -- above is about the company).
      v_out := pg_temp.s1_try(pg_temp.s1_insert_sql(t.tbl, v_alpha, coalesce(p.uid, gen_random_uuid())), p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'insert own row (control)', v_out, true);
      -- UPDATE beta's rows in place, and try to take them over into alpha.
      v_out := pg_temp.s1_try(format('update %s set organization_id = organization_id where organization_id = %L', t.tbl, v_beta), p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'update beta rows', v_out, v_out = 'rows=0' or v_out like 'error 42501%');
      v_out := pg_temp.s1_try(format('update %s set organization_id = %L where organization_id = %L', t.tbl, v_alpha, v_beta), p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'move beta rows into alpha', v_out, v_out = 'rows=0' or v_out like 'error 42501%');
      -- UPDATE: push alpha's own rows into beta (WITH CHECK must refuse, or the role may not update at all). Tried RLS-only and
      -- as deployed. One documented exception to the RLS-only rule, public.user_profiles: its organization_id is the person's
      -- "current company" pointer, which no policy or _session_membership() reads (access comes from organization_members);
      -- its update policies let a person edit their own row and an admin their members' rows, and user_profiles_guard (a
      -- trigger) refuses a change of organization_id to a company the person is not an active member of. So for that table
      -- the as-deployed attempt is the one that must be refused.
      v_sql := format('update %s set organization_id = %L where organization_id = %L', t.tbl, v_beta, v_alpha);
      v_out := pg_temp.s1_try(v_sql, p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'move own rows into beta (RLS only)', v_out,
        v_out = 'rows=0' or v_out like 'error 42501%' or t.name = 'public.user_profiles');
      v_out := pg_temp.s1_try(v_sql, p.uid, p.sess, p.role = 'anon', false);
      insert into s1_result values (t.name, v_who, 'move own rows into beta (as deployed)', v_out, v_out = 'rows=0' or v_out like 'error %');
      -- DELETE beta's rows.
      v_out := pg_temp.s1_try(format('delete from %s where organization_id = %L', t.tbl, v_beta), p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'delete beta rows', v_out, v_out = 'rows=0' or v_out like 'error 42501%');
      -- UNFILTERED update and delete: with no WHERE clause PostgreSQL applies only the UPDATE / DELETE policy (not the SELECT
      -- one), so this tests those policies on their own. Afterwards beta must still own exactly the rows it had.
      v_sql := format('select count(*) from %s where organization_id = %L', t.tbl, v_beta);
      v_out := pg_temp.s1_try(format('update %s set organization_id = %L', t.tbl, v_alpha), p.uid, p.sess, p.role = 'anon', true, v_sql);
      insert into s1_result values (t.name, v_who, 'unfiltered update takes nothing of beta''s', v_out,
        v_out like 'error 42501%' or v_out like '% beta=' || t.beta_rows);
      v_out := pg_temp.s1_try(format('delete from %s', t.tbl), p.uid, p.sess, p.role = 'anon', true, v_sql);
      insert into s1_result values (t.name, v_who, 'unfiltered delete removes nothing of beta''s', v_out,
        v_out like 'error 42501%' or v_out like '% beta=' || t.beta_rows);
    end loop;
    -- Views with an organization_id (audit_log_view at 101; each must be security_invoker so the caller's RLS applies): read only.
    for t in select format('%I.%I', n.nspname, c.relname) as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
             join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
             where n.nspname = 'public' and c.relkind in ('v', 'm') order by 1 loop
      v_out := pg_temp.s1_try(format('select count(*) from %s where organization_id is distinct from %L', t.name, v_alpha), p.uid, p.sess, p.role = 'anon', true);
      insert into s1_result values (t.name, v_who, 'read beta rows (view)', v_out, v_out = 'rows=0' or v_out like 'error 42501%');
    end loop;
    -- The companies themselves (organizations has no organization_id: its id is the company).
    v_out := pg_temp.s1_try(format('select count(*) from public.organizations where id <> %L', v_alpha), p.uid, p.sess, p.role = 'anon', true);
    insert into s1_result values ('public.organizations', v_who, 'read beta rows', v_out, v_out = 'rows=0' or v_out like 'error 42501%');
    v_out := pg_temp.s1_try(format('update public.organizations set name = name where id = %L', v_beta), p.uid, p.sess, p.role = 'anon', true);
    insert into s1_result values ('public.organizations', v_who, 'update beta rows', v_out, v_out = 'rows=0' or v_out like 'error 42501%');
    v_out := pg_temp.s1_try(format('delete from public.organizations where id = %L', v_beta), p.uid, p.sess, p.role = 'anon', true);
    insert into s1_result values ('public.organizations', v_who, 'delete beta rows', v_out, v_out = 'rows=0' or v_out like 'error 42501%');
  end loop;
end $$;

-- 4. Beta's rows are exactly as they were.
insert into s1_result
  select b.name, 'owner', 'beta rows unchanged', case when b.h = a.h then 'same' else 'CHANGED' end, b.h = a.h
  from s1_beta_before b
  join (select s.name, (xpath('/row/h/text()', query_to_xml(format(
          'select md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) as h from %s t where organization_id = %L',
          s.tbl, (select org from s1_people where tenant = 'beta' limit 1)), false, true, '')))[1]::text as h
        from s1_tables s) a using (name);

-- 5. Not vacuous: signed in as alpha's admin, every table authenticated may SELECT shows alpha's own row (so "0 beta rows" is
-- RLS filtering, not a broken sign-in). One documented exception: public.document_attachments, whose read policy needs the
-- row to hang off a delivery note or purchase order, which the generic row does not (tests/db/document-attachments.test.ts).
insert into s1_result
  select r.tbl, r.who, 'admin sees own company (control)', r.outcome, r.outcome ~ '^rows=[1-9]'
  from s1_result r join s1_tables s on s.name = r.tbl
  where r.who = 'alpha admin' and r.attempt = 'read own company' and has_table_privilege('authenticated', s.tbl, 'SELECT')
    and r.tbl <> 'public.document_attachments';

-- Summary: per attempt, how many checks and how many failed; then every failure.
select attempt, count(*) as checks, count(*) filter (where not ok) as failed from s1_result group by attempt order by attempt;
select (select count(*) from s1_tables) as tables_with_organization_id,
       (select count(distinct who) from s1_result where who <> 'owner') as callers,
       count(*) as checks, count(*) filter (where not ok) as failed from s1_result;
select tbl, who, attempt, outcome from s1_result where not ok order by tbl, who, attempt;

do $$
declare v_failed text;
begin
  select string_agg(format('%s / %s / %s: %s', tbl, who, attempt, outcome), E'\n' order by tbl, who, attempt) into v_failed from s1_result where not ok;
  if v_failed is not null then
    raise exception 'S1 two-company RLS proof FAILED:%', E'\n' || v_failed;
  end if;
  raise notice 'S1 two-company RLS proof passed: % checks over % tables', (select count(*) from s1_result), (select count(*) from s1_tables);
end $$;

rollback;

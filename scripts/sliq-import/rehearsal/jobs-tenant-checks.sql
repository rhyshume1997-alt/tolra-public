-- Part B rehearsal checks that need a signed-in user: who sees the imported jobs, job prices, sales orders and opening WIP, that no
-- signed-in user can write opening WIP, and that new jobs and sales orders take the numbers after SliQ's. Synthetic tenants from
-- setup-tenants.sql. ONE transaction, ROLLED BACK, so it can be repeated and leaves the database as the import left it.
--
--   psql -h 127.0.0.1 -U postgres -d <rehearsal db> -X -At -v ON_ERROR_STOP=1 -f scripts/sliq-import/rehearsal/jobs-tenant-checks.sql
--
-- Every result line is "PASS|<check>|<detail>" or "FAIL|<check>|<detail>".
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\pset format unaligned
begin;
set local timezone to 'UTC';
select id as org_a from public.organizations where slug = 'rehearsal-a' \gset
select id as org_b from public.organizations where slug = 'rehearsal-b' \gset
\set admin_a '{"sub":"7e570000-0000-4000-8000-0000000000a1","role":"authenticated","aud":"authenticated","session_id":"7e570000-0000-4000-8000-0000000005a1","aal":"aal2","email":"admin.a@rehearsal.example.test"}'
\set office_a '{"sub":"7e570000-0000-4000-8000-0000000000a2","role":"authenticated","aud":"authenticated","session_id":"7e570000-0000-4000-8000-0000000005a2","aal":"aal2","email":"office.a@rehearsal.example.test"}'
\set workshop_a '{"sub":"7e570000-0000-4000-8000-0000000000a3","role":"authenticated","aud":"authenticated","session_id":"7e570000-0000-4000-8000-0000000005a3","aal":"aal2","email":"workshop.a@rehearsal.example.test"}'
\set admin_b '{"sub":"7e570000-0000-4000-8000-0000000000b1","role":"authenticated","aud":"authenticated","session_id":"7e570000-0000-4000-8000-0000000005b1","aal":"aal2","email":"admin.b@rehearsal.example.test"}'

create schema rehearsal_jchk;
grant usage on schema rehearsal_jchk to authenticated;
create table rehearsal_jchk.out (n serial, line text);
grant all on rehearsal_jchk.out to authenticated;
grant usage on sequence rehearsal_jchk.out_n_seq to authenticated;
create function rehearsal_jchk.ok(p_check text, p_ok boolean, p_detail text) returns void language sql as $f$
  insert into rehearsal_jchk.out (line) values ((case when p_ok then 'PASS' else 'FAIL' end) || '|' || p_check || '|' || coalesce(p_detail, ''))
$f$;
-- p_sql must be refused (any error) or change no row.
create function rehearsal_jchk.no_write(p_check text, p_sql text) returns void language plpgsql as $f$
declare n bigint;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
  exception when others then
    perform rehearsal_jchk.ok(p_check, true, 'refused: ' || left(sqlerrm, 90));
    return;
  end;
  perform rehearsal_jchk.ok(p_check, n = 0, n || ' row(s) changed');
end
$f$;
grant execute on all functions in schema rehearsal_jchk to authenticated;

create table rehearsal_jchk.truth as select
  (select count(*) from public.jobs where organization_id = :'org_a') jobs,
  (select count(*) from public.job_values where organization_id = :'org_a') job_values,
  (select count(*) from public.sales_orders where organization_id = :'org_a') sales_orders,
  (select count(*) from public.opening_wip where organization_id = :'org_a') wip,
  (select coalesce(sum(value), 0) from public.opening_wip where organization_id = :'org_a') wip_value,
  (select count(*) from public.jobs where organization_id = :'org_b') b_jobs,
  (select string_agg(prefix || '=' || last, ',' order by prefix) from public.doc_counters where organization_id = :'org_b') b_counters;
grant select on rehearsal_jchk.truth to authenticated;
select id as a_wip from public.opening_wip where organization_id = :'org_a' order by source_key limit 1 \gset
select id as a_job from public.jobs where organization_id = :'org_a' order by job_no limit 1 \gset
select rehearsal_jchk.ok('setup: the import wrote jobs, job values, orders and WIP for A', jobs > 0 and job_values > 0 and sales_orders > 0 and wip > 0,
  jobs || ' jobs, ' || job_values || ' values, ' || sales_orders || ' orders, ' || wip || ' WIP rows') from rehearsal_jchk.truth;

-- ---- 1. A's office and admin see everything imported; A's workshop sees the jobs but no prices and no WIP ----------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'office_a', true) is not null as c \gset
select rehearsal_jchk.ok('rls: A office sees every imported job, value, order and WIP row', (j, v, s, w, wv) = (t.jobs, t.job_values, t.sales_orders, t.wip, t.wip_value), j || '/' || v || '/' || s || '/' || w || ' ' || wv)
  from (select (select count(*) from public.jobs where organization_id = :'org_a') j, (select count(*) from public.job_values where organization_id = :'org_a') v,
               (select count(*) from public.sales_orders where organization_id = :'org_a') s, (select count(*) from public.opening_wip where organization_id = :'org_a') w,
               (select coalesce(sum(value), 0) from public.opening_wip where organization_id = :'org_a') wv) x, rehearsal_jchk.truth t;
select rehearsal_jchk.no_write('rls: A office cannot add opening WIP', format('insert into public.opening_wip (organization_id, source_key, value) values (%L, %L, 1)', :'org_a', 'office-try'));
select rehearsal_jchk.no_write('rls: A office cannot change an opening WIP value', format('update public.opening_wip set value = value + 1 where id = %L', :'a_wip'));
select rehearsal_jchk.no_write('rls: A office cannot delete opening WIP', format('delete from public.opening_wip where id = %L', :'a_wip'));
-- Numbering continues after SliQ's: the next job and sales order numbers, as the app takes them.
select public.next_doc_number('J') as next_j \gset
select public.next_doc_number('SO') as next_so \gset
select rehearsal_jchk.ok('numbering: the next new job after the import is J-1541 (after SliQ''s highest, J-1540, closed)', :'next_j' = 'J-1541', :'next_j');
select rehearsal_jchk.ok('numbering: the next new sales order is SO-0225 (after SliQ''s highest, SO-0224)', :'next_so' = 'SO-0225', :'next_so');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', :'admin_a', true) is not null as c \gset
select rehearsal_jchk.ok('rls: A admin sees every opening WIP row', (select count(*) from public.opening_wip) = t.wip, (select count(*) from public.opening_wip) || ' of ' || t.wip) from rehearsal_jchk.truth t;
select rehearsal_jchk.no_write('rls: A admin cannot change an opening WIP value', format('update public.opening_wip set value = 0 where id = %L', :'a_wip'));
reset role;

set local role authenticated;
select set_config('request.jwt.claims', :'workshop_a', true) is not null as c \gset
select rehearsal_jchk.ok('rls: A workshop sees the imported jobs (Job Board)', (select count(*) from public.jobs where organization_id = :'org_a') = t.jobs, (select count(*) from public.jobs where organization_id = :'org_a') || ' of ' || t.jobs) from rehearsal_jchk.truth t;
select rehearsal_jchk.ok('rls: A workshop sees no job prices (job_values)', (select count(*) from public.job_values) = 0, (select count(*) from public.job_values) || ' visible');
select rehearsal_jchk.ok('rls: A workshop sees no opening WIP', (select count(*) from public.opening_wip) = 0, (select count(*) from public.opening_wip) || ' visible');
select rehearsal_jchk.no_write('rls: A workshop cannot add opening WIP', format('insert into public.opening_wip (organization_id, source_key) values (%L, %L)', :'org_a', 'workshop-try'));
reset role;

-- ---- 2. Tenant B sees none of A's jobs, values, orders or WIP, and cannot write them ---------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', :'admin_b', true) is not null as c \gset
select rehearsal_jchk.ok('rls: tenant B admin sees none of A''s ' || t, n = 0, n || ' visible') from (values
  ('jobs',         (select count(*) from public.jobs         where organization_id = :'org_a')),
  ('job_values',   (select count(*) from public.job_values   where organization_id = :'org_a')),
  ('sales_orders', (select count(*) from public.sales_orders where organization_id = :'org_a')),
  ('opening_wip',  (select count(*) from public.opening_wip  where organization_id = :'org_a'))) v(t, n);
select rehearsal_jchk.no_write('rls: tenant B cannot change A''s imported job', format('update public.jobs set description = %L where id = %L', 'x', :'a_job'));
select rehearsal_jchk.no_write('rls: tenant B cannot add WIP to A', format('insert into public.opening_wip (organization_id, source_key) values (%L, %L)', :'org_a', 'b-try'));
reset role;
select rehearsal_jchk.ok('isolation: tenant B''s jobs and counters are unchanged by A''s import', (select count(*) from public.jobs where organization_id = :'org_b') = t.b_jobs
  and coalesce((select string_agg(prefix || '=' || last, ',' order by prefix) from public.doc_counters where organization_id = :'org_b'), '') = coalesce(t.b_counters, ''),
  coalesce(t.b_counters, 'no counters')) from rehearsal_jchk.truth t;
select rehearsal_jchk.ok('isolation: the WIP rows are unchanged after the refused writes', (select count(*) from public.opening_wip where organization_id = :'org_a') = t.wip
  and (select coalesce(sum(value), 0) from public.opening_wip where organization_id = :'org_a') = t.wip_value, t.wip || ' rows ' || t.wip_value) from rehearsal_jchk.truth t;

select line from rehearsal_jchk.out order by n;
rollback;

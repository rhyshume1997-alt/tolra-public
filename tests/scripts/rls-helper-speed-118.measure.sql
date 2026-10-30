-- S11 / 118: what the row-level-security helpers cost per row. READ-ONLY on the schema: everything runs in one transaction that is
-- rolled back. Plain PostgreSQL copy with the migration chain and the Supabase stand-ins, NEVER a hosted project:
--
--   create database s11 template sec_base;
--   PGPASSWORD=localonly psql -h 127.0.0.1 -U postgres -X -d s11 -f tests/scripts/rls-helper-speed-118.measure.sql
--
-- Seeds two companies (5,000 invoices, 6,000 quotes, 4,000 RFQs, 4,500 jobs, 1,300 payments each), then, as company m's admin
-- (role authenticated + request.jwt.claims, one membership, aal1, a session id with no saved choice), runs EXPLAIN (ANALYZE,
-- BUFFERS) on: Q1-Q3 count(*) of invoices / quotes / jobs, Q4 the invoices page's first 50, Q5 its first fetchAll page (1,000),
-- Q6-Q7 111's dashboard functions (skipped when 111 is not applied). Q8 prints the counts and an md5 of each dashboard result,
-- which must be the same before and after 118. Compare "Execution Time" and "Buffers: shared hit" with and without 118
-- (supabase/release/118_rls_helper_speed.rollback.sql on the copy puts 036's function back).
\set ON_ERROR_STOP 1
\pset pager off
begin;
create temp table s11_ids (k text primary key, id uuid) on commit drop;
grant select on s11_ids to authenticated;
do $$ declare v_org uuid; v_u uuid; v_k text; begin
  foreach v_k in array array['m','o'] loop
    v_u := gen_random_uuid();
    insert into public.organizations (name, slug) values ('S11 ' || v_k, 't-s11-' || v_k || '-' || left(v_u::text, 8)) returning id into v_org;
    insert into auth.users (id, email) values (v_u, 's11.' || v_k || '.' || left(v_u::text, 8) || '@example.test');
    insert into public.user_profiles (id, email, full_name, role, organization_id) values (v_u, 's11.' || v_k || '.' || left(v_u::text, 8) || '@example.test', 'M', 'admin', v_org);
    insert into public.organization_members (user_id, organization_id, role) values (v_u, v_org, 'admin');
    insert into s11_ids values ('org_' || v_k, v_org), ('u_' || v_k, v_u);
  end loop;
end $$;
set local session_replication_role = replica;
insert into public.invoices (organization_id, customer, invoice_ref, status, total, amount_paid, due_date, invoice_date, paid_at, created_at)
select o.id, 'Cust ' || (g % 80), 'INV-' || g,
       case when g <= 4600 then 'paid' else 'issued' end, 100 + g % 900, 0, date '2026-10-30' - (g % 400), date '2026-10-30' - (g % 1500),
       case when g <= 4600 then timestamptz '2026-10-30' - ((g % 1500) || ' days')::interval + interval '20 days' end, timestamptz '2026-10-30' - ((g % 1500) || ' days')::interval
from generate_series(1, 5000) g, s11_ids o where o.k like 'org_%';
insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on)
select o.id, (select id from public.invoices i where i.invoice_ref = 'INV-1' and i.organization_id = o.id), 50, date '2026-10-30' - (g % 180)
from generate_series(1, 1300) g, s11_ids o where o.k like 'org_%';
insert into public.quotes (organization_id, customer, quote_ref, status, valid_until, total_value, sent_at)
select o.id, 'Cust ' || (g % 80), 'QUO-' || g, (array['draft','sent','accepted','rejected'])[1 + g % 4], date '2026-10-30' + (g % 60) - 30, 500, timestamptz '2026-10-30' - ((g % 1500) || ' days')::interval
from generate_series(1, 6000) g, s11_ids o where o.k like 'org_%';
insert into public.rfqs (organization_id, customer, status) select o.id, 'Cust', 'new' from generate_series(1, 4000), s11_ids o where o.k like 'org_%';
insert into public.jobs (organization_id, job_no, customer, started_at, finished_at, inspected_at, date_required)
select o.id, 'J-' || g, 'Cust', timestamptz '2026-10-01', case when g > 150 then timestamptz '2026-10-30' - ((g % 600) || ' days')::interval end,
       case when g > 150 then timestamptz '2026-10-30' - ((g % 600) || ' days')::interval end, date '2026-10-30' - (g % 600) + 3
from generate_series(1, 4500) g, s11_ids o where o.k like 'org_%';
set local session_replication_role = origin;
analyze public.invoices; analyze public.quotes; analyze public.jobs; analyze public.rfqs; analyze public.invoice_payments;
select set_config('request.jwt.claims', json_build_object('sub', (select id from s11_ids where k='u_m'), 'role', 'authenticated', 'aal', 'aal1', 'session_id', '00000000-0000-4000-8000-000000000011')::text, true);
set local role authenticated;
select '118 applied: ' || (select l.lanname = 'plpgsql' from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public._session_membership()'::regprocedure)::text as state;
select count(*) from public.invoices; select count(*) from public.quotes; select count(*) from public.jobs;
\echo Q1 count invoices
explain (analyze, buffers, costs off) select count(*) from public.invoices;
\echo Q2 count quotes
explain (analyze, buffers, costs off) select count(*) from public.quotes;
\echo Q3 count jobs
explain (analyze, buffers, costs off) select count(*) from public.jobs;
\echo Q4 invoices page first 50
explain (analyze, buffers, costs off) select * from public.invoices order by created_at desc, id limit 50 offset 0;
\echo Q5 invoices page first fetchAll page 0..999
explain (analyze, buffers, costs off) select * from public.invoices order by created_at desc, id limit 1000 offset 0;
select to_regprocedure('public.dashboard_money_figures(date,date)') is not null as has_111 \gset
\if :has_111
\echo Q6 dashboard_money_figures
explain (analyze, buffers, costs off) select public.dashboard_money_figures('2026-10-30','2026-05-01');
\echo Q7 dashboard_work_figures
explain (analyze, buffers, costs off) select public.dashboard_work_figures('2026-10-30','2026-11-06','2026-05-01','2026-10-01','2026-08-01','2026-10-26','2026-11-02','2026-10-30 12:00');
\echo Q8 result check
select (select count(*) from public.invoices) inv, (select count(*) from public.quotes) quo, (select count(*) from public.jobs) job,
       md5(public.dashboard_money_figures('2026-10-30','2026-05-01')::text) money_md5,
       md5(public.dashboard_work_figures('2026-10-30','2026-11-06','2026-05-01','2026-10-01','2026-08-01','2026-10-26','2026-11-02','2026-10-30 12:00')::text) work_md5;
\else
\echo Q8 result check (111 not applied: counts only)
select (select count(*) from public.invoices) inv, (select count(*) from public.quotes) quo, (select count(*) from public.jobs) job;
\endif
rollback;

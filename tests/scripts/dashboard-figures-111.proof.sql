-- Proof of migration 111 (E6): the dashboard figures worked out in the database equal a count made by hand, and a company's call
-- never includes another company's rows.
--
-- Two companies, ALPHA and BETA, each with a handful of quotes, RFQs, jobs, inspections, machines, bookings, e-mails, invoices and
-- payments. Every alpha row below is annotated with what it must count towards; the expected figures are written out by hand at the
-- end and compared with what public.dashboard_work_figures / dashboard_money_figures return when called exactly as PostgREST runs a
-- signed-in request (role authenticated + request.jwt.claims). Beta's rows would change every one of alpha's figures if they leaked
-- (and one of beta's quotes points at alpha's RFQ, which must stay outstanding for alpha). Beta's own call sees only beta's rows.
-- anon may not call either function.
--
-- Seeding is not under test: rows are written as the owner with triggers off (session_replication_role = replica). Everything is
-- rolled back at the end: the script leaves no trace.
--
-- Run:  psql -X -v ON_ERROR_STOP=1 -d <disposable database with 000..111> -f tests/scripts/dashboard-figures-111.proof.sql
-- CI:   tests/db/dashboard-figures-111.test.ts runs this file against the local stack. It raises (psql exits non-zero) on any mismatch.
-- The expected alpha figures are also the input of tests/unit/dashboard-figures.test.ts (the same JSON), which proves the page's
-- figures built from them equal the ones the old browser-side reads worked out from the same rows.

begin;

create temp table e6_ids (k text primary key, id uuid not null) on commit drop;
grant select on e6_ids to authenticated;

do $$
declare
  v_a uuid; v_b uuid; v_u uuid; v_k text;
begin
  insert into public.organizations (name, slug) values ('E6 proof alpha', 't-e6proof-alpha') returning id into v_a;
  insert into public.organizations (name, slug) values ('E6 proof beta', 't-e6proof-beta') returning id into v_b;
  insert into e6_ids values ('org_a', v_a), ('org_b', v_b);
  foreach v_k in array array['a_admin', 'a_office', 'b_admin'] loop
    v_u := gen_random_uuid();
    insert into auth.users (id, email) values (v_u, v_k || '.e6proof@example.test');
    insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
      values (v_u, v_k || '.e6proof@example.test', 'E6 ' || v_k, split_part(v_k, '_', 2), case when v_k like 'a_%' then v_a else v_b end, true, false);
    insert into public.organization_members (user_id, organization_id, role, active)
      values (v_u, case when v_k like 'a_%' then v_a else v_b end, split_part(v_k, '_', 2), true);
    insert into e6_ids values (v_k, v_u);
  end loop;
end $$;

set local session_replication_role = replica;

-- ---- alpha ------------------------------------------------------------------------------------------------------------
-- Dates used throughout: today 2026-10-30, due-within-7-days to 2026-11-06, six months from 2026-05-01, this month from
-- 2026-10-01, 90 days from 2026-08-01, machine week 2026-10-26 00:00 to 2026-11-02 00:00 (UTC), now 2026-10-30 12:00 UTC.
do $$
declare
  a uuid := (select id from e6_ids where k = 'org_a');
  q3 uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); r3 uuid := gen_random_uuid();
  j3 uuid := gen_random_uuid(); j4 uuid := gen_random_uuid(); j5 uuid := gen_random_uuid();
  m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid(); v1 uuid := gen_random_uuid();
begin
  insert into e6_ids values ('r3', r3);
  -- RFQs: R1 quoted by Q3, R2 by Q6 (rejected), R4 marked quoted: not outstanding. R3, R5 (blank status = new), R6: outstanding (3).
  insert into public.rfqs (id, organization_id, customer, status) values
    (r1, a, 'Acme', 'new'), (r2, a, 'Acme', 'new'), (r3, a, 'Acme', 'new'),
    (gen_random_uuid(), a, 'Acme', 'quoted'), (gen_random_uuid(), a, 'Acme', ''), (gen_random_uuid(), a, 'Acme', 'clarification');
  -- Quotes. Open (sent, in date): Q1 100, Q4 250, Q7 10 -> 3, 36000p. Accepted: Q3 -> 1.
  -- Sent in 90 days: Q1 sent, Q2 expired (was sent), Q3 accepted, Q4 sent, Q8 expired (a draft with a sent date: not counted as sent)
  -- -> accepted 1, sent 2, expired 2, rejected 0, expired-sent 1 (win rate 1 of 2).
  -- Sent this month: Q1 (QUO-1), Q3 (QUO-3), Q4 (QUO-3 v2, the same quote) -> 2.
  insert into public.quotes (id, organization_id, customer, quote_ref, version, previous_version_id, status, valid_until, total_value, sent_at, rfq_id) values
    (gen_random_uuid(), a, 'Acme', 'QUO-1', 1, null, 'sent', '2026-11-30', 100.00, '2026-10-05 09:00+00', null),
    (gen_random_uuid(), a, 'Acme', 'QUO-2', 1, null, 'sent', '2026-10-01', 50.00, '2026-09-01 09:00+00', null),
    (q3, a, 'Acme', 'QUO-3', 1, null, 'accepted', '2026-10-01', 200.00, '2026-10-10 09:00+00', r1),
    (gen_random_uuid(), a, 'Acme', 'QUO-3 v2', 2, q3, 'sent', null, 250.00, '2026-10-12 09:00+00', null),
    (gen_random_uuid(), a, 'Acme', 'QUO-5', 1, null, 'draft', '2026-10-01', 70.00, null, null),
    (gen_random_uuid(), a, 'Acme', 'QUO-6', 1, null, 'rejected', null, 30.00, '2026-07-15 09:00+00', r2),
    (gen_random_uuid(), a, 'Acme', 'QUO-7', 1, null, 'SENT', null, 10.00, null, null),
    (gen_random_uuid(), a, 'Acme', 'QUO-8', 1, null, 'draft', '2026-10-01', 15.00, '2026-09-10 09:00+00', null);
  -- Jobs. Open: J1 J2 J3 J4 J7 J8 J9 (7). Due by 2026-11-06: J2 (required 11-02), J8 (due_date 11-06) (2). Late: J1, J9 (2).
  -- Dated unfinished: J1 J2 J8 J9 (4). Not started J1 J7 J8 J9 (4); running J2, J4 rework (2); waiting J3 (1). Overdue J1 J9 (2);
  -- due soon J2 J8 (2). Coming due: 11-02 J2, 11-06 J8, 11-10 J4. Finished by month: 2026-10 J3 late + J4 on time; 2026-09 J5 on time;
  -- J6 (April) outside the six months.
  insert into public.jobs (id, organization_id, job_no, customer, stage, started_at, finished_at, inspected_at, date_required, due_date) values
    (gen_random_uuid(), a, 'J1', 'Acme', 'material', null, null, null, '2026-10-29', '2026-10-29'),
    (gen_random_uuid(), a, 'J2', 'Acme', 'machining', '2026-10-20 08:00+00', null, null, '2026-11-02', '2026-11-02'),
    (j3, a, 'J3', 'Acme', 'inspection', '2026-10-20 08:00+00', '2026-10-28 10:00+00', null, '2026-10-27', '2026-10-27'),
    (j4, a, 'J4', 'Acme', 'rework', '2026-10-01 08:00+00', '2026-10-14 10:00+00', '2026-10-15 10:00+00', null, '2026-11-10'),
    (j5, a, 'J5', 'Acme', 'complete', '2026-09-01 08:00+00', '2026-09-18 10:00+00', '2026-09-20 10:00+00', '2026-09-19', '2026-09-19'),
    (gen_random_uuid(), a, 'J6', 'Acme', 'complete', '2026-04-01 08:00+00', '2026-04-10 10:00+00', '2026-04-11 10:00+00', '2026-04-12', '2026-04-12'),
    (gen_random_uuid(), a, 'J7', 'Acme', 'material', null, null, null, null, null),
    (gen_random_uuid(), a, 'J8', 'Acme', 'material', null, null, null, null, '2026-11-06'),
    (gen_random_uuid(), a, 'J9', 'Acme', 'setup', null, null, null, null, '2026-10-01');
  -- Inspections since 2026-05-01, first per job: J3 fail (then pass), J5 pass, J4 fail (its April pass is outside) -> 3 jobs, 1 passed.
  insert into public.job_inspections (organization_id, job_id, worksheet_version, result, release_decision, measured_notes, inspector_name, inspected_at) values
    (a, j3, 1, 'fail', 'held', 'n', 'Insp', '2026-10-01 10:00+00'), (a, j3, 1, 'pass', 'released', 'n', 'Insp', '2026-10-05 10:00+00'),
    (a, j5, 1, 'pass', 'released', 'n', 'Insp', '2026-09-20 10:00+00'),
    (a, j4, 1, 'pass', 'released', 'n', 'Insp', '2026-04-01 10:00+00'), (a, j4, 1, 'fail', 'held', 'n', 'Insp', '2026-10-15 10:00+00');
  -- Machines: Lathe booked 4.5 + 3 = 7.5 h this week (the 11-02 and 10-25 bookings are outside it); Mill 0 h.
  insert into public.machines (id, organization_id, name, hours_per_day, working_days) values
    (m1, a, 'Lathe', 8, '{1,2,3,4,5}'), (m2, a, 'Mill', 7.5, '{1,2,3,4}');
  insert into public.machine_bookings (organization_id, machine_id, start_at, estimated_hours) values
    (a, m1, '2026-10-27 09:00+00', 4.5), (a, m1, '2026-10-31 09:00+00', 3), (a, m1, '2026-11-02 00:00+00', 5), (a, m1, '2026-10-25 09:00+00', 2);
  -- E-mails awaiting approval: E1 (not skipped), E3 (skipped until yesterday) -> 2. E2 skipped until tomorrow, E4 sent.
  insert into public.email_history (organization_id, status, skipped_until, subject, body, to_email, related_to_type) values
    (a, 'drafted', null, 's', 'b', 'x@example.test', 'general'), (a, 'drafted', '2026-10-31 09:00+00', 's', 'b', 'x@example.test', 'general'),
    (a, 'drafted', '2026-10-29 09:00+00', 's', 'b', 'x@example.test', 'general'), (a, 'sent_via_system', null, 's', 'b', 'x@example.test', 'general');
  -- Invoices not paid. Owed (collectible, confirmed): V1 100.00 not due; V2 300-100-50+10 = 160.00, 10 days late; V3 80.00, 45 days late;
  -- V4 ('overdue' is collectible) 40.00, 121 days late; V8 overpaid, owed 0 (counted, no amount); V9 25.00, no due date (not due).
  -- -> 6 invoices, 40500p: not due 12500, 1-30 16000, 31-60 8000, 60+ 4000. V5 payment to confirm (1). V6 draft, V7 void: closed.
  insert into public.invoices (id, organization_id, customer, invoice_ref, status, total, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified) values
    (v1, a, 'Acme', 'INV-1', 'issued', 120.00, 20.00, 0, 0, '2026-11-15', false),
    (gen_random_uuid(), a, 'Acme', 'INV-2', 'partial', 300.00, 100.00, 50.00, 10.00, '2026-10-20', false),
    (gen_random_uuid(), a, 'Acme', 'INV-3', 'issued', 80.00, 0, 0, 0, '2026-09-15', false),
    (gen_random_uuid(), a, 'Acme', 'INV-4', 'overdue', 40.00, 0, 0, 0, '2026-07-01', false),
    (gen_random_uuid(), a, 'Acme', 'INV-5', 'issued', 999.00, 0, 0, 0, '2026-10-01', true),
    (gen_random_uuid(), a, 'Acme', null, 'draft', 500.00, 0, 0, 0, '2026-10-01', false),
    (gen_random_uuid(), a, 'Acme', 'INV-7', 'void', 70.00, 0, 0, 0, '2026-10-01', false),
    (gen_random_uuid(), a, 'Acme', 'INV-8', 'issued', 50.00, 60.00, 0, 0, '2026-10-01', false),
    (gen_random_uuid(), a, 'Acme', 'INV-9', 'issued', 25.00, 0, 0, 0, null, false);
  -- Paid invoices (6 in all). In the six months: P1 (10.5 days to pay), P2 (4), P4, P5 (10), P6; P3 is older. Days to pay: 24.5 over 3.
  -- Top customers paid since 2026-05-01: Zed Ltd 90000, Acme 75000 ('Acme ' and 'Acme'), No customer 5000.
  insert into public.invoices (organization_id, customer, invoice_ref, status, total, invoice_date, paid_at, created_at) values
    (a, 'Acme ', 'INV-P1', 'paid', 500.00, '2026-09-01', '2026-09-11 12:00+00', '2026-09-01 08:00+00'),
    (a, 'Acme', 'INV-P2', 'paid', 250.00, '2026-10-01', '2026-10-05 00:00+00', '2026-10-01 08:00+00'),
    (a, '', 'INV-P3', 'paid', 100.00, '2026-03-01', '2026-03-20 00:00+00', '2026-03-01 08:00+00'),
    (a, 'Zed Ltd', 'INV-P4', 'paid', 900.00, null, '2026-06-01 10:00+00', '2026-03-01 08:00+00'),
    (a, '  ', 'INV-P5', 'paid', 50.00, '2026-05-10', '2026-05-20 00:00+00', '2026-05-10 08:00+00'),
    (a, 'Old Co', 'INV-P6', 'paid', 70.00, '2026-06-01', null, '2026-06-01 08:00+00');
  -- Payments received: 2026-10 100.00 + 20.25 = 12025p; 2026-09 50.50 = 5050p; April's is outside.
  insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on) values
    (a, v1, 100.00, '2026-10-02'), (a, v1, 50.50, '2026-09-15'), (a, v1, 999.00, '2026-04-30'), (a, v1, 20.25, '2026-10-20');
end $$;

-- ---- beta: one of everything, each of which would change an alpha figure if it leaked ---------------------------------------
do $$
declare
  b uuid := (select id from e6_ids where k = 'org_b');
  m uuid := gen_random_uuid(); j uuid := gen_random_uuid(); v uuid := gen_random_uuid();
begin
  insert into public.rfqs (organization_id, customer, status) values (b, 'Beta Buyer', 'new');
  -- A beta quote pointing at alpha's outstanding RFQ R3: alpha must still see R3 outstanding (it can't see this quote).
  insert into public.quotes (organization_id, customer, quote_ref, status, valid_until, total_value, sent_at, rfq_id) values
    (b, 'Beta Buyer', 'QUO-B1', 'sent', '2026-12-31', 7777.00, '2026-10-15 09:00+00', (select id from e6_ids where k = 'r3')),
    (b, 'Beta Buyer', 'QUO-B2', 'accepted', null, 10.00, '2026-10-16 09:00+00', null);
  insert into public.jobs (id, organization_id, job_no, customer, stage, started_at, finished_at, inspected_at, date_required, due_date) values
    (j, b, 'JB1', 'Beta Buyer', 'machining', '2026-10-01 08:00+00', '2026-10-10 10:00+00', null, '2026-10-02', '2026-10-02'),
    (gen_random_uuid(), b, 'JB2', 'Beta Buyer', 'material', null, null, null, '2026-11-01', '2026-11-01');
  insert into public.job_inspections (organization_id, job_id, worksheet_version, result, release_decision, measured_notes, inspector_name, inspected_at) values
    (b, j, 1, 'pass', 'released', 'n', 'Insp', '2026-10-11 10:00+00');
  insert into public.machines (id, organization_id, name, hours_per_day, working_days) values (m, b, 'Beta Mill', 8, '{1,2,3,4,5}');
  insert into public.machine_bookings (organization_id, machine_id, start_at, estimated_hours) values (b, m, '2026-10-28 09:00+00', 6);
  insert into public.email_history (organization_id, status, subject, body, to_email, related_to_type) values (b, 'drafted', 's', 'b', 'x@example.test', 'general');
  insert into public.invoices (id, organization_id, customer, invoice_ref, status, total, due_date, payment_unverified) values
    (v, b, 'Beta Buyer', 'INV-B1', 'issued', 12.34, '2026-10-01', false), (gen_random_uuid(), b, 'Beta Buyer', 'INV-B2', 'issued', 5, null, true);
  insert into public.invoices (organization_id, customer, invoice_ref, status, total, invoice_date, paid_at) values
    (b, 'Acme', 'INV-BP1', 'paid', 4321.00, '2026-10-01', '2026-10-03 00:00+00');
  insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on) values (b, v, 3.21, '2026-10-05');
end $$;

set local session_replication_role = origin;

-- ---- the calls, as signed-in users ---------------------------------------------------------------------------------------
create function pg_temp.e6_as(p_who text) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from e6_ids where k = p_who), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $f$;
create function pg_temp.e6_work() returns jsonb language sql as $f$
  select public.dashboard_work_figures('2026-10-30', '2026-11-06', '2026-05-01', '2026-10-01', '2026-08-01',
                                       '2026-10-26 00:00+00', '2026-11-02 00:00+00', '2026-10-30 12:00+00')
$f$;
create function pg_temp.e6_money() returns jsonb language sql as $f$
  select public.dashboard_money_figures('2026-10-30', '2026-05-01')
$f$;
create function pg_temp.e6_check(p_what text, p_got jsonb, p_want jsonb) returns void language plpgsql as $f$
declare k text;
begin
  for k in select key from jsonb_each(p_want) union select key from jsonb_each(p_got) loop
    if (p_got -> k) is distinct from (p_want -> k) then
      raise exception 'E6 proof FAILED: % %: got %, expected %', p_what, k, coalesce((p_got -> k)::text, 'nothing'), coalesce((p_want -> k)::text, 'nothing');
    end if;
  end loop;
  raise notice 'E6 proof ok: %', p_what;
end $f$;
grant execute on all functions in schema pg_temp to authenticated;

do $$
declare
  v_work jsonb := '{
    "quotes": {"open_count": 3, "open_pence": 36000, "accepted_count": 1},
    "quotes_90": {"accepted": 1, "sent": 2, "expired": 2, "rejected": 0, "expired_sent": 1},
    "quotes_sent_this_month": 2,
    "rfqs_outstanding": 3,
    "jobs": {"open": 7, "due_week": 2, "late": 2, "dated": 4, "not_started": 4, "running": 2, "waiting": 1, "overdue": 2, "due_soon": 2},
    "due_days": {"2026-11-02": 1, "2026-11-06": 1, "2026-11-10": 1},
    "finished_by_month": {"2026-09": {"dated": 1, "on_time": 1}, "2026-10": {"dated": 2, "on_time": 1}},
    "right_first_time": {"jobs": 3, "passed": 1},
    "machines": "MACHINES",
    "drafts": 2
  }';
  v_money jsonb := '{
    "to_confirm": 1, "unpaid_count": 6, "owed_pence": 40500,
    "owed_by_age": {"not_due": 12500, "late_1_30": 16000, "late_31_60": 8000, "late_60_plus": 4000},
    "paid_count": 6,
    "days_to_pay": {"sum": 24.5, "count": 3},
    "top_customers": [{"customer": "Zed Ltd", "pence": 90000}, {"customer": "Acme", "pence": 75000}, {"customer": "No customer", "pence": 5000}],
    "received_by_month": {"2026-09": 5050, "2026-10": 12025}
  }';
  v_got jsonb;
begin
  -- alpha's admin: every figure as counted by hand. Machines carry their ids, so they are compared without them.
  perform pg_temp.e6_as('a_admin');
  v_got := pg_temp.e6_work();
  perform pg_temp.e6_check('alpha admin work figures', jsonb_set(v_got, '{machines}', '"MACHINES"'), v_work);
  if (select jsonb_agg(m - 'id') from jsonb_array_elements(v_got -> 'machines') m) is distinct from
     '[{"name": "Lathe", "hours_per_day": 8, "working_days": [1,2,3,4,5], "booked": 7.5}, {"name": "Mill", "hours_per_day": 7.5, "working_days": [1,2,3,4], "booked": 0}]'::jsonb then
    raise exception 'E6 proof FAILED: alpha machines: %', v_got -> 'machines';
  end if;
  perform pg_temp.e6_check('alpha admin money figures', pg_temp.e6_money(), v_money);
  -- alpha's office: the same work figures (the office dashboard reads them too).
  perform pg_temp.e6_as('a_office');
  perform pg_temp.e6_check('alpha office work figures', jsonb_set(pg_temp.e6_work(), '{machines}', '"MACHINES"'), v_work);

  -- beta's admin: only beta's rows.
  perform pg_temp.e6_as('b_admin');
  v_got := pg_temp.e6_work();
  perform pg_temp.e6_check('beta admin work figures', jsonb_set(v_got, '{machines}', '"MACHINES"'), '{
    "quotes": {"open_count": 1, "open_pence": 777700, "accepted_count": 1},
    "quotes_90": {"accepted": 1, "sent": 1, "expired": 0, "rejected": 0, "expired_sent": 0},
    "quotes_sent_this_month": 2, "rfqs_outstanding": 1,
    "jobs": {"open": 2, "due_week": 1, "late": 0, "dated": 1, "not_started": 1, "running": 0, "waiting": 1, "overdue": 0, "due_soon": 1},
    "due_days": {"2026-11-01": 1}, "finished_by_month": {"2026-10": {"dated": 1, "on_time": 0}},
    "right_first_time": {"jobs": 1, "passed": 1}, "machines": "MACHINES", "drafts": 1}');
  if (select jsonb_agg(m ->> 'name') from jsonb_array_elements(v_got -> 'machines') m) is distinct from '["Beta Mill"]'::jsonb then
    raise exception 'E6 proof FAILED: beta machines: %', v_got -> 'machines';
  end if;
  perform pg_temp.e6_check('beta admin money figures', pg_temp.e6_money(), '{
    "to_confirm": 1, "unpaid_count": 1, "owed_pence": 1234,
    "owed_by_age": {"not_due": 0, "late_1_30": 1234, "late_31_60": 0, "late_60_plus": 0}, "paid_count": 1,
    "days_to_pay": {"sum": 2, "count": 1}, "top_customers": [{"customer": "Acme", "pence": 432100}], "received_by_month": {"2026-10": 321}}');
end $$;

-- Signed out (anon): refused.
do $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
  begin
    perform public.dashboard_work_figures('2026-10-30', '2026-11-06', '2026-05-01', '2026-10-01', '2026-08-01', now(), now(), now());
    raise exception 'E6 proof FAILED: anon may call dashboard_work_figures';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.dashboard_money_figures('2026-10-30', '2026-05-01');
    raise exception 'E6 proof FAILED: anon may call dashboard_money_figures';
  exception when insufficient_privilege then null;
  end;
  raise notice 'E6 proof ok: anon refused';
end $$;

reset role;
select 'E6 proof: all checks passed' as result;
rollback;

-- Local proof for migration 126 (a booking with recorded machine time is not removed; a quote for 0.00 is not accepted). Run on a COPY
-- of a database with the chain applied plus 126 (it leaves a proof schema and synthetic rows behind):
--   createdb p126 -T base_122; psql -d p126 -f supabase/release/126_booking_time_zero_quote_guards.release.sql; psql -d p126 -f this
-- Every attempt is recorded (expected and got: SQLSTATE/hint); each part ends with pass/fail counts and the state checks (all t).
-- On a database at 122 the same script shows the defects: the deletes and the 0.00 accepts go through and runs lose their booking.
\set ON_ERROR_STOP 1
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS proof CASCADE; CREATE SCHEMA proof;
CREATE TABLE proof.ids (k TEXT PRIMARY KEY, v UUID);
CREATE TABLE proof.res (n SERIAL, path TEXT, expect TEXT, got TEXT, msg TEXT, ok BOOLEAN);
GRANT USAGE ON SCHEMA proof TO authenticated, service_role; GRANT ALL ON ALL TABLES IN SCHEMA proof TO authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA proof TO authenticated, service_role;
DO $$
DECLARE o UUID := gen_random_uuid(); m1 UUID; m2 UUID; m3 UUID; j1 UUID; j2 UUID; j3 UUID; r TEXT; u UUID;
        b_end UUID; b_act UUID; b_cmp UUID; bf UUID; bj2 UUID; bj3 UUID;
BEGIN
  INSERT INTO public.organizations (id, name, slug) VALUES (o, 'Proof Co', 'proof-' || left(o::text, 8));
  FOREACH r IN ARRAY ARRAY['admin', 'office', 'workshop', 'viewer'] LOOP
    u := gen_random_uuid();
    INSERT INTO auth.users (id, email) VALUES (u, r || '-' || left(u::text, 8) || '@example.test');
    INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES (u, r || '-' || left(u::text, 8) || '@example.test', r, o)
      ON CONFLICT (id) DO UPDATE SET organization_id = o, role = r;
    INSERT INTO public.organization_members (user_id, organization_id, role) VALUES (u, o, r) ON CONFLICT DO NOTHING;
    INSERT INTO proof.ids VALUES ('u_' || r, u);
  END LOOP;
  INSERT INTO public.machines (organization_id, name) VALUES (o, 'M1') RETURNING id INTO m1;
  INSERT INTO public.machines (organization_id, name) VALUES (o, 'M2') RETURNING id INTO m2;
  INSERT INTO public.machines (organization_id, name) VALUES (o, 'M3') RETURNING id INTO m3;
  INSERT INTO public.jobs (organization_id, job_no, customer) VALUES (o, 'PJ-1', 'Synthetic') RETURNING id INTO j1;
  INSERT INTO public.jobs (organization_id, job_no, customer) VALUES (o, 'PJ-2', 'Synthetic') RETURNING id INTO j2;
  INSERT INTO public.jobs (organization_id, job_no, customer) VALUES (o, 'PJ-3', 'Synthetic') RETURNING id INTO j3;
  -- b_end: booked, one ENDED run. b_act: running, one ACTIVE run. b_cmp: complete, a finished run. bf: booked, no runs (control).
  INSERT INTO public.machine_bookings (organization_id, machine_id, job_id, job_no, start_at, estimated_hours, status)
    VALUES (o, m1, j1, 'PJ-1', date_trunc('day', now()) + interval '30 days 09:00', 2, 'booked') RETURNING id INTO b_end;
  INSERT INTO public.machine_bookings (organization_id, machine_id, job_id, job_no, start_at, estimated_hours, status)
    VALUES (o, m2, j1, 'PJ-1', date_trunc('day', now()) + interval '40 days 09:00', 2, 'running') RETURNING id INTO b_act;
  INSERT INTO public.machine_bookings (organization_id, machine_id, job_id, job_no, start_at, estimated_hours, status)
    VALUES (o, m1, j1, 'PJ-1', date_trunc('day', now()) + interval '45 days 09:00', 2, 'complete') RETURNING id INTO b_cmp;
  INSERT INTO public.machine_bookings (organization_id, machine_id, job_id, job_no, start_at, estimated_hours, status)
    VALUES (o, m1, j1, 'PJ-1', date_trunc('day', now()) + interval '50 days 09:00', 2, 'booked') RETURNING id INTO bf;
  -- set_job_machines: PJ-2 plans M3 with a booked booking that has an ended run; PJ-3 plans M3 with a booked booking, no runs.
  INSERT INTO public.machine_bookings (organization_id, machine_id, job_id, job_no, start_at, estimated_hours, status)
    VALUES (o, m3, j2, 'PJ-2', date_trunc('day', now()) + interval '60 days 09:00', 2, 'booked') RETURNING id INTO bj2;
  INSERT INTO public.machine_bookings (organization_id, machine_id, job_id, job_no, start_at, estimated_hours, status)
    VALUES (o, m3, j3, 'PJ-3', date_trunc('day', now()) + interval '70 days 09:00', 2, 'booked') RETURNING id INTO bj3;
  INSERT INTO public.job_machines (organization_id, job_id, machine_id, estimated_hours, booking_id) VALUES (o, j2, m3, 2, bj2), (o, j3, m3, 2, bj3);
  u := (SELECT v FROM proof.ids WHERE k = 'u_workshop');
  INSERT INTO public.machine_runs (organization_id, machine_id, job_id, booking_id, operator_id, started_at, ended_at, end_reason)
    VALUES (o, m1, j1, b_end, u, now() - interval '30 hours', now() - interval '29 hours', 'paused');
  INSERT INTO public.machine_runs (organization_id, machine_id, job_id, booking_id, operator_id, started_at)
    VALUES (o, m2, j1, b_act, u, now() - interval '1 hour');
  INSERT INTO public.machine_runs (organization_id, machine_id, job_id, booking_id, operator_id, started_at, ended_at, end_reason)
    VALUES (o, m1, j1, b_cmp, u, now() - interval '28 hours', now() - interval '27 hours', 'finished');
  INSERT INTO public.machine_runs (organization_id, machine_id, job_id, booking_id, operator_id, started_at, ended_at, end_reason)
    VALUES (o, m3, j2, bj2, u, now() - interval '26 hours', now() - interval '25 hours', 'paused');
  INSERT INTO proof.ids VALUES ('o',o),('m1',m1),('m2',m2),('m3',m3),('j1',j1),('j2',j2),('j3',j3),('b_end',b_end),('b_act',b_act),('b_cmp',b_cmp),('bf',bf),('bj2',bj2),('bj3',bj3);
END $$;
CREATE FUNCTION proof.id(k TEXT) RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT v FROM proof.ids WHERE ids.k = $1 $$;
GRANT EXECUTE ON FUNCTION proof.id(TEXT) TO authenticated, service_role;
CREATE TABLE proof.snap AS SELECT (SELECT md5(string_agg(r::text, '|' ORDER BY r.id)) FROM public.machine_runs r WHERE r.organization_id = proof.id('o')) AS runs;

CREATE FUNCTION proof.attempt(p_path TEXT, p_expect TEXT, p_sql TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE st TEXT; hi TEXT; ms TEXT; got TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql; got := 'ok';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, hi = PG_EXCEPTION_HINT, ms = MESSAGE_TEXT;
    got := st || CASE WHEN coalesce(hi, '') <> '' THEN '/' || hi ELSE '' END;
  END;
  INSERT INTO proof.res (path, expect, got, msg, ok) VALUES (p_path, p_expect, got, ms, got = p_expect);
END $$;
GRANT EXECUTE ON FUNCTION proof.attempt(TEXT, TEXT, TEXT) TO authenticated, service_role;
CREATE FUNCTION proof.as_user(r TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', proof.id('u_' || r), 'role', 'authenticated', 'aal', 'aal1')::text, false) $$;

-- ---- delete_machine_booking, every role, as the API calls it ----
SELECT proof.as_user('admin'); SET ROLE authenticated;
SELECT proof.attempt('D1 admin: booked booking, ended run', '23514/booking_has_runs', format('SELECT public.delete_machine_booking(%L)', proof.id('b_end')));
SELECT proof.attempt('D2 admin: running booking, open run', '23514/booking_has_runs', format('SELECT public.delete_machine_booking(%L)', proof.id('b_act')));
SELECT proof.attempt('D3 admin: complete booking, finished run', '23514/booking_has_runs', format('SELECT public.delete_machine_booking(%L)', proof.id('b_cmp')));
RESET ROLE; SELECT proof.as_user('office'); SET ROLE authenticated;
SELECT proof.attempt('D4 office: booked booking, ended run', '23514/booking_has_runs', format('SELECT public.delete_machine_booking(%L)', proof.id('b_end')));
RESET ROLE; SELECT proof.as_user('workshop'); SET ROLE authenticated;
SELECT proof.attempt('D5 workshop: booked booking, ended run', '23514/booking_has_runs', format('SELECT public.delete_machine_booking(%L)', proof.id('b_end')));
RESET ROLE; SELECT proof.as_user('viewer'); SET ROLE authenticated;
SELECT proof.attempt('D6 viewer: refused as before (role)', '42501', format('SELECT public.delete_machine_booking(%L)', proof.id('b_end')));
RESET ROLE; SELECT proof.as_user('admin'); SET ROLE authenticated;
SELECT proof.attempt('D7 admin: booking with no runs is removed (control)', 'ok', format('SELECT public.delete_machine_booking(%L)', proof.id('bf')));
SELECT proof.attempt('D8 admin: removed again: P0002 as before', 'P0002', format('SELECT public.delete_machine_booking(%L)', proof.id('bf')));
SELECT proof.attempt('D9 admin: unknown id: P0002 as before', 'P0002', format('SELECT public.delete_machine_booking(%L)', gen_random_uuid()));
-- ---- set_job_machines taking a machine off a job ----
SELECT proof.attempt('S1 admin: remove M3 from PJ-2 (booked booking has a run)', '23514/booking_has_runs',
  format($q$SELECT public.set_job_machines(%L, '[]'::jsonb, FALSE, '[]'::jsonb, NULL)$q$, proof.id('j2')));
RESET ROLE; SELECT proof.as_user('office'); SET ROLE authenticated;
SELECT proof.attempt('S2 office: same', '23514/booking_has_runs', format($q$SELECT public.set_job_machines(%L, '[]'::jsonb, FALSE, '[]'::jsonb, NULL)$q$, proof.id('j2')));
RESET ROLE; SELECT proof.as_user('workshop'); SET ROLE authenticated;
SELECT proof.attempt('S3 workshop: same', '23514/booking_has_runs', format($q$SELECT public.set_job_machines(%L, '[]'::jsonb, FALSE, '[]'::jsonb, NULL)$q$, proof.id('j2')));
SELECT proof.attempt('S4 workshop: remove M3 from PJ-3 (no runs): removed (control)', 'ok', format($q$SELECT public.set_job_machines(%L, '[]'::jsonb, FALSE, '[]'::jsonb, NULL)$q$, proof.id('j3')));
RESET ROLE;

SELECT n, path, expect, got, ok, msg FROM proof.res ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS pass, count(*) FILTER (WHERE NOT ok) AS fail FROM proof.res;
SELECT (SELECT runs FROM proof.snap) = (SELECT md5(string_agg(r::text, '|' ORDER BY r.id)) FROM public.machine_runs r WHERE r.organization_id = proof.id('o')) AS runs_unchanged,
  (SELECT count(*) FROM public.machine_runs r WHERE r.organization_id = proof.id('o') AND r.booking_id IS NULL) = 0 AS no_run_unlinked,
  (SELECT count(*) FROM public.machine_bookings b WHERE b.id IN (proof.id('b_end'), proof.id('b_act'), proof.id('b_cmp'), proof.id('bj2'))) = 4 AS bookings_with_runs_kept,
  EXISTS (SELECT 1 FROM public.job_machines WHERE job_id = proof.id('j2') AND machine_id = proof.id('m3') AND booking_id = proof.id('bj2')) AS pj2_plan_kept_linked,
  NOT EXISTS (SELECT 1 FROM public.machine_bookings WHERE id IN (proof.id('bf'), proof.id('bj3'))) AS controls_removed,
  NOT EXISTS (SELECT 1 FROM public.job_machines WHERE job_id = proof.id('j3')) AS pj3_plan_removed;

-- ---- Part 2: accept_quote ----
TRUNCATE proof.res;
DO $$
DECLARE o UUID := proof.id('o'); q UUID; k TEXT; st TEXT; tv NUMERIC; lp NUMERIC;
BEGIN
  FOR k, st, tv, lp IN SELECT * FROM (VALUES ('q_zero', 'draft', 0::numeric, 0::numeric), ('q_zero_sent', 'sent', 0, 0), ('q_null', 'draft', NULL, 0),
      ('q_neg', 'sent', -5, 0), ('q_acc0', 'accepted', 0, 0), ('q_rej0', 'rejected', 0, 0), ('q_exp0', 'expired', 0, 0),
      ('q_penny', 'sent', 0.01, 0.01), ('q_ok', 'sent', 120, 100)) v(k, st, tv, lp) LOOP
    INSERT INTO public.quotes (organization_id, quote_ref, customer, status, total_value, vat_enabled)
      VALUES (o, 'QUO-P-' || k, 'Synthetic Co', st, tv, k = 'q_ok') RETURNING id INTO q;
    INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price) VALUES (o, q, 0, 'Line', 1, lp);
    INSERT INTO proof.ids VALUES (k, q);
  END LOOP;
END $$;
CREATE TABLE proof.qsnap AS SELECT id, status, accepted_at FROM public.quotes WHERE organization_id = proof.id('o');
SELECT proof.as_user('office'); SET ROLE authenticated;
SELECT proof.attempt('Q1 office: draft quote for 0.00', '22023/quote_zero_value', format('SELECT public.accept_quote(%L, %L, NULL)', proof.id('q_zero'), 'PO-1'));
SELECT proof.attempt('Q2 office: sent quote for 0.00, with p_lines', '22023/quote_zero_value', format('SELECT public.accept_quote(%L, NULL, NULL, ARRAY(SELECT id FROM public.quote_line_items WHERE quote_id = %L))', proof.id('q_zero_sent'), proof.id('q_zero_sent')));
SELECT proof.attempt('Q3 office: quote with no total (NULL)', '22023/quote_zero_value', format('SELECT public.accept_quote(%L)', proof.id('q_null')));
SELECT proof.attempt('Q4 office: quote for -5.00', '22023/quote_zero_value', format('SELECT public.accept_quote(%L)', proof.id('q_neg')));
SELECT proof.attempt('Q5 office: accepted quote for 0.00 (order made later)', '22023/quote_zero_value', format('SELECT public.accept_quote(%L, %L)', proof.id('q_acc0'), 'PO-2'));
SELECT proof.attempt('Q6 office: rejected 0.00 keeps its refusal', '22023/quote_decided', format('SELECT public.accept_quote(%L)', proof.id('q_rej0')));
SELECT proof.attempt('Q7 office: expired 0.00 keeps its refusal', '22023', format('SELECT public.accept_quote(%L)', proof.id('q_exp0')));
RESET ROLE; SELECT proof.as_user('admin'); SET ROLE authenticated;
SELECT proof.attempt('Q8 admin: draft quote for 0.00', '22023/quote_zero_value', format('SELECT public.accept_quote(%L)', proof.id('q_zero')));
SELECT proof.attempt('Q9 admin: quote for 0.01 accepted (control)', 'ok', format('SELECT public.accept_quote(%L)', proof.id('q_penny')));
SELECT proof.attempt('Q10 admin: quote for 120.00 accepted (control)', 'ok', format('SELECT public.accept_quote(%L, %L)', proof.id('q_ok'), 'PO-OK'));
RESET ROLE; SELECT proof.as_user('workshop'); SET ROLE authenticated;
SELECT proof.attempt('Q11 workshop: refused by role as before', '42501', format('SELECT public.accept_quote(%L)', proof.id('q_zero')));
RESET ROLE;
SELECT n, path, expect, got, ok, msg FROM proof.res ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS pass, count(*) FILTER (WHERE NOT ok) AS fail FROM proof.res;
SELECT bool_and(q.status IS NOT DISTINCT FROM s.status AND q.accepted_at IS NOT DISTINCT FROM s.accepted_at) FILTER (WHERE s.id NOT IN (proof.id('q_penny'), proof.id('q_ok'))) AS refused_quotes_unchanged,
       bool_and(q.status = 'accepted') FILTER (WHERE s.id IN (proof.id('q_penny'), proof.id('q_ok'))) AS controls_accepted,
       (SELECT count(*) FROM public.sales_orders so WHERE so.quote_id IN (SELECT id FROM proof.qsnap WHERE id NOT IN (proof.id('q_penny'), proof.id('q_ok')))) = 0 AS no_order_for_refused,
       (SELECT count(*) FROM public.sales_orders so WHERE so.quote_id = proof.id('q_ok')) = 1 AS control_order_made
FROM public.quotes q JOIN proof.qsnap s ON s.id = q.id;

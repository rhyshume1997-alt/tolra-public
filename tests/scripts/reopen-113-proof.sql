-- Local proof for migration 113 (reopen sign-off). Run on a COPY of a database with 000..101 applied, plus 113:
--   createdb r_reopen -T sec_base; psql -d r_reopen -1 -f supabase/release/113_reopen_requests.release.sql; psql -d r_reopen -f this
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises (ON_ERROR_STOP).
\set ON_ERROR_STOP 1
\set QUIET 1
\o /dev/null
BEGIN;
-- Two companies. A: admin, admin2, office, workshop (w1, w2). B: admin.
INSERT INTO public.organizations (id, name, slug) VALUES
  ('11300000-0000-0000-0000-0000000000a0', 'Reopen A', 'reopen-a'), ('11300000-0000-0000-0000-0000000000b0', 'Reopen B', 'reopen-b');
INSERT INTO auth.users (id, email) VALUES
  ('11300000-0000-0000-0000-00000000a001', 'admin.a@example.test'), ('11300000-0000-0000-0000-00000000a002', 'admin2.a@example.test'),
  ('11300000-0000-0000-0000-00000000a003', 'office.a@example.test'), ('11300000-0000-0000-0000-00000000a004', 'w1.a@example.test'),
  ('11300000-0000-0000-0000-00000000a005', 'w2.a@example.test'), ('11300000-0000-0000-0000-00000000b001', 'admin.b@example.test');
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id) VALUES
  ('11300000-0000-0000-0000-00000000a001', 'admin.a@example.test', 'Admin A', 'admin', '11300000-0000-0000-0000-0000000000a0'),
  ('11300000-0000-0000-0000-00000000a002', 'admin2.a@example.test', 'Admin Two', 'admin', '11300000-0000-0000-0000-0000000000a0'),
  ('11300000-0000-0000-0000-00000000a003', 'office.a@example.test', 'Office A', 'office', '11300000-0000-0000-0000-0000000000a0'),
  ('11300000-0000-0000-0000-00000000a004', 'w1.a@example.test', 'Worker One', 'workshop', '11300000-0000-0000-0000-0000000000a0'),
  ('11300000-0000-0000-0000-00000000a005', 'w2.a@example.test', 'Worker Two', 'workshop', '11300000-0000-0000-0000-0000000000a0'),
  ('11300000-0000-0000-0000-00000000b001', 'admin.b@example.test', 'Admin B', 'admin', '11300000-0000-0000-0000-0000000000b0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, full_name = EXCLUDED.full_name;
INSERT INTO public.organization_members (user_id, organization_id, role) VALUES
  ('11300000-0000-0000-0000-00000000a001', '11300000-0000-0000-0000-0000000000a0', 'admin'),
  ('11300000-0000-0000-0000-00000000a002', '11300000-0000-0000-0000-0000000000a0', 'admin'),
  ('11300000-0000-0000-0000-00000000a003', '11300000-0000-0000-0000-0000000000a0', 'office'),
  ('11300000-0000-0000-0000-00000000a004', '11300000-0000-0000-0000-0000000000a0', 'workshop'),
  ('11300000-0000-0000-0000-00000000a005', '11300000-0000-0000-0000-0000000000a0', 'workshop'),
  ('11300000-0000-0000-0000-00000000b001', '11300000-0000-0000-0000-0000000000b0', 'admin')
ON CONFLICT DO NOTHING;
-- Finished jobs (finished by w1 unless said): J1 tick box, J2 admin-present by w1 (waits), J3 admin reopens, J4 invoiced, J5 finished by
-- w2, J6 gone out on a delivery note, JB company B's.
INSERT INTO public.jobs (id, organization_id, job_no, finished_at, finished_by, customer) VALUES
  ('11300000-0000-0000-0000-000000000001', '11300000-0000-0000-0000-0000000000a0', 'J-1131', now() - interval '1 hour', '11300000-0000-0000-0000-00000000a004', 'Customer'),
  ('11300000-0000-0000-0000-000000000002', '11300000-0000-0000-0000-0000000000a0', 'J-1132', now() - interval '1 hour', '11300000-0000-0000-0000-00000000a004', 'Customer'),
  ('11300000-0000-0000-0000-000000000003', '11300000-0000-0000-0000-0000000000a0', 'J-1133', now() - interval '1 hour', '11300000-0000-0000-0000-00000000a004', 'Customer'),
  ('11300000-0000-0000-0000-000000000004', '11300000-0000-0000-0000-0000000000a0', 'J-1134', now() - interval '1 hour', '11300000-0000-0000-0000-00000000a004', 'Customer'),
  ('11300000-0000-0000-0000-000000000005', '11300000-0000-0000-0000-0000000000a0', 'J-1135', now() - interval '1 hour', '11300000-0000-0000-0000-00000000a005', 'Customer'),
  ('11300000-0000-0000-0000-000000000006', '11300000-0000-0000-0000-0000000000a0', 'J-1136', now() - interval '1 hour', '11300000-0000-0000-0000-00000000a004', 'Customer'),
  ('11300000-0000-0000-0000-00000000000b', '11300000-0000-0000-0000-0000000000b0', 'J-113B', now() - interval '1 hour', '11300000-0000-0000-0000-00000000b001', 'Customer');
-- J4 is invoiced (an issued invoice), J6 has gone out (a despatched delivery note): reopen_job (081) refuses both.
INSERT INTO public.invoices (id, organization_id, customer, job_id, invoice_ref, status) VALUES
  ('11300000-0000-0000-0000-0000000000f4', '11300000-0000-0000-0000-0000000000a0', 'Customer', '11300000-0000-0000-0000-000000000004', 'INV-1134', 'issued');
INSERT INTO public.delivery_notes (organization_id, dn_number, status, job_id) VALUES
  ('11300000-0000-0000-0000-0000000000a0', 'DN-1136', 'despatched', '11300000-0000-0000-0000-000000000006');
CREATE TEMP TABLE proof_invoice_before AS SELECT md5(row_to_json(i)::TEXT) AS h FROM public.invoices i WHERE i.id = '11300000-0000-0000-0000-0000000000f4';
GRANT SELECT ON proof_invoice_before TO authenticated;

-- Sign in as a person of the given company (aal2, so an admin passes the second step).
CREATE FUNCTION pg_temp.sign_in(p_user TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::TEXT, TRUE),
         set_config('request.jwt.claim.sub', p_user, TRUE), set_config('role', 'authenticated', TRUE);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.sign_in(TEXT) TO authenticated;
CREATE FUNCTION pg_temp.expect_refused(p_sql TEXT, p_label TEXT, p_like TEXT DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_msg TEXT; v_state TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF p_like IS NOT NULL AND v_msg NOT ILIKE p_like THEN
      RAISE EXCEPTION 'FAIL % refused for the wrong reason: % %', p_label, v_state, v_msg;
    END IF;
    RAISE NOTICE 'PASS % refused (% %)', p_label, v_state, v_msg;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % was allowed', p_label;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_refused(TEXT, TEXT, TEXT) TO authenticated;

-- 1. Tick box: w1 reopens their own finish with no admin about. Done at once; a pending row, notified; the job is back In progress.
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000a004');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000001', 'too short', 'tick_box_notify')$$, 'reason under 10 characters', '%10 to 500%');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000001', 'Finished by mistake, still machining', 'whenever')$$, 'unknown approval mode', '%Choose how%');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('quote', '11300000-0000-0000-0000-000000000001', 'Finished by mistake, still machining', 'tick_box_notify')$$, 'a quote (no reopen exists)', '%Only a job%');
DO $$ DECLARE r JSONB; p JSONB; BEGIN
  p := public.reopen_preview('job', '11300000-0000-0000-0000-000000000001');
  IF NOT (p ->> 'allowed')::BOOLEAN OR (p ->> 'is_admin')::BOOLEAN OR p ->> 'record_ref' <> 'J-1131' THEN RAISE EXCEPTION 'FAIL preview J1 %', p; END IF;
  r := public.reopen_record('job', '11300000-0000-0000-0000-000000000001', 'Finished by mistake, still machining', 'tick_box_notify');
  IF r ->> 'status' <> 'pending' OR NOT (r ->> 'reopened')::BOOLEAN THEN RAISE EXCEPTION 'FAIL tick box answer %', r; END IF;
  RAISE NOTICE 'PASS tick box: reopened now, request pending for the admin (%)', r ->> 'request_id';
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT finished_at FROM public.jobs WHERE id = '11300000-0000-0000-0000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'FAIL J1 still finished'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reopen_requests WHERE record_id = '11300000-0000-0000-0000-000000000001' AND approval_mode = 'tick_box_notify'
                 AND status = 'pending' AND notified_at IS NOT NULL AND reopened_at IS NOT NULL AND requested_by = '11300000-0000-0000-0000-00000000a004') THEN
    RAISE EXCEPTION 'FAIL J1 request row'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_flow_events WHERE job_id = '11300000-0000-0000-0000-000000000001' AND kind = 'reopen' AND reason = 'Finished by mistake, still machining') THEN
    RAISE EXCEPTION 'FAIL J1 job flow event (081) missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM security_audit.audit_log WHERE action = 'reopen_requested' AND entity_table = 'reopen_requests'
                 AND metadata ->> 'approval_mode' = 'tick_box_notify' AND actor_user_id = '11300000-0000-0000-0000-00000000a004') THEN
    RAISE EXCEPTION 'FAIL J1 audit event'; END IF;
  RAISE NOTICE 'PASS tick box: job reopened, request row, 081 flow event and audit event in one transaction';
END $$;

-- 2. Rules of 081 still hold, for every mode: w1 can't reopen w2's finish, an invoiced job or a job gone out; nothing is left behind.
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000a004');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000005', 'Finished by mistake, still machining', 'tick_box_notify')$$, 'w1 reopening w2''s finish (tick box)', '%finished by someone else%');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000005', 'Finished by mistake, still machining', 'admin_present')$$, 'w1 reopening w2''s finish (admin present)', '%finished by someone else%');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000004', 'Finished by mistake, still machining', 'tick_box_notify')$$, 'invoiced job (tick box)', '%has been invoiced (INV-1134)%');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000006', 'Finished by mistake, still machining', 'admin_present')$$, 'job gone out (admin present)', '%has gone out (DN-1136)%');
DO $$ DECLARE p JSONB; BEGIN
  p := public.reopen_preview('job', '11300000-0000-0000-0000-000000000004');
  IF (p ->> 'allowed')::BOOLEAN OR p -> 'issued_invoices' <> '["INV-1134"]'::JSONB OR p ->> 'refusal' NOT LIKE '%invoiced%' THEN RAISE EXCEPTION 'FAIL preview J4 %', p; END IF;
  RAISE NOTICE 'PASS preview names the issued invoice and the refusal: %', p ->> 'refusal';
END $$;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.reopen_requests WHERE record_id IN ('11300000-0000-0000-0000-000000000004', '11300000-0000-0000-0000-000000000005', '11300000-0000-0000-0000-000000000006')) THEN
    RAISE EXCEPTION 'FAIL a refused reopen left a request row'; END IF;
  IF (SELECT count(*) FROM public.jobs WHERE id IN ('11300000-0000-0000-0000-000000000004', '11300000-0000-0000-0000-000000000005', '11300000-0000-0000-0000-000000000006') AND finished_at IS NOT NULL) <> 3 THEN
    RAISE EXCEPTION 'FAIL a refused job was reopened'; END IF;
  IF (SELECT md5(row_to_json(i)::TEXT) FROM public.invoices i WHERE i.id = '11300000-0000-0000-0000-0000000000f4') <> (SELECT h FROM proof_invoice_before) THEN
    RAISE EXCEPTION 'FAIL the issued invoice changed'; END IF;
  IF EXISTS (SELECT 1 FROM public.job_flow_events WHERE job_id IN ('11300000-0000-0000-0000-000000000004', '11300000-0000-0000-0000-000000000005', '11300000-0000-0000-0000-000000000006')
             AND kind = 'reopen') THEN RAISE EXCEPTION 'FAIL a refused attempt or a preview left a reopen event'; END IF;
  RAISE NOTICE 'PASS refusals and previews leave no row, no reopen event, no reopen, and the issued invoice byte for byte as it was';
END $$;

-- 3. Admin present, caller not an admin: w1 asks on J2. Nothing is reopened until an admin approves with their own session.
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000a004');
DO $$ DECLARE r JSONB; BEGIN
  r := public.reopen_record('job', '11300000-0000-0000-0000-000000000002', 'Customer changed the drawing, rework needed', 'admin_present');
  IF r ->> 'status' <> 'pending' OR (r ->> 'reopened')::BOOLEAN THEN RAISE EXCEPTION 'FAIL admin present (non-admin) answer %', r; END IF;
  RAISE NOTICE 'PASS admin present by a non-admin: waiting, not reopened';
  IF (SELECT count(*) FROM public.reopen_requests) <> 2 THEN RAISE EXCEPTION 'FAIL w1 should read both of A''s requests'; END IF;
  RAISE NOTICE 'PASS a member reads their own company''s requests';
END $$;
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000002', 'Customer changed the drawing, rework needed', 'admin_present')$$, 'a second waiting request for J2', '%already waiting%');
-- Non-admin approval refused (the requester, and the office).
SELECT pg_temp.expect_refused(format($$SELECT public.decide_reopen_request(%L, 'approve', NULL)$$, (SELECT id FROM public.reopen_requests WHERE record_id = '11300000-0000-0000-0000-000000000002')), 'workshop approving', '%Only an admin%');
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000a003');
SELECT pg_temp.expect_refused(format($$SELECT public.decide_reopen_request(%L, 'approve', NULL)$$, (SELECT id FROM public.reopen_requests WHERE record_id = '11300000-0000-0000-0000-000000000002')), 'office approving', '%Only an admin%');
-- No direct writes for anyone: the table grants SELECT only.
SELECT pg_temp.expect_refused($$UPDATE public.reopen_requests SET status = 'approved', approved_by = auth.uid(), approved_at = now()$$, 'office updating a request directly', '%permission denied%');
SELECT pg_temp.expect_refused($$INSERT INTO public.reopen_requests (organization_id, record_type, record_id, requested_by, reason, approval_mode, status, approved_by, approved_at, reopened_at)
  VALUES ('11300000-0000-0000-0000-0000000000a0', 'job', '11300000-0000-0000-0000-000000000003', auth.uid(), 'forged approval row', 'admin_present', 'approved', auth.uid(), now(), now())$$, 'office inserting a request directly', '%permission denied%');
RESET ROLE;
DO $$ BEGIN
  IF (SELECT finished_at FROM public.jobs WHERE id = '11300000-0000-0000-0000-000000000002') IS NULL THEN RAISE EXCEPTION 'FAIL J2 reopened before approval'; END IF;
  RAISE NOTICE 'PASS J2 still finished while it waits';
END $$;

-- 4. Other company refused: B's admin can't see, preview, reopen or decide anything of A's; A can't touch B's job.
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000b001');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.reopen_requests) THEN RAISE EXCEPTION 'FAIL B reads A''s requests'; END IF;
  RAISE NOTICE 'PASS B reads none of A''s requests';
END $$;
SELECT pg_temp.expect_refused(format($$SELECT public.decide_reopen_request(%L, 'approve', NULL)$$, '00000000-0000-0000-0000-000000000000'), 'B deciding a request id that is not theirs', '%not found%');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000003', 'Cross-company attempt here', 'admin_present')$$, 'B reopening A''s job', '%not found%');
SELECT pg_temp.expect_refused($$SELECT public.reopen_preview('job', '11300000-0000-0000-0000-000000000003')$$, 'B previewing A''s job', '%not found%');
RESET ROLE;
CREATE TEMP TABLE proof_a_request AS SELECT id FROM public.reopen_requests WHERE record_id = '11300000-0000-0000-0000-000000000002';
GRANT SELECT ON proof_a_request TO authenticated;
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000b001');
SELECT pg_temp.expect_refused($$SELECT public.decide_reopen_request((SELECT id FROM proof_a_request), 'reject', NULL)$$, 'B rejecting A''s real request', '%not found%');
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000a001');
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-00000000000b', 'Cross-company attempt here', 'admin_present')$$, 'A''s admin reopening B''s job', '%not found%');
RESET ROLE;
DO $$ BEGIN
  IF (SELECT finished_at FROM public.jobs WHERE id = '11300000-0000-0000-0000-00000000000b') IS NULL OR (SELECT status FROM public.reopen_requests WHERE id = (SELECT id FROM proof_a_request)) <> 'pending' THEN
    RAISE EXCEPTION 'FAIL a cross-company attempt changed something'; END IF;
  RAISE NOTICE 'PASS cross-company attempts changed nothing';
END $$;

-- 5. A's admin approves J2 with their own session: reopened now, approved by them.
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000a001');
DO $$ DECLARE r JSONB; BEGIN
  r := public.decide_reopen_request((SELECT id FROM proof_a_request), 'approve', NULL);
  IF r ->> 'status' <> 'approved' OR NOT (r ->> 'reopened_now')::BOOLEAN THEN RAISE EXCEPTION 'FAIL approve J2 %', r; END IF;
  RAISE NOTICE 'PASS admin approved J2 with their own session: reopened now';
END $$;
SELECT pg_temp.expect_refused($$SELECT public.decide_reopen_request((SELECT id FROM proof_a_request), 'reject', NULL)$$, 'deciding twice', '%already been approved%');
-- An admin can't use the tick box (they approve now), and an admin present reopen by an admin is approved at once.
SELECT pg_temp.expect_refused($$SELECT public.reopen_record('job', '11300000-0000-0000-0000-000000000003', 'Needs another pass on the mill', 'tick_box_notify')$$, 'admin ticking no admin available', '%approve the reopen now%');
DO $$ DECLARE r JSONB; BEGIN
  r := public.reopen_record('job', '11300000-0000-0000-0000-000000000003', 'Needs another pass on the mill', 'admin_present');
  IF r ->> 'status' <> 'approved' OR NOT (r ->> 'reopened')::BOOLEAN THEN RAISE EXCEPTION 'FAIL admin present by admin %', r; END IF;
  RAISE NOTICE 'PASS admin present by an admin: reopened and approved at once';
END $$;
-- 6. The tick-box request on J1 is rejected after the fact: the decision is recorded, the reopen is NOT undone.
DO $$ DECLARE r JSONB; BEGIN
  r := public.decide_reopen_request((SELECT id FROM public.reopen_requests WHERE record_id = '11300000-0000-0000-0000-000000000001'), 'reject', 'Should have asked first');
  IF r ->> 'status' <> 'rejected' OR NOT (r ->> 'reopen_kept')::BOOLEAN THEN RAISE EXCEPTION 'FAIL reject J1 %', r; END IF;
  RAISE NOTICE 'PASS tick-box reopen rejected after the fact: decision recorded, work kept';
END $$;
RESET ROLE;
DO $$ BEGIN
  IF (SELECT finished_at FROM public.jobs WHERE id = '11300000-0000-0000-0000-000000000002') IS NOT NULL THEN RAISE EXCEPTION 'FAIL J2 not reopened by the approval'; END IF;
  IF (SELECT finished_at FROM public.jobs WHERE id = '11300000-0000-0000-0000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'FAIL the rejection undid J1''s reopen'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reopen_requests WHERE record_id = '11300000-0000-0000-0000-000000000002' AND status = 'approved' AND approved_by = '11300000-0000-0000-0000-00000000a001' AND reopened_at IS NOT NULL) THEN RAISE EXCEPTION 'FAIL J2 row'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reopen_requests WHERE record_id = '11300000-0000-0000-0000-000000000001' AND status = 'rejected' AND rejected_by = '11300000-0000-0000-0000-00000000a001' AND decision_note = 'Should have asked first') THEN RAISE EXCEPTION 'FAIL J1 row'; END IF;
  IF (SELECT count(*) FROM security_audit.audit_log WHERE entity_table = 'reopen_requests' AND action IN ('reopen_requested', 'reopen_approved', 'reopen_rejected')) <> 5 THEN
    RAISE EXCEPTION 'FAIL audit events: %', (SELECT count(*) FROM security_audit.audit_log WHERE entity_table = 'reopen_requests'); END IF;
  IF EXISTS (SELECT 1 FROM security_audit.audit_log WHERE entity_table = 'reopen_requests' AND metadata::TEXT LIKE '%machining%') THEN RAISE EXCEPTION 'FAIL reason text in the audit'; END IF;
  RAISE NOTICE 'PASS rows, decisions and 5 audit events (no reason text) as expected';
END $$;

-- 7. The requester can never approve their own request (an admin who asked as office earlier, say): w1 made admin, then decides own.
UPDATE public.organization_members SET role = 'admin' WHERE user_id = '11300000-0000-0000-0000-00000000a004';
INSERT INTO public.reopen_requests (organization_id, record_type, record_id, record_ref, requested_by, reason, approval_mode, notified_at, status)
  VALUES ('11300000-0000-0000-0000-0000000000a0', 'job', '11300000-0000-0000-0000-000000000005', 'J-1135', '11300000-0000-0000-0000-00000000a004', 'Asked before promotion', 'admin_present', now(), 'pending');
SELECT pg_temp.sign_in('11300000-0000-0000-0000-00000000a004');
SELECT pg_temp.expect_refused($$SELECT public.decide_reopen_request((SELECT id FROM public.reopen_requests WHERE record_id = '11300000-0000-0000-0000-000000000005'), 'approve', NULL)$$, 'deciding own request', '%your own reopen%');
RESET ROLE;
\o
\echo 'ALL 113 PROOF CHECKS PASSED'
ROLLBACK;

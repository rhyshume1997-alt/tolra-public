-- Local proof for migration 110 (log_rfq_clarification: the e-mail and the RFQ status in one transaction). Run on a COPY of a
-- database with the chain applied plus 110:
--   createdb e_rfq -T sec_base; psql -d e_rfq -f supabase/release/110_rfq_clarification_atomic.release.sql; psql -d e_rfq -f this
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises FAIL.
\set ON_ERROR_STOP 1
BEGIN;
-- Two companies. A: office, workshop, an admin with E-mail and Approval hidden, an office with RFQ hidden. B: office.
INSERT INTO public.organizations (id, name, slug) VALUES
  ('11000000-0000-0000-0000-0000000000a0', 'Proof A', 't-proof-110-a'),
  ('11000000-0000-0000-0000-0000000000b0', 'Proof B', 't-proof-110-b');
INSERT INTO auth.users (id, email) VALUES
  ('11000000-0000-0000-0000-0000000000a1', 'office.a@example.test'),
  ('11000000-0000-0000-0000-0000000000a2', 'workshop.a@example.test'),
  ('11000000-0000-0000-0000-0000000000a3', 'admin.noemail.a@example.test'),
  ('11000000-0000-0000-0000-0000000000a4', 'office.norfq.a@example.test'),
  ('11000000-0000-0000-0000-0000000000b1', 'office.b@example.test');
INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES
  ('11000000-0000-0000-0000-0000000000a1', 'office.a@example.test', 'office', '11000000-0000-0000-0000-0000000000a0'),
  ('11000000-0000-0000-0000-0000000000a2', 'workshop.a@example.test', 'workshop', '11000000-0000-0000-0000-0000000000a0'),
  ('11000000-0000-0000-0000-0000000000a3', 'admin.noemail.a@example.test', 'admin', '11000000-0000-0000-0000-0000000000a0'),
  ('11000000-0000-0000-0000-0000000000a4', 'office.norfq.a@example.test', 'office', '11000000-0000-0000-0000-0000000000a0'),
  ('11000000-0000-0000-0000-0000000000b1', 'office.b@example.test', 'office', '11000000-0000-0000-0000-0000000000b0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id;
INSERT INTO public.organization_members (user_id, organization_id, role, hidden_sections) VALUES
  ('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-0000000000a0', 'office', '{}'),
  ('11000000-0000-0000-0000-0000000000a2', '11000000-0000-0000-0000-0000000000a0', 'workshop', '{}'),
  ('11000000-0000-0000-0000-0000000000a3', '11000000-0000-0000-0000-0000000000a0', 'admin', '{email,approval}'),
  ('11000000-0000-0000-0000-0000000000a4', '11000000-0000-0000-0000-0000000000a0', 'office', '{rfq}'),
  ('11000000-0000-0000-0000-0000000000b1', '11000000-0000-0000-0000-0000000000b0', 'office', '{}');
INSERT INTO public.rfqs (id, organization_id, customer, email, description, status) VALUES
  ('11000000-0000-0000-0000-00000000f001', '11000000-0000-0000-0000-0000000000a0', 'Cust A1', ' a1@example.test ', 'new, no quote', 'new'),
  ('11000000-0000-0000-0000-00000000f002', '11000000-0000-0000-0000-0000000000a0', 'Cust A2', 'a2@example.test', 'ready, quoted', 'ready'),
  ('11000000-0000-0000-0000-00000000f003', '11000000-0000-0000-0000-0000000000a0', 'Cust A3', 'a3@example.test', 'already clarification', 'clarification'),
  ('11000000-0000-0000-0000-00000000f004', '11000000-0000-0000-0000-0000000000a0', 'Cust A4', '  ', 'no address', 'new'),
  ('11000000-0000-0000-0000-00000000f005', '11000000-0000-0000-0000-0000000000a0', 'Cust A5', 'a5@example.test', 'ready, no quote', 'ready'),
  ('11000000-0000-0000-0000-00000000f0b1', '11000000-0000-0000-0000-0000000000b0', 'Cust B1', 'b1@example.test', 'B''s RFQ', 'new');
INSERT INTO public.quotes (organization_id, quote_ref, customer, rfq_id) VALUES
  ('11000000-0000-0000-0000-0000000000a0', 'Q-PROOF-110', 'Cust A2', '11000000-0000-0000-0000-00000000f002');

-- A helper (rolled back with everything): sign in as someone, run a call, return '<sqlstate>/<hint>' or 'ok:<jsonb>'.
CREATE FUNCTION pg_temp.as_user(p_user UUID, p_rfq UUID, p_subject TEXT DEFAULT 'Clarification') RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_out JSONB; v_state TEXT; v_hint TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::TEXT, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_out := public.log_rfq_clarification(p_rfq, p_subject, 'Which grade?');
    RESET ROLE;
    RETURN 'ok:' || v_out::TEXT;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    RESET ROLE;
    RETURN v_state || '/' || v_hint;
  END;
END $$;

DO $$
DECLARE r TEXT; j JSONB; h RECORD;
BEGIN
  -- 1. Office A, a New RFQ with no quote: logged and moved, the row comes back.
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-00000000f001');
  IF r NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 1: %', r; END IF;
  j := substr(r, 4)::JSONB;
  IF NOT (j->>'moved')::BOOLEAN OR j->'rfq'->>'status' <> 'clarification' OR j->'rfq'->>'id' <> '11000000-0000-0000-0000-00000000f001' THEN RAISE EXCEPTION 'FAIL 1 result %', j; END IF;
  SELECT * INTO h FROM public.email_history WHERE id = (j->>'email_history_id')::UUID;
  IF h.status <> 'sent_manually' OR h.to_email <> 'a1@example.test' OR h.to_name <> 'Cust A1' OR h.related_to_type <> 'rfq'
     OR h.related_to_id <> '11000000-0000-0000-0000-00000000f001' OR h.drafted_by <> '11000000-0000-0000-0000-0000000000a1'
     OR h.sent_at IS NULL OR h.organization_id <> '11000000-0000-0000-0000-0000000000a0' THEN RAISE EXCEPTION 'FAIL 1 history %', row_to_json(h); END IF;
  IF (SELECT status FROM public.rfqs WHERE id = '11000000-0000-0000-0000-00000000f001') <> 'clarification' THEN RAISE EXCEPTION 'FAIL 1 stored'; END IF;
  IF (SELECT updated_by FROM public.rfqs WHERE id = '11000000-0000-0000-0000-00000000f001') IS DISTINCT FROM '11000000-0000-0000-0000-0000000000a1' THEN RAISE EXCEPTION 'FAIL 1 updated_by stamp (trigger) missing'; END IF;
  RAISE NOTICE 'PASS 1 office: New RFQ logged and moved to clarification in one call; history to the RFQ''s own address; updated_by stamped';

  -- 2. A Ready RFQ that already has a quote: logged, never moved.
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-00000000f002');
  IF r NOT LIKE 'ok:%' OR (substr(r, 4)::JSONB->>'moved')::BOOLEAN OR (SELECT status FROM public.rfqs WHERE id = '11000000-0000-0000-0000-00000000f002') <> 'ready' THEN RAISE EXCEPTION 'FAIL 2: %', r; END IF;
  RAISE NOTICE 'PASS 2 quoted RFQ: e-mail logged, status kept (ready)';
  -- 3. Already awaiting clarification: logged, moved = false.
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-00000000f003');
  IF r NOT LIKE 'ok:%' OR (substr(r, 4)::JSONB->>'moved')::BOOLEAN THEN RAISE EXCEPTION 'FAIL 3: %', r; END IF;
  RAISE NOTICE 'PASS 3 clarification RFQ: logged, moved=false';
  -- 4. A Ready RFQ with no quote moves too.
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-00000000f005');
  IF r NOT LIKE 'ok:%' OR NOT (substr(r, 4)::JSONB->>'moved')::BOOLEAN THEN RAISE EXCEPTION 'FAIL 4: %', r; END IF;
  RAISE NOTICE 'PASS 4 ready RFQ, no quote: moved';
END $$;

DO $$
DECLARE r TEXT; n_before BIGINT := (SELECT count(*) FROM public.email_history);
BEGIN
  -- 5. Office A on company B's RFQ: not found, nothing written anywhere.
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-00000000f0b1');
  IF r <> 'P0002/rfq_not_found' THEN RAISE EXCEPTION 'FAIL 5: %', r; END IF;
  -- 6. Office B on company A's RFQ: not found.
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000b1', '11000000-0000-0000-0000-00000000f001');
  IF r <> 'P0002/rfq_not_found' THEN RAISE EXCEPTION 'FAIL 6: %', r; END IF;
  IF (SELECT status FROM public.rfqs WHERE id = '11000000-0000-0000-0000-00000000f0b1') <> 'new' THEN RAISE EXCEPTION 'FAIL 5 B changed'; END IF;
  RAISE NOTICE 'PASS 5/6 other company refused both ways (P0002 rfq_not_found); B''s RFQ unchanged';
  -- 7. Workshop: refused.
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a2', '11000000-0000-0000-0000-00000000f005');
  IF r <> '42501/rfq_not_allowed' THEN RAISE EXCEPTION 'FAIL 7: %', r; END IF;
  -- 8. Admin with E-mail and Approval hidden: refused (email_history's section rule).
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a3', '11000000-0000-0000-0000-00000000f005');
  IF r <> '42501/rfq_not_allowed' THEN RAISE EXCEPTION 'FAIL 8: %', r; END IF;
  -- 9. Office with RFQ hidden: refused (rfqs' section rule).
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a4', '11000000-0000-0000-0000-00000000f005');
  IF r <> '42501/rfq_not_allowed' THEN RAISE EXCEPTION 'FAIL 9: %', r; END IF;
  RAISE NOTICE 'PASS 7/8/9 workshop, E-mail+Approval hidden, RFQ hidden: 42501 rfq_not_allowed';
  -- 10. No address, no subject: refused before anything is written.
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-00000000f004');
  IF r <> '22023/rfq_no_email' THEN RAISE EXCEPTION 'FAIL 10: %', r; END IF;
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-00000000f005', '  ');
  IF r <> '22023/rfq_email_subject' THEN RAISE EXCEPTION 'FAIL 10b: %', r; END IF;
  -- 11. Signed out (no sub): refused.
  r := pg_temp.as_user(NULL, '11000000-0000-0000-0000-00000000f005');
  IF r <> '42501/rfq_not_allowed' THEN RAISE EXCEPTION 'FAIL 11: %', r; END IF;
  IF (SELECT count(*) FROM public.email_history) <> n_before THEN RAISE EXCEPTION 'FAIL refusals wrote e-mail history'; END IF;
  RAISE NOTICE 'PASS 10/11 no address (rfq_no_email), blank subject (rfq_email_subject), no session: refused; no history written by any refusal';
END $$;

-- 12. All or nothing: when the status move fails (a trigger that refuses it, added inside this rolled-back transaction), the
-- history row is not kept either. (One call is one statement, so one transaction through the API: the point of 110.)
CREATE FUNCTION pg_temp.refuse() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the proof' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER proof_refuse BEFORE UPDATE ON public.rfqs FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse();
DO $$
DECLARE r TEXT; n_before BIGINT := (SELECT count(*) FROM public.email_history);
BEGIN
  INSERT INTO public.rfqs (id, organization_id, customer, email, description, status) VALUES
    ('11000000-0000-0000-0000-00000000f006', '11000000-0000-0000-0000-0000000000a0', 'Cust A6', 'a6@example.test', 'new', 'new');
  r := pg_temp.as_user('11000000-0000-0000-0000-0000000000a1', '11000000-0000-0000-0000-00000000f006');
  IF r <> '23514/' THEN RAISE EXCEPTION 'FAIL 12 call: %', r; END IF;
  IF (SELECT count(*) FROM public.email_history) <> n_before THEN RAISE EXCEPTION 'FAIL 12: history kept after the status move failed'; END IF;
  IF (SELECT status FROM public.rfqs WHERE id = '11000000-0000-0000-0000-00000000f006') <> 'new' THEN RAISE EXCEPTION 'FAIL 12 status'; END IF;
  RAISE NOTICE 'PASS 12 all or nothing: the status move failed, so no e-mail history row was kept';
END $$;
DROP TRIGGER proof_refuse ON public.rfqs;

-- 13. anon can't call it.
SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM public.log_rfq_clarification('11000000-0000-0000-0000-00000000f005', 's', 'b');
  RAISE EXCEPTION 'FAIL 13 anon called it';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 13 anon: no EXECUTE'; END $$;
RESET ROLE;
ROLLBACK;

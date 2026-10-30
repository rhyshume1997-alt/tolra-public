-- Proof for migration 117 (email_history.drafted_by is locked for API roles). Run on a database with migrations 000..117 applied:
--   PGPASSWORD=... psql -h HOST -U postgres -d DB -X -v ON_ERROR_STOP=1 -f tests/scripts/email-history-drafted-by-117.proof.sql
-- Creates its own company and two admins inside one transaction and ROLLS BACK: nothing is left behind. Any failed expectation
-- raises "PROOF FAILED: ..." and stops psql with a non-zero exit. Ends with "ALL PROOFS PASSED".
-- Cases: (1) authenticated cannot move drafted_by to another user; (2) authenticated may set it to the value it already has and may
-- update other columns; (3) 006's insert rule still refuses a drafted_by that is not the caller; (4) service_role is unaffected;
-- (5) the real SECURITY DEFINER retry path (reserve_mail_send, 031, hands a failed send to the admin who retries) still works;
-- (6) the foreign key's ON DELETE SET NULL (profile removed) still works.
BEGIN;

-- Fixtures (as the owner).
INSERT INTO public.organizations (id, name, slug) VALUES ('11111111-1111-1111-1111-111111111111', 'S9 proof co', 's9-proof-co');
INSERT INTO auth.users (id, email) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'a@s9.test'), ('bbbbbbbb-0000-0000-0000-000000000002', 'b@s9.test');
INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@s9.test', 'admin', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@s9.test', 'admin', '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO UPDATE SET role = 'admin', organization_id = EXCLUDED.organization_id;
INSERT INTO public.organization_members (user_id, organization_id, role) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'admin'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'admin')
ON CONFLICT (user_id, organization_id) DO UPDATE SET role = 'admin', active = TRUE;
INSERT INTO public.email_history (id, organization_id, to_email, subject, body, status, drafted_by) VALUES
  ('e1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'x@example.test', 's', 'b', 'drafted', 'aaaaaaaa-0000-0000-0000-000000000001');

-- (0) the owner (migrations, definer code) may change it: current_user is not an API role.
UPDATE public.email_history SET drafted_by = 'bbbbbbbb-0000-0000-0000-000000000002' WHERE id = 'e1000000-0000-0000-0000-000000000001';
UPDATE public.email_history SET drafted_by = 'aaaaaaaa-0000-0000-0000-000000000001' WHERE id = 'e1000000-0000-0000-0000-000000000001';

-- (1) to (3), (6 later): signed in as admin A.
DO $proof$
DECLARE
  v_state TEXT;
  v_n     INTEGER;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', TRUE);
  SET LOCAL ROLE authenticated;

  -- (1) another user's id: refused with 42501 by the trigger.
  BEGIN
    UPDATE public.email_history SET drafted_by = 'bbbbbbbb-0000-0000-0000-000000000002' WHERE id = 'e1000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'PROOF FAILED: authenticated moved drafted_by to another user';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_state = MESSAGE_TEXT;
    IF v_state NOT LIKE 'Email history: who drafted%' THEN RAISE EXCEPTION 'PROOF FAILED: refused, but not by the 117 trigger: %', v_state; END IF;
  END;
  -- NULL is a change too.
  BEGIN
    UPDATE public.email_history SET drafted_by = NULL WHERE id = 'e1000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'PROOF FAILED: authenticated cleared drafted_by';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Same id in the same statement as another edit: fine. And an ordinary edit that does not mention it: fine.
  UPDATE public.email_history SET drafted_by = 'aaaaaaaa-0000-0000-0000-000000000001', subject = 'edited' WHERE id = 'e1000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED: setting drafted_by to its current value updated % rows', v_n; END IF;
  UPDATE public.email_history SET body = 'edited too' WHERE id = 'e1000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED: an ordinary edit updated % rows', v_n; END IF;

  -- (3) 006's insert rule: drafted_by must be the caller (row level security, not the 117 trigger).
  BEGIN
    INSERT INTO public.email_history (organization_id, to_email, subject, body, status, drafted_by)
    VALUES ('11111111-1111-1111-1111-111111111111', 'y@example.test', 's', 'b', 'drafted', 'bbbbbbbb-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'PROOF FAILED: authenticated inserted a row drafted by someone else';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS v_state = MESSAGE_TEXT;
    IF v_state NOT LIKE '%row-level security%' THEN RAISE EXCEPTION 'PROOF FAILED: insert refused, but not by row level security: %', v_state; END IF;
  END;
  INSERT INTO public.email_history (organization_id, to_email, subject, body, status, drafted_by)
  VALUES ('11111111-1111-1111-1111-111111111111', 'y@example.test', 's', 'b', 'drafted', 'aaaaaaaa-0000-0000-0000-000000000001');
  RESET ROLE;
END
$proof$;

-- anon has no way in at all.
DO $proof$
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    UPDATE public.email_history SET drafted_by = NULL;
    RAISE EXCEPTION 'PROOF FAILED: anon updated email_history';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
END
$proof$;

-- (4) service_role is unaffected.
DO $proof$
DECLARE v_n INTEGER;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
  SET LOCAL ROLE service_role;
  UPDATE public.email_history SET drafted_by = 'bbbbbbbb-0000-0000-0000-000000000002' WHERE id = 'e1000000-0000-0000-0000-000000000001';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED: service_role update touched % rows', v_n; END IF;
  IF (SELECT drafted_by FROM public.email_history WHERE id = 'e1000000-0000-0000-0000-000000000001') <> 'bbbbbbbb-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION 'PROOF FAILED: service_role change did not stick';
  END IF;
  UPDATE public.email_history SET drafted_by = 'aaaaaaaa-0000-0000-0000-000000000001' WHERE id = 'e1000000-0000-0000-0000-000000000001';
END
$proof$;

-- (5) the real definer retry path: A reserves and fails a send, B retries the same key; reserve_mail_send (031) sets drafted_by = B.
DO $proof$
DECLARE
  v_key  TEXT := repeat('a', 64);
  v_res  JSONB;
  v_hist UUID;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', TRUE);
  SET LOCAL ROLE authenticated;
  v_res := public.reserve_mail_send('send', v_key, ARRAY['z@example.test'], 'subj', 'body', NULL);
  v_hist := (v_res ->> 'history_id')::UUID;
  PERFORM public.complete_mail_send((v_res ->> 'send_id')::UUID, 'failed');
  PERFORM set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', TRUE);
  v_res := public.reserve_mail_send('send', v_key, ARRAY['z@example.test'], 'subj', 'body', NULL);
  RESET ROLE;
  IF (v_res ->> 'history_id')::UUID <> v_hist THEN RAISE EXCEPTION 'PROOF FAILED: the retry did not reuse the history row'; END IF;
  IF (SELECT drafted_by FROM public.email_history WHERE id = v_hist) <> 'bbbbbbbb-0000-0000-0000-000000000002' THEN
    RAISE EXCEPTION 'PROOF FAILED: the retry did not hand the draft to the retrying admin';
  END IF;
END
$proof$;

-- (6) removing a profile still clears drafted_by through the foreign key (runs as the table owner).
DO $proof$
BEGIN
  DELETE FROM public.email_history WHERE drafted_by = 'bbbbbbbb-0000-0000-0000-000000000002' AND id <> 'e1000000-0000-0000-0000-000000000001';
  UPDATE public.email_history SET drafted_by = 'bbbbbbbb-0000-0000-0000-000000000002' WHERE id = 'e1000000-0000-0000-0000-000000000001';
  DELETE FROM public.organization_members WHERE user_id = 'bbbbbbbb-0000-0000-0000-000000000002';
  DELETE FROM public.user_profiles WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002';
  IF (SELECT drafted_by FROM public.email_history WHERE id = 'e1000000-0000-0000-0000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED: ON DELETE SET NULL did not clear drafted_by';
  END IF;
END
$proof$;

SELECT 'ALL PROOFS PASSED' AS result;
ROLLBACK;

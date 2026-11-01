-- Migration 106 proof on a throwaway copy of the local stand-in (never production):
--   PGPASSWORD=... psql -h 127.0.0.1 -U postgres -d <copy> -v ON_ERROR_STOP=1 -f tests/scripts/email_templates_106_proof.sql
-- Synthetic companies, people and sessions; forged session claims as PostgREST sends them; everything rolled back at the end.
-- Prints one line per check; any failed expectation raises and stops the script.
BEGIN;

CREATE FUNCTION pg_temp.be(p_user UUID, p_session UUID, p_aal TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated', 'aal', p_aal,
    'email', p_user::TEXT || '@example.test', 'session_id', p_session)::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE FUNCTION pg_temp.me() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;

DO $$
DECLARE
  org_a UUID := gen_random_uuid(); org_b UUID := gen_random_uuid();
  a_admin UUID := gen_random_uuid(); a_office UUID := gen_random_uuid(); a_workshop UUID := gen_random_uuid(); b_office UUID := gen_random_uuid();
  s_admin UUID := gen_random_uuid(); s_office UUID := gen_random_uuid(); s_workshop UUID := gen_random_uuid(); s_b UUID := gen_random_uuid();
  a_support UUID := gen_random_uuid(); s_support UUID := gen_random_uuid(); v_grant UUID := gen_random_uuid();
  v_j JSONB; v_j2 JSONB; v_key TEXT := repeat('a', 64); v_key2 TEXT := repeat('b', 64);
  n INT; v_by UUID; v_ok BOOLEAN; v_state TEXT;
  r RECORD;
BEGIN
  INSERT INTO public.organizations (id, name, slug, status, require_admin_mfa) VALUES (org_a, '106 alpha', 'zz-106-alpha-' || left(org_a::TEXT, 8), 'active', TRUE),
                                                                  (org_b, '106 beta', 'zz-106-beta-' || left(org_b::TEXT, 8), 'active', FALSE);
  FOR r IN SELECT * FROM (VALUES (a_admin, s_admin, org_a, 'admin'), (a_office, s_office, org_a, 'office'), (a_workshop, s_workshop, org_a, 'workshop'),
                                 (b_office, s_b, org_b, 'office')) v(u, s, o, role) LOOP
    INSERT INTO auth.users (id, email) VALUES (r.u, r.u::TEXT || '@example.test');
    INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
      VALUES (r.u, r.u::TEXT || '@example.test', 'Person', r.role, r.o, TRUE, FALSE);
    INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES (r.u, r.o, r.role, TRUE);
    INSERT INTO auth.sessions (id, user_id) VALUES (r.s, r.u);
    INSERT INTO security_audit.session_company (session_id, user_id, organization_id) VALUES (r.s, r.u, r.o);
  END LOOP;

  -- A platform owner's live (not elevated) support membership of company A.
  INSERT INTO auth.users (id, email) VALUES (a_support, a_support::TEXT || '@example.test');
  INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
    VALUES (a_support, a_support::TEXT || '@example.test', 'Tolra Support', 'admin', org_a, TRUE, FALSE);
  INSERT INTO security_audit.platform_admins (user_id) VALUES (a_support);
  INSERT INTO public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
    VALUES (a_support, org_a, 'admin', TRUE, TRUE, now() + interval '2 hours', v_grant);
  INSERT INTO auth.sessions (id, user_id) VALUES (s_support, a_support);
  INSERT INTO security_audit.session_company (session_id, user_id, organization_id, grant_id) VALUES (s_support, a_support, org_a, v_grant);

  -- 1. Office writes its company's template; updated_by is stamped from the session, not the client.
  PERFORM pg_temp.be(a_office, s_office, 'aal1');
  INSERT INTO public.email_templates (organization_id, key, subject, body, updated_by) VALUES (org_a, 'quote', 'Our quote {{document_number}}', 'Hello {{customer_name}}', b_office);
  SELECT updated_by INTO v_by FROM public.email_templates WHERE organization_id = org_a AND key = 'quote';
  IF v_by IS DISTINCT FROM a_office THEN RAISE EXCEPTION 'FAIL updated_by not stamped (%).', v_by; END IF;
  UPDATE public.email_templates SET body = 'Hi {{customer_name}}' WHERE organization_id = org_a AND key = 'quote';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'FAIL office update'; END IF;
  RAISE NOTICE 'PASS office inserts and updates its own company''s template; updated_by stamped';

  -- 2. Office can't write another company's template.
  BEGIN
    INSERT INTO public.email_templates (organization_id, key, subject, body) VALUES (org_b, 'quote', 'x', 'y');
    RAISE EXCEPTION 'FAIL cross-company insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS cross-company insert refused (42501)';
  END;
  -- Moving a row to another company: refused (RLS WITH CHECK, or the stamp trigger).
  BEGIN
    UPDATE public.email_templates SET organization_id = org_b WHERE organization_id = org_a AND key = 'quote';
    RAISE EXCEPTION 'FAIL row moved to another company';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS moving a template to another company refused';
  END;

  -- 3. Bad values refused: unknown key, CR/LF in the subject, empty body.
  BEGIN
    INSERT INTO public.email_templates (organization_id, key, subject, body) VALUES (org_a, 'alert', 'x', 'y');
    RAISE EXCEPTION 'FAIL unknown key allowed';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS unknown key refused';
  END;
  BEGIN
    INSERT INTO public.email_templates (organization_id, key, subject, body) VALUES (org_a, 'invoice', E'Hi\r\nBcc: x@evil.test', 'y');
    RAISE EXCEPTION 'FAIL CR/LF subject allowed';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS CR/LF in subject refused';
  END;
  BEGIN
    INSERT INTO public.email_templates (organization_id, key, subject, body) VALUES (org_a, 'invoice', 'x', '   ');
    RAISE EXCEPTION 'FAIL blank body allowed';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS blank body refused';
  END;
  -- One row per company per key.
  BEGIN
    INSERT INTO public.email_templates (organization_id, key, subject, body) VALUES (org_a, 'quote', 'x', 'y');
    RAISE EXCEPTION 'FAIL duplicate key allowed';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS one row per company per key';
  END;

  -- 4. Workshop reads its company's templates but writes nothing.
  PERFORM pg_temp.be(a_workshop, s_workshop, 'aal1');
  SELECT count(*) INTO n FROM public.email_templates; IF n <> 1 THEN RAISE EXCEPTION 'FAIL workshop sees % rows', n; END IF;
  UPDATE public.email_templates SET body = 'changed' WHERE organization_id = org_a;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'FAIL workshop updated'; END IF;
  DELETE FROM public.email_templates WHERE organization_id = org_a;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'FAIL workshop deleted'; END IF;
  BEGIN
    INSERT INTO public.email_templates (organization_id, key, subject, body) VALUES (org_a, 'invoice', 'x', 'y');
    RAISE EXCEPTION 'FAIL workshop insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS workshop reads, cannot insert, update or delete';
  END;

  -- 5. The other company sees nothing of company A.
  PERFORM pg_temp.be(b_office, s_b, 'aal1');
  SELECT count(*) INTO n FROM public.email_templates; IF n <> 0 THEN RAISE EXCEPTION 'FAIL other company sees % rows', n; END IF;
  DELETE FROM public.email_templates;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION 'FAIL other company deleted'; END IF;
  RAISE NOTICE 'PASS another company reads and deletes nothing';

  -- 6. Company A requires the second step: its admin at aal1 is refused by the admin_mfa guard; at aal2 may delete (Reset to default).
  PERFORM pg_temp.be(a_admin, s_admin, 'aal1');
  BEGIN
    DELETE FROM public.email_templates WHERE organization_id = org_a AND key = 'quote';
    RAISE EXCEPTION 'FAIL admin at aal1 deleted';
  EXCEPTION WHEN insufficient_privilege THEN GET STACKED DIAGNOSTICS v_state = PG_EXCEPTION_HINT; RAISE NOTICE 'PASS admin at aal1 refused (hint %)', v_state;
  END;
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  DELETE FROM public.email_templates WHERE organization_id = org_a AND key = 'quote';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'FAIL admin delete rows=%', n; END IF;
  INSERT INTO public.email_templates (organization_id, key, subject, body) VALUES (org_a, 'invoice', 'Invoice {{document_number}}', 'Body');
  RAISE NOTICE 'PASS admin (aal2) deletes and inserts';

  -- 6b. A support session can't write a template or change the switch.
  PERFORM pg_temp.be(a_support, s_support, 'aal2');
  BEGIN
    INSERT INTO public.email_templates (organization_id, key, subject, body) VALUES (org_a, 'timesheet', 'x', 'y');
    RAISE EXCEPTION 'FAIL support insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN GET STACKED DIAGNOSTICS v_state = PG_EXCEPTION_HINT; RAISE NOTICE 'PASS support session cannot write (hint %)', v_state;
  END;
  BEGIN
    PERFORM public.ai_helper_set_finance_check(TRUE);
    RAISE EXCEPTION 'FAIL support changed the switch';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS support session cannot change the finance check switch';
  END;

  -- 7. The finance check switch: off by default; admin turns it on; office can't; no direct UPDATE for anyone signed in.
  PERFORM pg_temp.me();
  INSERT INTO public.ai_helper_settings (organization_id) VALUES (org_b);
  SELECT finance_check_enabled INTO v_ok FROM public.ai_helper_settings WHERE organization_id = org_b;
  IF v_ok IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'FAIL default not false'; END IF;
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  PERFORM public.ai_helper_set_finance_check(TRUE);
  PERFORM pg_temp.me();
  SELECT finance_check_enabled INTO v_ok FROM public.ai_helper_settings WHERE organization_id = org_a;
  IF v_ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'FAIL admin switch did not save'; END IF;
  SELECT count(*) INTO n FROM security_audit.audit_log WHERE organization_id = org_a AND action = 'ai_helper_settings_updated' AND metadata ->> 'finance_check_enabled' = 'true';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL audit event missing'; END IF;
  RAISE NOTICE 'PASS finance check off by default; admin turns it on; audited';
  PERFORM pg_temp.be(a_office, s_office, 'aal1');
  BEGIN
    PERFORM public.ai_helper_set_finance_check(FALSE);
    RAISE EXCEPTION 'FAIL office changed the switch';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS office cannot change the finance check switch';
  END;
  BEGIN
    UPDATE public.ai_helper_settings SET finance_check_enabled = FALSE;
    RAISE EXCEPTION 'FAIL direct update allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS no direct UPDATE on ai_helper_settings';
  END;
  -- 7b. Company A requires the second step: its admin at aal1 can't change the finance check switch.
  PERFORM pg_temp.be(a_admin, s_admin, 'aal1');
  BEGIN
    PERFORM public.ai_helper_set_finance_check(FALSE);
    RAISE EXCEPTION 'FAIL admin at aal1 changed the switch';
  EXCEPTION WHEN insufficient_privilege THEN GET STACKED DIAGNOSTICS v_state = PG_EXCEPTION_HINT; RAISE NOTICE 'PASS admin at aal1 cannot change the finance check switch (hint %)', v_state;
  END;

  -- 8. (E8) The send ledger: a retry with the same key writes no second history row; a failed one is tried again on the same row.
  PERFORM pg_temp.be(a_office, s_office, 'aal1');
  v_j := public.reserve_company_email(org_a, a_office, v_key, 'c@example.test', 'Invoice 1', 'Body', 'invoice', 'rec-1', 'sending');
  v_j2 := public.reserve_company_email(org_a, a_office, v_key, 'c@example.test', 'Invoice 1', 'Body', 'invoice', 'rec-1', 'sending');
  IF (v_j ->> 'replay')::BOOLEAN OR NOT (v_j2 ->> 'replay')::BOOLEAN OR v_j ->> 'history_id' <> v_j2 ->> 'history_id' OR v_j2 ->> 'status' <> 'sending' THEN
    RAISE EXCEPTION 'FAIL retry not a replay: % %', v_j, v_j2;
  END IF;
  SELECT count(*) INTO n FROM public.email_history WHERE organization_id = org_a AND related_to_id = 'rec-1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL % history rows for one key', n; END IF;
  RAISE NOTICE 'PASS a retry with the same key is a replay: one history row, nothing new reserved';
  PERFORM public.complete_company_email(org_a, a_office, (v_j ->> 'send_id')::UUID, 'failed');
  v_j2 := public.reserve_company_email(org_a, a_office, v_key, 'c@example.test', 'Invoice 1', 'Body', 'invoice', 'rec-1', 'sending');
  IF (v_j2 ->> 'replay')::BOOLEAN OR v_j2 ->> 'history_id' <> v_j ->> 'history_id' THEN RAISE EXCEPTION 'FAIL failed send not retried on the same row: %', v_j2; END IF;
  PERFORM public.complete_company_email(org_a, a_office, (v_j ->> 'send_id')::UUID, 'accepted');
  PERFORM pg_temp.me();
  SELECT count(*) INTO n FROM public.email_history WHERE id = (v_j ->> 'history_id')::UUID AND status = 'sent_via_system' AND sent_at IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL accepted not recorded'; END IF;
  RAISE NOTICE 'PASS a failed send is tried again on the same history row; accepted is recorded as sent_via_system';
  PERFORM pg_temp.be(a_office, s_office, 'aal1');
  v_j2 := public.reserve_company_email(org_a, a_office, v_key, 'c@example.test', 'Invoice 1', 'Body', 'invoice', 'rec-1', 'sending');
  IF NOT (v_j2 ->> 'replay')::BOOLEAN OR v_j2 ->> 'status' <> 'accepted' THEN RAISE EXCEPTION 'FAIL sent e-mail not a replay: %', v_j2; END IF;
  BEGIN
    PERFORM public.complete_company_email(org_a, a_office, (v_j ->> 'send_id')::UUID, 'accepted');
    RAISE EXCEPTION 'FAIL completed twice';
  EXCEPTION WHEN no_data_found THEN RAISE NOTICE 'PASS an accepted e-mail replays as accepted and can''t be completed again';
  END;
  -- A draft (no provider) is reserved too: its retry writes no second draft.
  v_j := public.reserve_company_email(org_a, a_office, v_key2, 'c@example.test', 'Quote 1', 'Body', 'quote', 'rec-2', 'drafted');
  v_j2 := public.reserve_company_email(org_a, a_office, v_key2, 'c@example.test', 'Quote 1', 'Body', 'quote', 'rec-2', 'drafted');
  IF NOT (v_j2 ->> 'replay')::BOOLEAN OR v_j2 ->> 'status' <> 'drafted' THEN RAISE EXCEPTION 'FAIL draft retry: %', v_j2; END IF;
  SELECT count(*) INTO n FROM public.email_history WHERE organization_id = org_a AND related_to_id = 'rec-2' AND status = 'drafted';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL % drafts', n; END IF;
  RAISE NOTICE 'PASS a retried draft writes no second draft';

  -- Who may reserve: not another company's office, not workshop, not a support session, not an aal1 admin (MFA required), not
  -- someone else's user id, not anon; the ledger itself can't be read by anyone signed in.
  FOR r IN SELECT * FROM (VALUES ('other company', b_office, s_b, 'aal1', b_office), ('workshop', a_workshop, s_workshop, 'aal1', a_workshop),
                                 ('support', a_support, s_support, 'aal2', a_support), ('admin aal1', a_admin, s_admin, 'aal1', a_admin),
                                 ('as another person', a_office, s_office, 'aal1', a_admin)) v(label, u, s, aal, claimed) LOOP
    PERFORM pg_temp.be(r.u, r.s, r.aal);
    BEGIN
      PERFORM public.reserve_company_email(org_a, r.claimed, repeat('c', 64), 'c@example.test', 'S', 'B', 'general', NULL, 'sending');
      RAISE EXCEPTION 'FAIL % reserved', r.label;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS % refused', r.label;
    END;
  END LOOP;
  PERFORM pg_temp.be(a_office, s_office, 'aal1');
  BEGIN
    PERFORM count(*) FROM security_audit.company_email_sends;
    RAISE EXCEPTION 'FAIL ledger readable';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS the ledger is not readable by a signed-in user';
  END;
  PERFORM pg_temp.me();
  PERFORM set_config('role', 'anon', true);
  BEGIN
    PERFORM public.reserve_company_email(org_a, NULL, repeat('d', 64), 'c@example.test', 'S', 'B', 'general', NULL, 'sending');
    RAISE EXCEPTION 'FAIL anon reserved';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS anon refused';
  END;
  -- The service role (a schedule): no person; its own company only by parameter.
  PERFORM set_config('role', 'service_role', true);
  v_j := public.reserve_company_email(org_b, NULL, repeat('e', 64), 'c@example.test', 'Reminder', 'B', 'invoice', 'rec-3', 'sending');
  PERFORM public.complete_company_email(org_b, NULL, (v_j ->> 'send_id')::UUID, 'unknown');
  PERFORM pg_temp.me();
  SELECT count(*) INTO n FROM public.email_history WHERE id = (v_j ->> 'history_id')::UUID AND organization_id = org_b AND drafted_by IS NULL AND status = 'unknown';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL service role send not recorded'; END IF;
  RAISE NOTICE 'PASS the service role reserves and completes a system send (no person)';
  -- The company's hourly ceiling (200 sends).
  INSERT INTO security_audit.company_email_sends (organization_id, idempotency_key, history_id, status)
    SELECT org_b, lpad(to_hex(g), 64, 'f'), gen_random_uuid(), 'accepted' FROM generate_series(1, 199) g;
  PERFORM set_config('role', 'service_role', true);
  BEGIN
    PERFORM public.reserve_company_email(org_b, NULL, repeat('9', 64), 'c@example.test', 'S', 'B', 'general', NULL, 'sending');
    RAISE EXCEPTION 'FAIL past the hourly ceiling';
  EXCEPTION WHEN SQLSTATE 'PT429' THEN RAISE NOTICE 'PASS the 201st send in an hour is refused (PT429)';
  END;
  PERFORM pg_temp.me();
END
$$;

ROLLBACK;

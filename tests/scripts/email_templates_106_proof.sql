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
  PERFORM pg_temp.me();
END
$$;

ROLLBACK;

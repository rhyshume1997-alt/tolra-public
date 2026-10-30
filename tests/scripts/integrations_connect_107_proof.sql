-- Migration 107 proof on a throwaway copy of the local stand-in (never production):
--   PGPASSWORD=... psql -h 127.0.0.1 -U postgres -d <copy> -v ON_ERROR_STOP=1 -f tests/scripts/integrations_connect_107_proof.sql
-- Synthetic companies, people and sessions; forged session claims as PostgREST sends them; everything rolled back at the end.
-- Prints one PASS line per check; any failed expectation raises and stops the script.
BEGIN;

CREATE FUNCTION pg_temp.be(p_user UUID, p_session UUID, p_aal TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated', 'aal', p_aal,
    'email', p_user::TEXT || '@example.test', 'session_id', p_session)::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::TEXT, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;
CREATE FUNCTION pg_temp.svc() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('role', 'service_role', true);
END $$;
CREATE FUNCTION pg_temp.me() RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END $$;
CREATE FUNCTION pg_temp.c() RETURNS TEXT LANGUAGE sql AS $$
  SELECT 'v1.' || md5(random()::TEXT) || '.' || md5(random()::TEXT) || '.' || md5(random()::TEXT) || md5(random()::TEXT)
$$;
CREATE FUNCTION pg_temp.h() RETURNS TEXT LANGUAGE sql AS $$ SELECT md5(random()::TEXT) || md5(random()::TEXT) $$;

DO $$
DECLARE
  org_a UUID := gen_random_uuid(); org_b UUID := gen_random_uuid();
  a_admin UUID := gen_random_uuid(); a_office UUID := gen_random_uuid(); b_admin UUID := gen_random_uuid(); owner_u UUID := gen_random_uuid();
  s_admin UUID := gen_random_uuid(); s_office UUID := gen_random_uuid(); s_b UUID := gen_random_uuid(); s_owner UUID := gen_random_uuid();
  a_support UUID := gen_random_uuid(); s_support UUID := gen_random_uuid(); v_grant UUID := gen_random_uuid();
  v_tok TEXT; v_tok2 TEXT; v_tok3 TEXT; v_state TEXT; v_state2 TEXT; v_j JSONB; n INT; v_inv UUID; v_id UUID; r RECORD;
BEGIN
  INSERT INTO public.organizations (id, name, slug, status, require_admin_mfa) VALUES (org_a, '107 alpha', 'zz-107-alpha-' || left(org_a::TEXT, 8), 'active', TRUE),
                                                                                   (org_b, '107 beta', 'zz-107-beta-' || left(org_b::TEXT, 8), 'active', TRUE);
  FOR r IN SELECT * FROM (VALUES (a_admin, s_admin, org_a, 'admin'), (a_office, s_office, org_a, 'office'), (b_admin, s_b, org_b, 'admin')) v(u, s, o, role) LOOP
    INSERT INTO auth.users (id, email) VALUES (r.u, r.u::TEXT || '@example.test');
    INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
      VALUES (r.u, r.u::TEXT || '@example.test', 'Person', r.role, r.o, TRUE, FALSE);
    INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES (r.u, r.o, r.role, TRUE);
    INSERT INTO auth.sessions (id, user_id) VALUES (r.s, r.u);
    INSERT INTO security_audit.session_company (session_id, user_id, organization_id) VALUES (r.s, r.u, r.o);
  END LOOP;
  -- The platform owner (outside any company) and a platform owner's ELEVATED support membership of company A.
  INSERT INTO auth.users (id, email) VALUES (owner_u, owner_u::TEXT || '@example.test');
  INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
    VALUES (owner_u, owner_u::TEXT || '@example.test', 'Owner', 'admin', org_b, TRUE, FALSE);
  INSERT INTO security_audit.platform_admins (user_id) VALUES (owner_u);
  INSERT INTO auth.sessions (id, user_id) VALUES (s_owner, owner_u);
  INSERT INTO auth.users (id, email) VALUES (a_support, a_support::TEXT || '@example.test');
  INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
    VALUES (a_support, a_support::TEXT || '@example.test', 'Tolra Support', 'admin', org_a, TRUE, FALSE);
  INSERT INTO security_audit.platform_admins (user_id) VALUES (a_support);
  INSERT INTO public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant)
    VALUES (a_support, org_a, 'admin', TRUE, TRUE, now() + interval '2 hours', v_grant);
  INSERT INTO auth.sessions (id, user_id) VALUES (s_support, a_support);
  INSERT INTO security_audit.session_company (session_id, user_id, organization_id, grant_id, elevated_until) VALUES (s_support, a_support, org_a, v_grant, now() + interval '30 minutes');

  -- 1. Microsoft 365 Connect: the admin (two-step) starts it; office, password-only and support sessions are refused.
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  v_state := pg_temp.h();
  PERFORM public.integration_oauth_start('microsoft', v_state, pg_temp.c());
  RAISE NOTICE 'PASS admin (aal2) starts a Microsoft 365 Connect';
  BEGIN
    PERFORM public.integration_oauth_start('gmail', pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL unknown provider allowed';
  EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'PASS unknown provider refused';
  END;
  PERFORM pg_temp.be(a_admin, s_admin, 'aal1');
  BEGIN
    PERFORM public.integration_oauth_start('microsoft', pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL password-only admin started a Connect';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS password-only admin refused (two-step)';
  END;
  PERFORM pg_temp.be(a_office, s_office, 'aal2');
  BEGIN
    PERFORM public.integration_oauth_start('microsoft', pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL office started a Connect';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS office refused';
  END;
  PERFORM pg_temp.be(a_support, s_support, 'aal2');
  BEGIN
    PERFORM public.integration_oauth_start('microsoft', pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL elevated support session started a Connect';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS elevated support session refused';
  END;
  BEGIN
    PERFORM public.integration_invite_create('xero', pg_temp.h());
    RAISE EXCEPTION 'FAIL support session created an invite';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS support session cannot create a connect link';
  END;

  -- 2. The callback (server): 084's consume + store work for 'microsoft'; the overview shows it.
  PERFORM pg_temp.svc();
  PERFORM public.integration_oauth_consume(org_a, a_admin, 'microsoft', v_state);
  PERFORM public.integration_store_connection(org_a, a_admin, 'microsoft', 'oid-' || left(a_admin::TEXT, 8), 'office@alpha.example.test', NULL, pg_temp.c(), pg_temp.c(), now() + interval '1 hour', 1);
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  v_j := public.integration_overview('microsoft');
  IF v_j ->> 'status' <> 'connected' OR v_j ->> 'tenant_name' <> 'office@alpha.example.test' THEN RAISE EXCEPTION 'FAIL overview %', v_j; END IF;
  RAISE NOTICE 'PASS Microsoft 365 connected through 084''s consume/store; overview: connected, mailbox shown';

  -- 3. Issuing an invoice in a company connected to Microsoft 365 (and Xero) queues Xero only and never fails.
  PERFORM pg_temp.me();
  INSERT INTO public.integration_connections (organization_id, provider, status, tenant_id, tenant_name, connected_by, connected_at)
    VALUES (org_a, 'xero', 'connected', 'xero-' || left(org_a::TEXT, 8), 'Alpha Ltd', a_admin, now());
  INSERT INTO public.invoices (organization_id, customer, status, subtotal, vat, total, vat_enabled, due_date, invoice_date)
    VALUES (org_a, 'Acme', 'draft', 0, 0, 0, TRUE, '2026-11-30', '2026-10-30') RETURNING id INTO v_inv;
  UPDATE public.invoices SET status = 'issued', invoice_ref = 'INV-107-' || left(v_inv::TEXT, 8), issued_at = now() WHERE id = v_inv;
  SELECT count(*) INTO n FROM public.integration_sends WHERE doc_id = v_inv;
  IF n <> 1 OR EXISTS (SELECT 1 FROM public.integration_sends WHERE doc_id = v_inv AND provider <> 'xero') THEN RAISE EXCEPTION 'FAIL sends after issue: %', n; END IF;
  RAISE NOTICE 'PASS issue with Microsoft 365 + Xero connected: one Xero send row, no Microsoft row, no error';
  INSERT INTO public.integration_sends (organization_id, provider, doc_type, doc_id, action) VALUES (org_a, 'microsoft', 'invoice', gen_random_uuid(), 'create');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL a microsoft send row was stored'; END IF;
  RAISE NOTICE 'PASS a send row for a mail provider is dropped before it is stored';

  -- 4. The accountant's link: created by the admin (aal2), hash only, 24 h; single use; expired refused; another company untouched.
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  v_tok := pg_temp.h();
  v_j := public.integration_invite_create('xero', v_tok);
  IF (v_j ->> 'expires_at')::TIMESTAMPTZ > now() + interval '24 hours' THEN RAISE EXCEPTION 'FAIL expiry %', v_j; END IF;
  RAISE NOTICE 'PASS admin creates a 24-hour Xero connect link';
  BEGIN
    PERFORM public.integration_invite_create('microsoft', pg_temp.h());
    RAISE EXCEPTION 'FAIL microsoft invite allowed';
  EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'PASS a connect link is for Xero only';
  END;
  PERFORM pg_temp.be(a_office, s_office, 'aal2');
  BEGIN
    PERFORM public.integration_invite_create('xero', pg_temp.h());
    RAISE EXCEPTION 'FAIL office created an invite';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS office cannot create a connect link';
  END;
  BEGIN
    PERFORM public.integration_invite_redeem(v_tok, pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL a signed-in user redeemed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS redeem is not callable by signed-in users';
  END;
  BEGIN
    PERFORM count(*) FROM public.integration_connect_invites;
    RAISE EXCEPTION 'FAIL invites readable';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS invites table not readable through the API';
  END;
  -- Opening the link's page (a GET) only peeks: the company's name, nothing used up, however often.
  PERFORM pg_temp.svc();
  FOR n IN 1..3 LOOP
    v_j := public.integration_invite_peek(v_tok);
    IF v_j ->> 'company_name' <> '107 alpha' THEN RAISE EXCEPTION 'FAIL peek %', v_j; END IF;
  END LOOP;
  PERFORM pg_temp.me();
  IF (SELECT used_at FROM public.integration_connect_invites WHERE token_hash = v_tok) IS NOT NULL THEN RAISE EXCEPTION 'FAIL peek used the link up'; END IF;
  RAISE NOTICE 'PASS the link''s page (peek) shows the company and uses nothing up';
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  BEGIN
    PERFORM public.integration_invite_peek(v_tok);
    RAISE EXCEPTION 'FAIL a signed-in user peeked';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS peek is not callable by signed-in users';
  END;
  PERFORM pg_temp.svc();
  v_state2 := pg_temp.h();
  v_j := public.integration_invite_redeem(v_tok, v_state2, pg_temp.c());
  IF (v_j ->> 'organization_id')::UUID <> org_a THEN RAISE EXCEPTION 'FAIL redeem org %', v_j; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.integration_oauth_states WHERE state_hash = v_state2 AND organization_id = org_a AND user_id = a_admin AND via_invite IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL state not bound to the invite''s company and admin';
  END IF;
  RAISE NOTICE 'PASS the link opens once: a 10-minute state bound to company A, its admin, via_invite';
  BEGIN
    PERFORM public.integration_invite_redeem(v_tok, pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL invite used twice';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS the same link a second time is refused (single use)';
  END;
  IF public.integration_invite_peek(v_tok) IS NOT NULL THEN RAISE EXCEPTION 'FAIL a used link still peeks'; END IF;
  -- A normal (session) state is never consumed by the invite callback.
  IF public.integration_oauth_consume_invite('microsoft', v_state) IS NOT NULL THEN RAISE EXCEPTION 'FAIL session state consumed as invite'; END IF;
  v_j := public.integration_oauth_consume_invite('xero', v_state2);
  IF (v_j ->> 'organization_id')::UUID <> org_a OR (v_j ->> 'user_id')::UUID <> a_admin THEN RAISE EXCEPTION 'FAIL consume_invite %', v_j; END IF;
  IF public.integration_oauth_consume_invite('xero', v_state2) IS NOT NULL THEN RAISE EXCEPTION 'FAIL invite state consumed twice'; END IF;
  RAISE NOTICE 'PASS the invite callback consumes its state once; a session state is not an invite state';
  -- Expired link.
  PERFORM pg_temp.me();
  v_tok2 := pg_temp.h();
  INSERT INTO public.integration_connect_invites (organization_id, provider, token_hash, created_by, created_at, expires_at)
    VALUES (org_a, 'xero', v_tok2, a_admin, now() - interval '25 hours', now() - interval '1 hour');
  PERFORM pg_temp.svc();
  BEGIN
    PERFORM public.integration_invite_redeem(v_tok2, pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL expired invite used';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS an expired link is refused';
  END;
  -- A link whose admin is no longer an admin is refused (and stays unused).
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  v_tok2 := pg_temp.h();
  PERFORM public.integration_invite_create('xero', v_tok2);
  PERFORM pg_temp.me();
  UPDATE public.organization_members SET role = 'office' WHERE user_id = a_admin AND organization_id = org_a;
  PERFORM pg_temp.svc();
  BEGIN
    PERFORM public.integration_invite_redeem(v_tok2, pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL invite of a demoted admin used';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS a link made by someone no longer an admin is refused';
  END;
  PERFORM pg_temp.me();
  UPDATE public.organization_members SET role = 'admin' WHERE user_id = a_admin AND organization_id = org_a;
  IF (SELECT used_at FROM public.integration_connect_invites WHERE token_hash = v_tok2) IS NOT NULL THEN RAISE EXCEPTION 'FAIL refused redeem marked used'; END IF;
  -- At most three open links.
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  PERFORM public.integration_invite_create('xero', pg_temp.h());
  PERFORM public.integration_invite_create('xero', pg_temp.h());
  BEGIN
    PERFORM public.integration_invite_create('xero', pg_temp.h());
    RAISE EXCEPTION 'FAIL a fourth open invite';
  EXCEPTION WHEN program_limit_exceeded THEN RAISE NOTICE 'PASS at most three open links per company';
  END;
  -- Cancel: the open list shows them (no token or hash); support and office can't cancel; the admin can; a cancelled link is dead.
  v_j := public.integration_invites_open('xero');
  IF jsonb_array_length(v_j) <> 3 OR v_j::TEXT ~ '[0-9a-f]{64}' THEN RAISE EXCEPTION 'FAIL open list %', v_j; END IF;
  v_id := (v_j -> 0 ->> 'id')::UUID;
  PERFORM pg_temp.be(a_support, s_support, 'aal2');
  BEGIN
    PERFORM public.integration_invite_revoke(v_id);
    RAISE EXCEPTION 'FAIL support cancelled a link';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS support session cannot cancel a link';
  END;
  PERFORM pg_temp.be(a_office, s_office, 'aal2');
  BEGIN
    PERFORM public.integration_invite_revoke(v_id);
    RAISE EXCEPTION 'FAIL office cancelled a link';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS office cannot cancel a link';
  END;
  PERFORM pg_temp.be(a_admin, s_admin, 'aal1');
  BEGIN
    PERFORM public.integration_invite_revoke(v_id);
    RAISE EXCEPTION 'FAIL password-only admin cancelled a link';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS password-only admin cannot cancel a link (two-step)';
  END;
  PERFORM pg_temp.be(b_admin, s_b, 'aal2');
  IF public.integration_invite_revoke(v_id) THEN RAISE EXCEPTION 'FAIL another company cancelled A''s link'; END IF;
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  IF NOT public.integration_invite_revoke(v_id) THEN RAISE EXCEPTION 'FAIL admin cancel'; END IF;
  IF public.integration_invite_revoke(v_id) THEN RAISE EXCEPTION 'FAIL cancelled twice'; END IF;
  IF jsonb_array_length(public.integration_invites_open('xero')) <> 2 THEN RAISE EXCEPTION 'FAIL cancelled link still listed'; END IF;
  PERFORM pg_temp.me();
  SELECT token_hash INTO v_tok3 FROM public.integration_connect_invites WHERE id = v_id;
  PERFORM pg_temp.svc();
  IF public.integration_invite_peek(v_tok3) IS NOT NULL THEN RAISE EXCEPTION 'FAIL cancelled link peeks'; END IF;
  BEGIN
    PERFORM public.integration_invite_redeem(v_tok3, pg_temp.h(), pg_temp.c());
    RAISE EXCEPTION 'FAIL cancelled link used';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS the admin cancels an open link; it no longer opens or counts';
  END;
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  PERFORM public.integration_invite_create('xero', pg_temp.h());
  RAISE NOTICE 'PASS a cancelled link frees its place (three open again)';
  IF EXISTS (SELECT 1 FROM security_audit.audit_log WHERE entity_table = 'integration_connect_invites' AND metadata::TEXT LIKE '%' || v_tok || '%') THEN
    RAISE EXCEPTION 'FAIL token hash in the audit log';
  END IF;
  RAISE NOTICE 'PASS no token hash in the audit log';

  -- 5. App credentials: the platform owner (aal2) saves, lists (last 4 only) and removes; a company admin and a password-only owner can't.
  PERFORM pg_temp.be(owner_u, s_owner, 'aal2');
  PERFORM public.integration_app_credentials_save('microsoft', 'client-123', pg_temp.c(), 'WXYZ', 'https://app.example.test/api/integrations/microsoft/callback', 1);
  v_j := public.integration_app_credentials_list();
  IF jsonb_array_length(v_j) <> 1 OR v_j -> 0 ->> 'client_secret_last4' <> 'WXYZ' OR v_j -> 0 ? 'client_secret_enc' THEN RAISE EXCEPTION 'FAIL list %', v_j; END IF;
  RAISE NOTICE 'PASS platform owner saves the Microsoft app details; the list shows client id and last 4 only';
  PERFORM public.integration_app_credentials_save('microsoft', 'client-456', NULL, NULL, NULL, 1);
  PERFORM pg_temp.me();
  IF (SELECT client_id || '/' || client_secret_last4 FROM public.integration_app_credentials WHERE provider = 'microsoft') <> 'client-456/WXYZ' THEN RAISE EXCEPTION 'FAIL keep secret'; END IF;
  RAISE NOTICE 'PASS saving without a new secret keeps the stored one';
  PERFORM pg_temp.be(owner_u, s_owner, 'aal2');
  BEGIN
    PERFORM public.integration_app_credentials_save('xero', 'client-x', NULL, NULL, NULL, 1);
    RAISE EXCEPTION 'FAIL first save without a secret';
  EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'PASS a first save needs the secret';
  END;
  BEGIN
    PERFORM count(*) FROM public.integration_app_credentials;
    RAISE EXCEPTION 'FAIL app credentials readable by the owner directly';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS app credentials table not readable through the API (even by the owner)';
  END;
  PERFORM pg_temp.be(owner_u, s_owner, 'aal1');
  BEGIN
    PERFORM public.integration_app_credentials_list();
    RAISE EXCEPTION 'FAIL password-only owner listed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS password-only platform owner refused';
  END;
  PERFORM pg_temp.be(b_admin, s_b, 'aal2');
  BEGIN
    PERFORM public.integration_app_credentials_save('xero', 'evil', pg_temp.c(), 'ABCD', NULL, 1);
    RAISE EXCEPTION 'FAIL company admin saved app credentials';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS a company admin cannot set the app details';
  END;
  BEGIN
    PERFORM public.integration_app_credentials_remove('microsoft');
    RAISE EXCEPTION 'FAIL company admin removed app credentials';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS a company admin cannot remove the app details';
  END;
  PERFORM pg_temp.svc();
  IF (SELECT client_id FROM public.integration_app_credentials WHERE provider = 'microsoft') <> 'client-456' THEN RAISE EXCEPTION 'FAIL service read'; END IF;
  RAISE NOTICE 'PASS the server (service role) reads the stored row';
  PERFORM pg_temp.be(owner_u, s_owner, 'aal2');
  IF NOT public.integration_app_credentials_remove('microsoft') THEN RAISE EXCEPTION 'FAIL remove'; END IF;
  IF jsonb_array_length(public.integration_app_credentials_list()) <> 0 THEN RAISE EXCEPTION 'FAIL removed row listed'; END IF;
  RAISE NOTICE 'PASS platform owner removes the app details';
  PERFORM pg_temp.me();
  IF NOT EXISTS (SELECT 1 FROM security_audit.audit_log WHERE action = 'INTEGRATION_APP_CREDENTIALS_SAVED' AND organization_id IS NULL)
     OR EXISTS (SELECT 1 FROM security_audit.audit_log WHERE entity_table = 'integration_app_credentials' AND metadata::TEXT ~ 'v1\.') THEN
    RAISE EXCEPTION 'FAIL app credentials audit';
  END IF;
  RAISE NOTICE 'PASS app credential changes audited at platform level, no ciphertext in the log';

  -- 6. Disconnect Microsoft 365 (through 107's wrapper) deletes its tokens and leaves the Xero links alone.
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  v_j := public.integration_disconnect_revoke('microsoft');
  IF (v_j ->> 'invites_revoked')::INT <> 0 OR jsonb_array_length(public.integration_invites_open('xero')) <> 3 THEN RAISE EXCEPTION 'FAIL microsoft disconnect touched links %', v_j; END IF;
  PERFORM pg_temp.me();
  IF EXISTS (SELECT 1 FROM public.integration_secrets WHERE organization_id = org_a AND provider = 'microsoft') THEN RAISE EXCEPTION 'FAIL tokens kept'; END IF;
  RAISE NOTICE 'PASS disconnecting Microsoft 365 deletes its tokens (Xero links untouched)';
  -- 7. Disconnecting Xero cancels every open Xero link; support can't use the wrapper; 084's disconnect itself still checks admin.
  PERFORM pg_temp.be(a_support, s_support, 'aal2');
  BEGIN
    PERFORM public.integration_disconnect_revoke('xero');
    RAISE EXCEPTION 'FAIL support disconnected';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS support session cannot disconnect';
  END;
  PERFORM pg_temp.be(a_office, s_office, 'aal2');
  BEGIN
    PERFORM public.integration_disconnect_revoke('xero');
    RAISE EXCEPTION 'FAIL office disconnected';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS office cannot disconnect';
  END;
  PERFORM pg_temp.be(a_admin, s_admin, 'aal2');
  v_j := public.integration_disconnect_revoke('xero');
  IF v_j ->> 'status' <> 'disconnected' OR (v_j ->> 'invites_revoked')::INT <> 3 OR jsonb_array_length(public.integration_invites_open('xero')) <> 0 THEN
    RAISE EXCEPTION 'FAIL disconnect revoke %', v_j;
  END IF;
  PERFORM pg_temp.me();
  IF EXISTS (SELECT 1 FROM public.integration_connect_invites WHERE organization_id = org_a AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()) THEN
    RAISE EXCEPTION 'FAIL open links left after disconnect';
  END IF;
  RAISE NOTICE 'PASS disconnecting Xero cancels every open connect link (and disconnects as 084 does)';
END
$$;

ROLLBACK;

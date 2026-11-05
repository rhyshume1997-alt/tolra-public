-- Post-144 release step 151 (PROPOSAL, not registered in supabase/release-plan.json or CI). One-time, one transaction; never part of baseline replay.
-- Canonical source: supabase/proposals/p151_xero_invite_hardening.sql (read its header for what it does and why). Apply only after 107 and 149.
-- Verify: supabase/verify/xero_invite_hardening_151.sql (every row t). Rollback: supabase/release/151_xero_invite_hardening.rollback.sql.
BEGIN;
DO $post_release_guard$ BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'integration_connect_invites' AND column_name = 'ref')
    OR to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') IS NOT NULL THEN
  RAISE EXCEPTION '151: the invite hardening already exists; this one-time release was applied before';
 END IF;
 IF to_regclass('public.integration_connect_invites') IS NULL OR to_regclass('public.integration_oauth_states') IS NULL
    OR to_regprocedure('public.integration_invite_create(text,text)') IS NULL OR to_regprocedure('public.integration_invite_redeem(text,text,text)') IS NULL
    OR to_regprocedure('public.integration_invite_peek(text)') IS NULL OR to_regprocedure('public.integration_oauth_consume_invite(text,text)') IS NULL THEN
  RAISE EXCEPTION '151: release 107 (the token connect link) is not in place; stop and check release preflight';
 END IF;
 IF to_regclass('public.xero_transfer_hold') IS NULL THEN
  RAISE EXCEPTION '151: release 149 (the Xero transfer switch) is missing; apply it first so a connection made through an invite starts with transfers OFF';
 END IF;
 IF to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public._session_membership()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
    OR to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL THEN
  RAISE EXCEPTION '151: the helper functions it builds on are not all in place; stop and check release preflight';
 END IF;
END $post_release_guard$;

-- 151. Xero accountant connect link, hardened (PROPOSAL; not in supabase/migrations, not in release-plan.json, not in CI).
--
-- What 107 did: an admin makes a link whose URL carries a 43-character token; whoever holds the URL can connect the company's Xero.
-- What this does, in one paragraph: the URL carries only an OPAQUE REFERENCE (22 random characters) that grants nothing on its own. The invite is
-- bound at creation to ONE company, the creating admin and ONE recipient e-mail address. To go on, the person opening the link asks for a
-- one-time 8-digit code, which the server e-mails to the BOUND address only (the page never lets the visitor name an address). Only the code's
-- keyed hash (HMAC made by the app) is stored, 15 minutes, five codes per invite, one every 60 seconds, five wrong guesses in the invite's life lock it
-- for good. A correct code uses the invite up and starts the 10-minute OAuth state (state + PKCE are the app's, unchanged). A forwarded link
-- therefore cannot connect: the forwardee cannot read the recipient's mailbox. Every step (created, opened = first code sent, code sent, verified, used,
-- revoked, expired, refused) is an audit row with no ref, no code, no hash and no token in it.
--
-- Not changed here: 084's connection store, 149's transfer switch. Connecting through an invite takes the same 084 path as an admin's own Connect, so
-- 149's connection trigger puts the company's transfers OFF and nothing held is released.
--
-- Old (107) token links are cancelled by this release (audited) and their functions (integration_invite_create(text,text), _redeem, _peek(text with a token
-- hash)) are dropped: the new app code never calls them.

-- 1. The invite row: reference, recipient, code state, reason an invite ended.
ALTER TABLE public.integration_connect_invites
  ADD COLUMN IF NOT EXISTS ref               TEXT,
  ADD COLUMN IF NOT EXISTS recipient_email   TEXT,
  ADD COLUMN IF NOT EXISTS code_hash         TEXT,
  ADD COLUMN IF NOT EXISTS code_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS code_sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS code_sent_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS code_attempts     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_logged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoke_reason     TEXT;
ALTER TABLE public.integration_connect_invites ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE public.integration_connect_invites
  ADD CONSTRAINT integration_connect_invites_ref CHECK (ref IS NULL OR ref ~ '^[A-Za-z0-9_-]{22}$'),
  ADD CONSTRAINT integration_connect_invites_ref_key UNIQUE (ref),
  ADD CONSTRAINT integration_connect_invites_recipient CHECK (recipient_email IS NULL
    OR (length(recipient_email) <= 254 AND recipient_email = lower(recipient_email)
        AND recipient_email ~ '^[^[:space:]@<>(),;:"\[\]\\]+@[^[:space:]@<>(),;:"\[\]\\]+\.[^[:space:]@<>(),;:"\[\]\\]+$')),
  ADD CONSTRAINT integration_connect_invites_code_hash CHECK (code_hash IS NULL OR code_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT integration_connect_invites_bound CHECK (token_hash IS NOT NULL OR (ref IS NOT NULL AND recipient_email IS NOT NULL)),
  ADD CONSTRAINT integration_connect_invites_counts CHECK (code_sent_count >= 0 AND code_attempts >= 0);

-- 2. Cancel every open 107 token link (audited, one row per company's batch). A token link had no recipient; none may be used after this.
DO $cancel_old$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    WITH c AS (
      UPDATE public.integration_connect_invites i SET revoked_at = now(), revoke_reason = 'superseded_151'
      WHERE i.ref IS NULL AND i.used_at IS NULL AND i.revoked_at IS NULL
      RETURNING i.organization_id
    )
    SELECT organization_id, count(*)::INT AS n FROM c GROUP BY organization_id
  LOOP
    PERFORM security_audit.log_named_event(r.organization_id, 'INTEGRATION_INVITE_REVOKED', 'integration_connect_invites', 'xero',
      jsonb_build_object('reason', 'superseded_151', 'count', r.n));
  END LOOP;
END
$cancel_old$;

DROP FUNCTION IF EXISTS public.integration_invite_create(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_redeem(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_peek(TEXT);

-- 3a. Create (signed in: admin, two-step, own company, never support). The server made the random reference (22 chars) and validated the recipient;
-- the database checks both again. At most three open invites per company. Audited with the recipient's masked address only.
CREATE OR REPLACE FUNCTION public.integration_invite_create(p_provider TEXT, p_ref TEXT, p_recipient TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_uid     UUID := auth.uid();
  v_id      UUID;
  v_expires TIMESTAMPTZ;
  v_hint    TEXT;
  r         RECORD;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can send a connect link.' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS DISTINCT FROM 'xero' THEN
    RAISE EXCEPTION 'A connect link is for Xero only.' USING ERRCODE = '22023';
  END IF;
  IF p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9_-]{22}$' THEN
    RAISE EXCEPTION 'Invalid link.' USING ERRCODE = '22023';
  END IF;
  IF p_recipient IS NULL OR p_recipient <> lower(p_recipient) OR length(p_recipient) > 254
     OR p_recipient !~ '^[^[:space:]@<>(),;:"\[\]\\]+@[^[:space:]@<>(),;:"\[\]\\]+\.[^[:space:]@<>(),;:"\[\]\\]+$' THEN
    RAISE EXCEPTION 'Enter the accountant''s e-mail address.' USING ERRCODE = '22023', HINT = 'invalid_recipient';
  END IF;
  -- Invites that ran out unused: audited once, here and when someone opens them.
  FOR r IN
    UPDATE public.integration_connect_invites i SET expired_logged_at = now()
    WHERE i.organization_id = v_org AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at <= now() AND i.expired_logged_at IS NULL
    RETURNING i.id
  LOOP
    PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_INVITE_EXPIRED', 'integration_connect_invites', r.id::TEXT, jsonb_build_object('provider', p_provider));
  END LOOP;
  DELETE FROM public.integration_connect_invites i
  WHERE i.organization_id = v_org AND (i.used_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.expires_at < now()) AND i.created_at < now() - interval '30 days';
  IF (SELECT count(*) FROM public.integration_connect_invites i
      WHERE i.organization_id = v_org AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) >= 3 THEN
    RAISE EXCEPTION 'Three connect links are already open: cancel one, or wait until they expire (24 hours).' USING ERRCODE = '54000', HINT = 'too_many_invites';
  END IF;
  INSERT INTO public.integration_connect_invites (organization_id, provider, ref, recipient_email, created_by, created_at, expires_at)
  VALUES (v_org, p_provider, p_ref, p_recipient, v_uid, now(), now() + interval '24 hours')
  RETURNING id, expires_at INTO v_id, v_expires;
  v_hint := left(split_part(p_recipient, '@', 1), 1) || '***@' || split_part(p_recipient, '@', 2);
  PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_INVITE_CREATED', 'integration_connect_invites', v_id::TEXT,
    jsonb_build_object('provider', p_provider, 'expires_at', v_expires, 'by', v_uid, 'recipient', v_hint));
  RETURN jsonb_build_object('id', v_id, 'provider', p_provider, 'expires_at', v_expires, 'recipient', v_hint);
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_create(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_invite_create(TEXT, TEXT, TEXT) TO authenticated;

-- 3b. The link's page (server only, no Tolra session): an open invite's company name and the MASKED recipient. Nothing is used up and nothing is sent.
-- NULL for anything but an open invite whose admin is still an active, non-support admin of the active company.
CREATE OR REPLACE FUNCTION public.integration_invite_peek(p_ref TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9_-]{22}$' THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT jsonb_build_object('provider', i.provider, 'company_name', o.name, 'expires_at', i.expires_at,
                                    'recipient_hint', left(split_part(i.recipient_email, '@', 1), 1) || '***@' || split_part(i.recipient_email, '@', 2))
          FROM public.integration_connect_invites i JOIN public.organizations o ON o.id = i.organization_id
          WHERE i.ref = p_ref AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.locked_at IS NULL AND i.expires_at > now() AND o.status = 'active'
            AND EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.organization_id = i.organization_id AND m.user_id = i.created_by AND m.active AND NOT m.support
                          AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))));
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_peek(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_invite_peek(TEXT) TO service_role;

-- 3c. "E-mail me a code" (server only): the invite is locked for the call (two at once, one wins). If it is open, its admin still an admin, fewer than
-- five codes were sent and the last one is over 60 seconds old, the code's keyed hash (made by the app, never the code itself) is kept for 15 minutes
-- and the BOUND recipient address is returned so the app can e-mail the code there. Answers are JSON (never an exception, so the audit row of a refusal
-- is kept): {ok:false, reason: invalid | too_many_codes | wait} or {ok:true, recipient, company_name, organization_id, sent_number}.
-- A reference that matches no invite is answered "invalid" with no audit row (nothing to attribute it to; the app's per-IP limit applies).
CREATE OR REPLACE FUNCTION public.integration_invite_code_issue(p_ref TEXT, p_code_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v RECORD;
  v_first BOOLEAN;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid request.' USING ERRCODE = '22023';
  END IF;
  IF p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9_-]{22}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  SELECT i.id, i.organization_id, i.provider, i.created_by, i.recipient_email, i.expires_at, i.used_at, i.revoked_at, i.locked_at, i.expired_logged_at,
         i.code_sent_at, i.code_sent_count, o.name AS company_name, o.status AS company_status
    INTO v
  FROM public.integration_connect_invites i JOIN public.organizations o ON o.id = i.organization_id
  WHERE i.ref = p_ref FOR UPDATE OF i;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  IF v.used_at IS NOT NULL OR v.revoked_at IS NOT NULL OR v.locked_at IS NOT NULL THEN
    PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_REFUSED', 'integration_connect_invites', v.id::TEXT,
      jsonb_build_object('step', 'code', 'reason', CASE WHEN v.used_at IS NOT NULL THEN 'used' WHEN v.locked_at IS NOT NULL THEN 'locked' ELSE 'revoked' END));
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  IF v.expires_at <= now() THEN
    IF v.expired_logged_at IS NULL THEN
      UPDATE public.integration_connect_invites SET expired_logged_at = now() WHERE id = v.id;
      PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_EXPIRED', 'integration_connect_invites', v.id::TEXT, jsonb_build_object('provider', v.provider));
    END IF;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  IF v.company_status <> 'active' OR NOT EXISTS (SELECT 1 FROM public.organization_members m
       WHERE m.organization_id = v.organization_id AND m.user_id = v.created_by AND m.active AND NOT m.support AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))) THEN
    UPDATE public.integration_connect_invites SET revoked_at = now(), revoke_reason = 'creator_not_admin' WHERE id = v.id;
    PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_REFUSED', 'integration_connect_invites', v.id::TEXT,
      jsonb_build_object('step', 'code', 'reason', 'creator_not_admin'));
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  IF v.code_sent_count >= 5 THEN
    PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_REFUSED', 'integration_connect_invites', v.id::TEXT,
      jsonb_build_object('step', 'code', 'reason', 'too_many_codes'));
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'too_many_codes');
  END IF;
  IF v.code_sent_at IS NOT NULL AND v.code_sent_at > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'wait');
  END IF;
  v_first := v.code_sent_count = 0;
  UPDATE public.integration_connect_invites
  SET code_hash = p_code_hash, code_expires_at = now() + interval '15 minutes', code_sent_at = now(), code_sent_count = code_sent_count + 1
  WHERE id = v.id;
  IF v_first THEN
    PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_OPENED', 'integration_connect_invites', v.id::TEXT, jsonb_build_object('provider', v.provider));
  END IF;
  PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_CODE_ISSUED', 'integration_connect_invites', v.id::TEXT,
    jsonb_build_object('provider', v.provider, 'sent_number', v.code_sent_count + 1));
  RETURN jsonb_build_object('ok', TRUE, 'recipient', v.recipient_email, 'company_name', v.company_name, 'organization_id', v.organization_id, 'sent_number', v.code_sent_count + 1);
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_code_issue(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_invite_code_issue(TEXT, TEXT) TO service_role;

-- 3d. The code is typed (server only): the invite is locked for the call. Open, its admin still an active non-support admin of the active company, a code
-- issued and not over 15 minutes old, and the keyed hash equal. A wrong code counts: the fifth wrong code in the invite's life locks and cancels it.
-- Correct: the invite is used up (once) and a 10-minute OAuth state bound to that company, that admin and the invite is kept (as 107's redeem did).
-- Answers are JSON: {ok:false, reason: invalid | code_expired | wrong_code (attempts_left) | locked} or {ok:true, organization_id, provider}.
CREATE OR REPLACE FUNCTION public.integration_invite_code_verify(p_ref TEXT, p_code_hash TEXT, p_state_hash TEXT, p_verifier_enc TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v RECORD;
  v_attempts INTEGER;
BEGIN
  IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid request.' USING ERRCODE = '22023';
  END IF;
  IF p_ref IS NULL OR p_ref !~ '^[A-Za-z0-9_-]{22}$' THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  SELECT i.id, i.organization_id, i.provider, i.created_by, i.expires_at, i.used_at, i.revoked_at, i.locked_at, i.expired_logged_at,
         i.code_hash, i.code_expires_at, i.code_attempts, o.status AS company_status
    INTO v
  FROM public.integration_connect_invites i JOIN public.organizations o ON o.id = i.organization_id
  WHERE i.ref = p_ref FOR UPDATE OF i;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  IF v.used_at IS NOT NULL OR v.revoked_at IS NOT NULL OR v.locked_at IS NOT NULL THEN
    PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_REFUSED', 'integration_connect_invites', v.id::TEXT,
      jsonb_build_object('step', 'verify', 'reason', CASE WHEN v.used_at IS NOT NULL THEN 'used' WHEN v.locked_at IS NOT NULL THEN 'locked' ELSE 'revoked' END));
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  IF v.expires_at <= now() THEN
    IF v.expired_logged_at IS NULL THEN
      UPDATE public.integration_connect_invites SET expired_logged_at = now() WHERE id = v.id;
      PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_EXPIRED', 'integration_connect_invites', v.id::TEXT, jsonb_build_object('provider', v.provider));
    END IF;
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  IF v.company_status <> 'active' OR NOT EXISTS (SELECT 1 FROM public.organization_members m
       WHERE m.organization_id = v.organization_id AND m.user_id = v.created_by AND m.active AND NOT m.support AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))) THEN
    UPDATE public.integration_connect_invites SET revoked_at = now(), revoke_reason = 'creator_not_admin', code_hash = NULL WHERE id = v.id;
    PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_REFUSED', 'integration_connect_invites', v.id::TEXT,
      jsonb_build_object('step', 'verify', 'reason', 'creator_not_admin'));
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'invalid');
  END IF;
  IF v.code_hash IS NULL OR v.code_expires_at IS NULL OR v.code_expires_at <= now() THEN
    PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_REFUSED', 'integration_connect_invites', v.id::TEXT,
      jsonb_build_object('step', 'verify', 'reason', 'code_expired'));
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'code_expired');
  END IF;
  IF v.code_hash <> p_code_hash THEN
    v_attempts := v.code_attempts + 1;
    IF v_attempts >= 5 THEN
      UPDATE public.integration_connect_invites SET code_attempts = v_attempts, locked_at = now(), revoked_at = now(), revoke_reason = 'locked', code_hash = NULL WHERE id = v.id;
      PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_REFUSED', 'integration_connect_invites', v.id::TEXT,
        jsonb_build_object('step', 'verify', 'reason', 'locked', 'attempts', v_attempts));
      RETURN jsonb_build_object('ok', FALSE, 'reason', 'locked');
    END IF;
    UPDATE public.integration_connect_invites SET code_attempts = v_attempts WHERE id = v.id;
    PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_REFUSED', 'integration_connect_invites', v.id::TEXT,
      jsonb_build_object('step', 'verify', 'reason', 'wrong_code', 'attempts', v_attempts));
    RETURN jsonb_build_object('ok', FALSE, 'reason', 'wrong_code', 'attempts_left', 5 - v_attempts);
  END IF;
  UPDATE public.integration_connect_invites SET used_at = now(), code_hash = NULL WHERE id = v.id;
  INSERT INTO public.integration_oauth_states (organization_id, provider, user_id, state_hash, verifier_enc, expires_at, via_invite)
  VALUES (v.organization_id, v.provider, v.created_by, p_state_hash, p_verifier_enc, now() + interval '10 minutes', v.id);
  PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_VERIFIED', 'integration_connect_invites', v.id::TEXT, jsonb_build_object('provider', v.provider));
  PERFORM security_audit.log_named_event(v.organization_id, 'INTEGRATION_INVITE_USED', 'integration_connect_invites', v.id::TEXT,
    jsonb_build_object('provider', v.provider, 'invited_by', v.created_by));
  RETURN jsonb_build_object('ok', TRUE, 'organization_id', v.organization_id, 'provider', v.provider);
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_code_verify(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_invite_code_verify(TEXT, TEXT, TEXT, TEXT) TO service_role;

-- 3e. The open invites (signed in: admin, own company): when each was made, by whom, to which address, until when. Never the reference, a code or a hash.
CREATE OR REPLACE FUNCTION public.integration_invites_open(p_provider TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR auth.uid() IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can see the company''s connect links.' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'created_at', i.created_at, 'expires_at', i.expires_at, 'recipient', i.recipient_email,
                                                       'created_by_name', coalesce(nullif(btrim(p.full_name), ''), p.email)) ORDER BY i.created_at), '[]'::JSONB)
          FROM public.integration_connect_invites i LEFT JOIN public.user_profiles p ON p.id = i.created_by
          WHERE i.organization_id = v_org AND i.provider = p_provider AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.locked_at IS NULL AND i.expires_at > now());
END
$$;
REVOKE ALL ON FUNCTION public.integration_invites_open(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_invites_open(TEXT) TO authenticated;

-- 3f. Cancel one open invite (signed in: admin, two-step, own company, never support). FALSE when it is not open. Audited. Same as 107, plus the reason kept.
CREATE OR REPLACE FUNCTION public.integration_invite_revoke(p_invite UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_uid UUID := auth.uid();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can cancel a connect link.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.integration_connect_invites i SET revoked_at = now(), revoked_by = v_uid, revoke_reason = 'cancelled', code_hash = NULL
  WHERE i.id = p_invite AND i.organization_id = v_org AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now();
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_INVITE_REVOKED', 'integration_connect_invites', p_invite::TEXT,
    jsonb_build_object('by', v_uid, 'reason', 'cancelled'));
  RETURN TRUE;
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_revoke(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_invite_revoke(UUID) TO authenticated;

-- Self-check: stop (and roll everything back) unless the end state is exactly what this release promises.
DO $self_check$
DECLARE
  v_fn TEXT;
BEGIN
  IF to_regprocedure('public.integration_invite_create(text,text)') IS NOT NULL OR to_regprocedure('public.integration_invite_redeem(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION '151 self-check: a 107 token function is still present';
  END IF;
  IF EXISTS (SELECT 1 FROM public.integration_connect_invites i WHERE i.ref IS NULL AND i.used_at IS NULL AND i.revoked_at IS NULL) THEN
    RAISE EXCEPTION '151 self-check: an open token invite remains';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.integration_invite_peek(text)', 'public.integration_invite_code_issue(text,text)', 'public.integration_invite_code_verify(text,text,text,text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = to_regprocedure(v_fn) AND a.grantee = 0) THEN
      RAISE EXCEPTION '151 self-check: % must be callable by the service role only', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.integration_invite_create(text,text,text)', 'public.integration_invites_open(text)', 'public.integration_invite_revoke(uuid)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = to_regprocedure(v_fn) AND a.grantee = 0) THEN
      RAISE EXCEPTION '151 self-check: % has the wrong grants', v_fn;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.integration_connect_invites', 'SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated', 'public.integration_connect_invites', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION '151 self-check: the invite table must not be readable through the API';
  END IF;
END $self_check$;
COMMIT;

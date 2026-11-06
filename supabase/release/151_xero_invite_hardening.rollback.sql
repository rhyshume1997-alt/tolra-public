-- Rollback of post-144 release 151 (Xero connect link hardening). One transaction. Restores 107's token link functions (copied from release 107) and table shape.
-- Invites made under 151 (reference + recipient, no token) cannot work under 107's code: they are DELETED here (their audit rows stay). Refuses while a
-- 151 invite is still OPEN, unless the runner first does: SET tolra.x151_accept_deleting_open_invites = 'yes'.
BEGIN;
-- Freeze new exchanges and completions while the rollback guard inspects pending consents.
LOCK TABLE public.integration_connect_invites, public.integration_oauth_states IN SHARE ROW EXCLUSIVE MODE;
DO $rollback_guard$ BEGIN
 IF to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') IS NULL THEN
  RAISE EXCEPTION '151 rollback: release 151 is not installed';
 END IF;
 IF EXISTS (SELECT 1 FROM public.integration_connect_invites i WHERE i.ref IS NOT NULL AND i.revoked_at IS NULL AND i.expires_at > clock_timestamp()
     AND (i.used_at IS NULL OR EXISTS (SELECT 1 FROM public.integration_oauth_states s WHERE s.via_invite=i.id
       AND s.invite_completed_at IS NULL AND s.expires_at > clock_timestamp())))
    AND coalesce(current_setting('tolra.x151_accept_deleting_open_invites', true), '') <> 'yes' THEN
  RAISE EXCEPTION '151 rollback: open connect invites exist; cancel them first, or SET tolra.x151_accept_deleting_open_invites = ''yes'' to delete them';
 END IF;
END $rollback_guard$;
DELETE FROM public.integration_connect_invites WHERE token_hash IS NULL;
DROP FUNCTION IF EXISTS public.integration_xero_picker_claim(TEXT, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.integration_invite_store_connection(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER);
ALTER TABLE public.integration_oauth_states DROP COLUMN IF EXISTS invite_completed_at;
DROP FUNCTION IF EXISTS public.integration_invite_refusal_log(TEXT, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS security_audit.integration_invite_refuse(TEXT, TEXT, TEXT, UUID, UUID);
DROP TABLE IF EXISTS security_audit.integration_invite_refusals;
DROP FUNCTION IF EXISTS public.integration_invite_code_verify(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_code_issue(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_peek(TEXT);
DROP FUNCTION IF EXISTS public.integration_invite_create(TEXT, TEXT, TEXT);
ALTER TABLE public.integration_connect_invites
  DROP CONSTRAINT IF EXISTS integration_connect_invites_counts, DROP CONSTRAINT IF EXISTS integration_connect_invites_bound,
  DROP CONSTRAINT IF EXISTS integration_connect_invites_code_hash, DROP CONSTRAINT IF EXISTS integration_connect_invites_recipient,
  DROP CONSTRAINT IF EXISTS integration_connect_invites_ref_key, DROP CONSTRAINT IF EXISTS integration_connect_invites_ref;
ALTER TABLE public.integration_connect_invites
  DROP COLUMN IF EXISTS revoke_reason, DROP COLUMN IF EXISTS expired_logged_at, DROP COLUMN IF EXISTS locked_at, DROP COLUMN IF EXISTS code_attempts,
  DROP COLUMN IF EXISTS code_sent_count, DROP COLUMN IF EXISTS code_sent_at, DROP COLUMN IF EXISTS code_expires_at, DROP COLUMN IF EXISTS code_hash,
  DROP COLUMN IF EXISTS recipient_email, DROP COLUMN IF EXISTS ref;
ALTER TABLE public.integration_connect_invites ALTER COLUMN token_hash SET NOT NULL;

-- 107's functions, byte for byte from supabase/release/107_integrations_connect.release.sql (the refusal log table is dropped with its data: it is a security log of
-- refused requests only; export it first if it is needed).
-- 4b. The accountant's link (signed in: admin, two-step, own company, never support). The server made the random token; this keeps
-- its SHA-256 for 24 hours. At most three open links per company. Audited (no token, no hash).
CREATE OR REPLACE FUNCTION public.integration_invite_create(p_provider TEXT, p_token_hash TEXT)
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
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can send a connect link.' USING ERRCODE = '42501';
  END IF;
  IF p_provider IS DISTINCT FROM 'xero' THEN
    RAISE EXCEPTION 'A connect link is for Xero only.' USING ERRCODE = '22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid link.' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.integration_connect_invites i
  WHERE i.organization_id = v_org AND (i.used_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.expires_at < now()) AND i.created_at < now() - interval '30 days';
  IF (SELECT count(*) FROM public.integration_connect_invites i
      WHERE i.organization_id = v_org AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) >= 3 THEN
    RAISE EXCEPTION 'Three connect links are already open: cancel one, or wait until they expire (24 hours).' USING ERRCODE = '54000', HINT = 'too_many_invites';
  END IF;
  INSERT INTO public.integration_connect_invites (organization_id, provider, token_hash, created_by, created_at, expires_at)
  VALUES (v_org, p_provider, p_token_hash, v_uid, now(), now() + interval '24 hours')
  RETURNING id, expires_at INTO v_id, v_expires;
  PERFORM security_audit.log_named_event(v_org, 'INTEGRATION_INVITE_CREATED', 'integration_connect_invites', v_id::TEXT,
    jsonb_build_object('provider', p_provider, 'expires_at', v_expires, 'by', v_uid));
  RETURN jsonb_build_object('id', v_id, 'provider', p_provider, 'expires_at', v_expires);
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_create(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_invite_create(TEXT, TEXT) TO authenticated;

-- 4c. The link is opened (server only, no Tolra session): an unused, unexpired invite is used up (row lock: two opens at once, one
-- wins), the admin who made it must still be an active, non-support admin of the active company, and a 10-minute OAuth state bound to
-- that company and admin (via_invite) is kept. Returns the company and provider. The invite grants nothing else.
CREATE OR REPLACE FUNCTION public.integration_invite_redeem(p_token_hash TEXT, p_state_hash TEXT, p_verifier_enc TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_inv RECORD;
BEGIN
  UPDATE public.integration_connect_invites i SET used_at = now()
  WHERE i.token_hash = p_token_hash AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  RETURNING i.id, i.organization_id, i.provider, i.created_by INTO v_inv;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'This connect link has expired or was already used: ask for a new one.' USING ERRCODE = '42501', HINT = 'invite_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
                 WHERE m.organization_id = v_inv.organization_id AND m.user_id = v_inv.created_by AND m.active AND NOT m.support
                   AND o.status = 'active' AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))) THEN
    RAISE EXCEPTION 'This connect link is no longer valid: ask for a new one.' USING ERRCODE = '42501', HINT = 'invite_invalid';
  END IF;
  INSERT INTO public.integration_oauth_states (organization_id, provider, user_id, state_hash, verifier_enc, expires_at, via_invite)
  VALUES (v_inv.organization_id, v_inv.provider, v_inv.created_by, p_state_hash, p_verifier_enc, now() + interval '10 minutes', v_inv.id);
  PERFORM security_audit.log_named_event(v_inv.organization_id, 'INTEGRATION_INVITE_USED', 'integration_connect_invites', v_inv.id::TEXT,
    jsonb_build_object('provider', v_inv.provider, 'invited_by', v_inv.created_by));
  RETURN jsonb_build_object('organization_id', v_inv.organization_id, 'provider', v_inv.provider);
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_redeem(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_invite_redeem(TEXT, TEXT, TEXT) TO service_role;

-- 4c'. The link's page (server only, no Tolra session): an open link's company name, so the page can say what it connects. Nothing is
-- used up (a GET by a mail scanner or a chat preview must not burn the link). NULL for anything but an open link whose admin is still
-- an active, non-support admin of the active company.
CREATE OR REPLACE FUNCTION public.integration_invite_peek(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN (SELECT jsonb_build_object('provider', i.provider, 'company_name', o.name, 'expires_at', i.expires_at)
          FROM public.integration_connect_invites i JOIN public.organizations o ON o.id = i.organization_id
          WHERE i.token_hash = p_token_hash AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND o.status = 'active'
            AND EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.organization_id = i.organization_id AND m.user_id = i.created_by AND m.active AND NOT m.support
                          AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))));
END
$$;
REVOKE ALL ON FUNCTION public.integration_invite_peek(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_invite_peek(TEXT) TO service_role;

-- 4c''. The open links (signed in: admin, own company): when each was made, by whom, until when. Never the token or its hash.
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
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'created_at', i.created_at, 'expires_at', i.expires_at,
                                                       'created_by_name', coalesce(nullif(btrim(p.full_name), ''), p.email)) ORDER BY i.created_at), '[]'::JSONB)
          FROM public.integration_connect_invites i LEFT JOIN public.user_profiles p ON p.id = i.created_by
          WHERE i.organization_id = v_org AND i.provider = p_provider AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now());
END
$$;
REVOKE ALL ON FUNCTION public.integration_invites_open(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.integration_invites_open(TEXT) TO authenticated;

-- 4c'''. Cancel one open link (signed in: admin, two-step, own company, never support). FALSE when it is not open (used, expired,
-- cancelled, or not this company's). Audited.
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
  UPDATE public.integration_connect_invites i SET revoked_at = now(), revoked_by = v_uid
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

-- 4d. The callback for a state an invite started (server only): unexpired, unused, started from an invite; used up. Returns the
-- company, the admin who made the invite and the encrypted verifier. NULL when no such state exists (nothing is used up then).
CREATE OR REPLACE FUNCTION public.integration_oauth_consume_invite(p_provider TEXT, p_state_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_out JSONB;
BEGIN
  UPDATE public.integration_oauth_states s SET consumed_at = now()
  WHERE s.state_hash = p_state_hash AND s.provider = p_provider AND s.via_invite IS NOT NULL
    AND s.consumed_at IS NULL AND s.expires_at > now()
  RETURNING jsonb_build_object('organization_id', s.organization_id, 'user_id', s.user_id, 'verifier_enc', s.verifier_enc) INTO v_out;
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.integration_oauth_consume_invite(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.integration_oauth_consume_invite(TEXT, TEXT) TO service_role;

COMMIT;

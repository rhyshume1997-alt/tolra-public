-- =====================================================================================================
-- 129: "Invite your accountant" (C3; Rhys and ChatGPT, Sun 1 Nov). An expiring, single-use invite that makes the accountant a VIEWER of one
-- company. It REUSES the existing invite mechanism of 007 (public.organization_invites, read by the on_auth_user_created_apply_invite
-- trigger) and extends it as little as possible.
-- Before: an invite (organization_id, email, role, created_at) is written only by the service-role add_member()/create_organization(),
-- has no expiry, no token, no single use and no revoke, and the trigger turns every invite of an e-mail into a membership at sign-up.
-- After:
--   a. organization_invites gains expires_at, token_hash, used_at, revoked_at and created_by, ALL NULLABLE. An ordinary invite (every
--      existing row, and every row add_member() and create_organization() write) has all five NULL and behaves exactly as before. An
--      accountant invite has a token_hash (the SHA-256 of a random token the server made; the token itself is never stored), the role
--      viewer and an expiry (a CHECK holds both shapes). One per company and e-mail, as before (the existing unique index).
--   b. create_accountant_invite(email, token_hash): an admin of the CURRENT company only, with the second sign-in step done (aal2, always),
--      never a support session. Role is always viewer; it expires 7 days later. An e-mail that is already a member here, or that has an
--      ordinary invite here, is refused. Inviting the same e-mail again replaces its accountant invite (the old link stops working).
--   c. redeem_accountant_invite(token_hash): the signed-in person whose login e-mail is the invite's. Once only; refused when expired,
--      revoked, already used, or for another e-mail. The login gets a viewer membership of the invite's company. An existing member
--      keeps their role and access exactly as they are (never raised, never changed); a switched-off membership is refused, not revived.
--   d. revoke_accountant_invite(invite): an admin of the current company (the company's two-step rule applies), never a support session.
--   e. accountant_invite_peek(token_hash) (server only): the company's name and the invite's e-mail for an open invite, nothing used up.
--   f. handle_new_auth_user (the sign-up trigger) skips accountant invites that are expired, revoked or used. A valid one becomes a VIEWER
--      membership and is marked used (kept, not deleted). Ordinary invites: exactly as before (membership with the invite's role, the
--      invite deleted).
--   g. Signed-in admins read their company's invites as before (same policy), but no longer the token_hash column (column grant).
-- AUDIT: named events ACCOUNTANT_INVITE_CREATED, ACCOUNTANT_INVITE_USED (redeem, or sign-up through the trigger) and
-- ACCOUNTANT_INVITE_REVOKED on the company's log (entity organization_invites). Never a token or its hash.
-- Needs 000, 007 (organization_invites, _ensure_member, handle_new_auth_user), 033 (assert_privileged_aal), 035 (log_named_event),
-- 036 (_session_membership, current_user_organization_id, has_org_role) and 084 (integration_connections, read by the peek).
-- Replaces one existing function: public.handle_new_auth_user (007's body is guarded below and given back by the rollback).
-- Verify: supabase/verify/accountant_invite_129.sql (every row TRUE). Rollback: supabase/release/129_accountant_invite.rollback.sql.
-- Safe to run again.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what this file builds on exists, and the sign-up trigger is 007's (or this file's, when run again).
DO $$
DECLARE
  v_body TEXT;
BEGIN
  IF to_regclass('public.organization_invites') IS NULL OR to_regclass('public.organization_members') IS NULL
     OR to_regclass('public.integration_connections') IS NULL
     OR to_regprocedure('public._ensure_member(uuid,text,uuid,text)') IS NULL
     OR to_regprocedure('public.handle_new_auth_user()') IS NULL
     OR to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public._session_membership()') IS NULL
     OR to_regprocedure('public.current_user_organization_id()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '129 needs 000, 007, 033, 035, 036 and 084 (organization_invites, _ensure_member, the helpers and integration_connections)';
  END IF;
  SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) INTO v_body FROM pg_proc WHERE oid = to_regprocedure('public.handle_new_auth_user()');
  IF v_body IS DISTINCT FROM '06b94b76c311ed711fbecbce0da0580b' AND NOT EXISTS (
       SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('public.handle_new_auth_user()') AND position('ACCOUNTANT_INVITE_USED' IN prosrc) > 0) THEN
    RAISE EXCEPTION '129: public.handle_new_auth_user is not 007''s body (%): stop and report', v_body;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The five columns, all nullable: existing rows and add_member()/create_organization() rows keep them NULL.
ALTER TABLE public.organization_invites
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS token_hash TEXT,
  ADD COLUMN IF NOT EXISTS used_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- An ordinary invite has none of the five; an accountant invite has a 64-hex hash, the role viewer and an expiry.
ALTER TABLE public.organization_invites DROP CONSTRAINT IF EXISTS organization_invites_accountant_shape;
ALTER TABLE public.organization_invites ADD CONSTRAINT organization_invites_accountant_shape CHECK (
  (token_hash IS NULL AND expires_at IS NULL AND used_at IS NULL AND revoked_at IS NULL)
  OR (token_hash ~ '^[0-9a-f]{64}$' AND role = 'viewer' AND expires_at IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS organization_invites_token_hash_uniq ON public.organization_invites (token_hash) WHERE token_hash IS NOT NULL;

-- Same policy as 007 (admins of the company read its invites). Tighter: the token hash is never readable through the API.
REVOKE SELECT ON public.organization_invites FROM authenticated;
GRANT SELECT (id, organization_id, email, role, created_at, expires_at, used_at, revoked_at, created_by) ON public.organization_invites TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. Create (signed in): admin of the current company, aal2, never support. Returns the invite's id, e-mail, role and expiry.
-- Refused: 42501 (not an admin here, support, no second step: HINT mfa_required), 22023 (bad e-mail or hash), 23505 (already a member
-- here: HINT already_member; an ordinary invite is waiting: HINT already_invited).
CREATE OR REPLACE FUNCTION public.create_accountant_invite(p_email TEXT, p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_uid      UUID := auth.uid();
  v_email    TEXT := lower(btrim(p_email));
  v_prev_id   UUID;
  v_prev_hash TEXT;
  v_id       UUID;
  v_expires  TIMESTAMPTZ := now() + interval '7 days';
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can invite an accountant.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN
    RAISE EXCEPTION 'Confirm your authenticator code first (second step of sign-in).' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF v_email IS NULL OR length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Enter the accountant''s e-mail address.' USING ERRCODE = '22023';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid invite.' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('accountant_invite:' || v_org::TEXT || ':' || v_email, 0));
  IF EXISTS (SELECT 1 FROM auth.users u JOIN public.organization_members m ON m.user_id = u.id
             WHERE lower(u.email) = v_email AND m.organization_id = v_org) THEN
    RAISE EXCEPTION 'That e-mail already has a login in this company: change their access in Settings > Users.' USING ERRCODE = '23505', HINT = 'already_member';
  END IF;
  SELECT i.id, i.token_hash INTO v_prev_id, v_prev_hash FROM public.organization_invites i
  WHERE i.organization_id = v_org AND lower(i.email) = v_email FOR UPDATE;
  IF v_prev_id IS NOT NULL AND v_prev_hash IS NULL THEN
    RAISE EXCEPTION 'That e-mail already has an invite to this company.' USING ERRCODE = '23505', HINT = 'already_invited';
  END IF;
  IF v_prev_id IS NOT NULL THEN
    -- Inviting again: the same row, a new token and expiry; the old link stops working at once.
    UPDATE public.organization_invites
    SET token_hash = p_token_hash, expires_at = v_expires, created_by = v_uid, created_at = now(), used_at = NULL, revoked_at = NULL, role = 'viewer'
    WHERE id = v_prev_id
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.organization_invites (organization_id, email, role, created_at, expires_at, token_hash, created_by)
    VALUES (v_org, v_email, 'viewer', now(), v_expires, p_token_hash, v_uid)
    RETURNING id INTO v_id;
  END IF;
  PERFORM security_audit.log_named_event(v_org, 'ACCOUNTANT_INVITE_CREATED', 'organization_invites', v_id::TEXT,
    jsonb_build_object('email', v_email, 'role', 'viewer', 'expires_at', v_expires, 'replaced', v_prev_id IS NOT NULL));
  RETURN jsonb_build_object('id', v_id, 'email', v_email, 'role', 'viewer', 'expires_at', v_expires);
END
$$;
REVOKE ALL ON FUNCTION public.create_accountant_invite(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_accountant_invite(TEXT, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. Redeem (signed in): the person whose login e-mail is the invite's, once, before it expires or is revoked. Returns the status
-- ('joined' or 'already_member'), the company and its name. Refused (42501): invite_invalid (unknown, used, revoked, expired, company
-- not active), invite_other_email, membership_inactive (a switched-off membership is never revived here); mfa_required as everywhere.
CREATE OR REPLACE FUNCTION public.redeem_accountant_invite(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_email  TEXT;
  v_inv    RECORD;
  v_member RECORD;
  v_name   TEXT;
  v_added  UUID;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in first.' USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'This invite can''t be used: ask for a new one.' USING ERRCODE = '42501', HINT = 'invite_invalid';
  END IF;
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_uid;
  SELECT i.id, i.organization_id, lower(i.email) AS email INTO v_inv FROM public.organization_invites i JOIN public.organizations o ON o.id = i.organization_id
  WHERE i.token_hash = p_token_hash AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND o.status = 'active'
  FOR UPDATE OF i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This invite has expired, was cancelled or was already used: ask for a new one.' USING ERRCODE = '42501', HINT = 'invite_invalid';
  END IF;
  IF v_email IS NULL OR v_email <> v_inv.email THEN
    RAISE EXCEPTION 'This invite is for another e-mail address. Sign in with that one, or ask for an invite to yours.' USING ERRCODE = '42501', HINT = 'invite_other_email';
  END IF;
  SELECT m.active INTO v_member FROM public.organization_members m WHERE m.user_id = v_uid AND m.organization_id = v_inv.organization_id;
  IF FOUND AND NOT v_member.active THEN
    RAISE EXCEPTION 'Your access to this company was switched off. Ask its admin to turn it back on.' USING ERRCODE = '42501', HINT = 'membership_inactive';
  END IF;
  IF NOT FOUND THEN
    -- A new membership, viewer only. ON CONFLICT DO NOTHING: a membership made at the same moment is never changed.
    INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES (v_uid, v_inv.organization_id, 'viewer', TRUE)
    ON CONFLICT (user_id, organization_id) DO NOTHING
    RETURNING user_id INTO v_added;
    IF v_added IS NOT NULL THEN
      -- 007's helper: a profile when there is none, the current company moved here only when the current one is not usable.
      PERFORM public._ensure_member(v_uid, v_email, v_inv.organization_id, 'viewer');
    END IF;
  END IF;
  UPDATE public.organization_invites SET used_at = now() WHERE id = v_inv.id;
  PERFORM security_audit.log_named_event(v_inv.organization_id, 'ACCOUNTANT_INVITE_USED', 'organization_invites', v_inv.id::TEXT,
    jsonb_build_object('email', v_inv.email, 'user_id', v_uid, 'via', 'existing_login', 'already_member', v_added IS NULL));
  SELECT o.name INTO v_name FROM public.organizations o WHERE o.id = v_inv.organization_id;
  RETURN jsonb_build_object('status', CASE WHEN v_added IS NULL THEN 'already_member' ELSE 'joined' END,
                            'organization_id', v_inv.organization_id, 'company_name', v_name);
END
$$;
REVOKE ALL ON FUNCTION public.redeem_accountant_invite(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_accountant_invite(TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 5. Revoke (signed in): admin of the current company, never support. TRUE when an open accountant invite of this company was
-- revoked; FALSE when it is already used, revoked, expired, an ordinary invite, or another company's.
CREATE OR REPLACE FUNCTION public.revoke_accountant_invite(p_invite UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_uid   UUID := auth.uid();
  v_email TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_uid IS NULL OR NOT public.has_org_role(ARRAY['admin'])
     OR coalesce((SELECT s.is_support FROM public._session_membership() s), TRUE) THEN
    RAISE EXCEPTION 'Only the company''s own admins can cancel an invite.' USING ERRCODE = '42501';
  END IF;
  UPDATE public.organization_invites i SET revoked_at = now()
  WHERE i.id = p_invite AND i.organization_id = v_org AND i.token_hash IS NOT NULL
    AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
  RETURNING lower(i.email) INTO v_email;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  PERFORM security_audit.log_named_event(v_org, 'ACCOUNTANT_INVITE_REVOKED', 'organization_invites', p_invite::TEXT,
    jsonb_build_object('email', v_email, 'by', v_uid));
  RETURN TRUE;
END
$$;
REVOKE ALL ON FUNCTION public.revoke_accountant_invite(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_accountant_invite(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 6. Peek (server only, no Tolra session): for an OPEN invite, the company's name, the invite's e-mail and expiry, and whether the
-- company's Xero is connected (the page then offers no Xero step). NULL otherwise. Nothing is used up.
CREATE OR REPLACE FUNCTION public.accountant_invite_peek(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN (SELECT jsonb_build_object('company_name', o.name, 'email', lower(i.email), 'expires_at', i.expires_at,
                                    'xero_connected', EXISTS (SELECT 1 FROM public.integration_connections c
                                                              WHERE c.organization_id = i.organization_id AND c.provider = 'xero' AND c.status = 'connected'))
          FROM public.organization_invites i JOIN public.organizations o ON o.id = i.organization_id
          WHERE i.token_hash = p_token_hash AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() AND o.status = 'active');
END
$$;
REVOKE ALL ON FUNCTION public.accountant_invite_peek(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accountant_invite_peek(TEXT) TO service_role;

-- -----------------------------------------------------------------------------------------------------
-- 7. The sign-up trigger (007's, extended). Ordinary invites (token_hash NULL): exactly as before. Accountant invites: only an open one
-- counts (not used, not revoked, not expired); it becomes a VIEWER membership and is marked used (kept). Never raises.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  inv      RECORD;
  v_first  RECORD;
  v_has    BOOLEAN := FALSE;
BEGIN
  BEGIN
    IF NEW.email IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT i.organization_id, i.role, o.name AS org_name INTO v_first
    FROM public.organization_invites i JOIN public.organizations o ON o.id = i.organization_id
    WHERE lower(i.email) = lower(NEW.email)
      AND (i.token_hash IS NULL OR (i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()))
    ORDER BY i.created_at, i.id
    LIMIT 1;
    IF FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = NEW.id) THEN
        INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, organization, active)
        VALUES (NEW.id, lower(NEW.email), nullif(btrim(NEW.raw_user_meta_data ->> 'full_name'), ''), v_first.role,
                v_first.organization_id, v_first.org_name, TRUE)
        ON CONFLICT DO NOTHING;
      END IF;
      IF EXISTS (SELECT 1 FROM public.user_profiles WHERE id = NEW.id) THEN
        FOR inv IN SELECT i.id, i.organization_id, i.role, i.token_hash FROM public.organization_invites i
                   WHERE lower(i.email) = lower(NEW.email)
                     AND (i.token_hash IS NULL OR (i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()))
                   ORDER BY i.created_at, i.id
        LOOP
          INSERT INTO public.organization_members (user_id, organization_id, role, active)
          VALUES (NEW.id, inv.organization_id, CASE WHEN inv.token_hash IS NULL THEN inv.role ELSE 'viewer' END, TRUE)
          ON CONFLICT (user_id, organization_id) DO NOTHING;
          IF inv.token_hash IS NOT NULL THEN
            UPDATE public.organization_invites SET used_at = now() WHERE id = inv.id AND used_at IS NULL;
            PERFORM security_audit.log_named_event(inv.organization_id, 'ACCOUNTANT_INVITE_USED', 'organization_invites', inv.id::TEXT,
              jsonb_build_object('email', lower(NEW.email), 'user_id', NEW.id, 'via', 'sign_up'));
          END IF;
          v_has := TRUE;
        END LOOP;
        IF v_has THEN
          DELETE FROM public.organization_invites WHERE lower(email) = lower(NEW.email) AND token_hash IS NULL;
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_auth_user: profile not created for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

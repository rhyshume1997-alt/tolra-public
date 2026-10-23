-- =====================================================================================================
-- 093: a company admin can never act on the platform owner's login (external read-only audit, Thu 22 Oct, HIGH; ChatGPT + Grok: fix
-- now, its own PR and migration). Applies after 085 and 084; independent of 086 to 092 (other branches). Needs only 036 (support
-- memberships, security_audit.platform_admins) and 066 (my_admin_companies, admin_set_company_access).
--
-- WHY. 036's support memberships are ordinary organization_members rows (support = TRUE); a window that ends leaves the row active
-- (expires_at in the past). The app's service-role routes (Admin > Users: set password, reset two-step sign-in, the users PATCH, add an
-- existing login) counted that leftover row as the company "owning" the login, so an admin of a company the platform owner once entered
-- could set the owner's password and delete their authenticator, sign in as them, enrol a new one and reach the platform. Those routes
-- are fixed in the app (support rows never count as owning a login); they can't see security_audit.platform_admins (revoked from
-- service_role, 036), so this file gives them one signed-in question to ask, and closes the same door in admin_set_company_access.
--
-- WHAT CHANGES.
--   a. NEW public.admin_login_is_protected(p_user) RETURNS BOOLEAN, SECURITY DEFINER, signed-in only (the app calls it with the
--      CALLER's token). TRUE when p_user is a platform owner or has any support membership (active or not, window open or over). It
--      answers FALSE only for a login with a membership in a company the caller administers (my_admin_companies, 066: active,
--      non-support admin, not a support session, aal2 for a platform owner) that is neither; anything else (not an admin, not one of
--      the caller's people, NULL) is TRUE: fail closed, and nobody learns who is a platform owner outside their own people.
--   b. admin_set_company_access (066): 066's body plus one refusal (42501, hint protected_login), after the unknown_login and
--      support_membership checks: the target is a platform owner or has any support membership, and is not the caller. Everything
--      else is exactly as 066 left it (same arguments, grants, SECURITY DEFINER, search_path, locks, safeguards, audit and answer).
--   c. set_member_access (066, the session company's Admin > Users edit and Deactivate): 066's body plus the same refusal (42501, hint
--      protected_login) after its support-membership check, for any change to such a login (not the caller's own) EXCEPT switching
--      its membership in this company off and nothing else (p_active FALSE alone: Revoke support access, Deactivate). Never switched
--      on, never a role, second role or pages. Everything else is 066's (review round 2, Astra + ChatGPT).
-- UNCHANGED: no table, column, policy, trigger, grant on a table or row is changed; no support row is updated (036's leftover active
-- rows stay as they are: from 093 they count for nothing in these paths). add_member is unchanged.
-- GUARD (section 1): admin_set_company_access and set_member_access must be 066's or 093's, admin_login_is_protected absent or 093's
-- (md5 with every whitespace character removed). Safe to run again.
-- Rollback: supabase/release/093_protect_platform_owner_login.rollback.sql (only with Rhys's approval; puts 066's two bodies back,
-- drops (a)).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 093 builds on is there, and the body it replaces is the one it was written against (or already 093's).
DO $$
BEGIN
  IF to_regclass('security_audit.platform_admins') IS NULL OR to_regprocedure('public.my_admin_companies()') IS NULL
     OR to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)') IS NULL THEN
    RAISE EXCEPTION '093: security_audit.platform_admins (036) or my_admin_companies / admin_set_company_access (066) is missing';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)'))
       NOT IN ('a7f5c794e51fe1dc3c98bace9a5dd11d', '378818d240f26ff55595ff4168f7a40e') THEN
    RAISE EXCEPTION '093: public.admin_set_company_access is neither 066''s nor 093''s; stop and compare it first';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_member_access(uuid, text, boolean, text, boolean, text[])'))
       IS DISTINCT FROM 'e0031dfa2d9c89955a26119d3b65b307'
     AND (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_member_access(uuid, text, boolean, text, boolean, text[])'))
       IS DISTINCT FROM '2fc2a6a96b80cc9f7a7f8baf9b67df04' THEN
    RAISE EXCEPTION '093: public.set_member_access is neither 066''s nor 093''s; stop and compare it first';
  END IF;
  IF to_regprocedure('public.admin_login_is_protected(uuid)') IS NOT NULL
     AND (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_login_is_protected(uuid)')) <> 'a938b2269bd2554f36acf0beaf7bb8f3' THEN
    RAISE EXCEPTION '093: public.admin_login_is_protected exists but is not 093''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The one question the service-role routes ask, with the caller's token: may I act on this login's identity?
CREATE OR REPLACE FUNCTION public.admin_login_is_protected(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    -- Not one of the caller's people (or the caller administers nothing): TRUE, the same answer as a platform owner.
    WHEN p_user IS NULL OR NOT EXISTS (SELECT 1 FROM public.organization_members t
                                       JOIN public.my_admin_companies() c ON c.organization_id = t.organization_id
                                       WHERE t.user_id = p_user) THEN TRUE
    ELSE EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p_user)
      OR EXISTS (SELECT 1 FROM public.organization_members s WHERE s.user_id = p_user AND s.support)
  END
$$;
REVOKE ALL ON FUNCTION public.admin_login_is_protected(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_login_is_protected(UUID) TO authenticated;
COMMENT ON FUNCTION public.admin_login_is_protected(UUID) IS
  'TRUE unless p_user is one of the caller''s people (a membership in a company the caller administers) and neither a platform owner nor a login with any support membership (093).';

-- -----------------------------------------------------------------------------------------------------
-- 3. admin_set_company_access: 066's body plus the protected_login refusal.
CREATE OR REPLACE FUNCTION public.admin_set_company_access(
  p_org             UUID,
  p_user            UUID,
  p_role            TEXT    DEFAULT NULL,
  p_secondary_role  TEXT    DEFAULT NULL,
  p_clear_secondary BOOLEAN DEFAULT FALSE,
  p_active          BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_session_org UUID := public.current_user_organization_id();
  v_aal2        BOOLEAN := coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
  v_require_mfa BOOLEAN;
  v_exists      BOOLEAN;
  v_old_role    TEXT;
  v_old_second  TEXT;
  v_old_active  BOOLEAN;
  v_old_support BOOLEAN;
  v_role        TEXT;
  v_second      TEXT;
  v_active      BOOLEAN;
  v_was_admin   BOOLEAN;
  v_will_admin  BOOLEAN;
  v_count       INT;
  v_flag        BOOLEAN;
  v_action      TEXT;
  v_cur         UUID;
  v_cur_ok      BOOLEAN;
  v_alt         UUID;
  v_email       TEXT;
BEGIN
  -- The session company's own second-step rule (033), as every privileged function.
  PERFORM public.assert_privileged_aal();
  IF v_uid IS NULL OR p_org IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'Only admins of that company can change who has access to it' USING ERRCODE = '42501', HINT = 'not_company_admin';
  END IF;
  IF EXISTS (SELECT 1 FROM public._session_membership() s WHERE s.is_support) THEN
    RAISE EXCEPTION 'Support access cannot change who has access to a company' USING ERRCODE = '42501', HINT = 'support_session';
  END IF;
  IF (p_role IS NOT NULL AND p_role NOT IN ('admin', 'office', 'workshop', 'viewer'))
     OR (p_secondary_role IS NOT NULL AND p_secondary_role NOT IN ('admin', 'office', 'workshop', 'viewer')) THEN
    RAISE EXCEPTION 'Invalid role' USING ERRCODE = '22023';
  END IF;

  -- 1. The caller administers p_org (checked before anything is locked, and again after).
  SELECT o.require_admin_mfa INTO v_require_mfa
  FROM public.organizations o
  JOIN public.organization_members c ON c.organization_id = o.id AND c.user_id = v_uid
  JOIN public.user_profiles p ON p.id = v_uid
  WHERE o.id = p_org AND o.status = 'active' AND c.active AND NOT c.support AND 'admin' IN (c.role, coalesce(c.secondary_role, ''))
    AND p.active AND NOT p.must_change_password
    AND (v_aal2 OR NOT EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = v_uid));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only admins of that company can change who has access to it' USING ERRCODE = '42501', HINT = 'not_company_admin';
  END IF;
  -- 2. That company's second-step rule, whatever the session's company requires.
  IF v_require_mfa AND NOT v_aal2 THEN
    RAISE EXCEPTION 'Confirm your authenticator code first (second step of sign-in).' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;

  -- 3. Lock the login's memberships (every company: the last-company rule) and p_org's active admins (the last-admin rule), in one
  -- statement in a fixed order, so concurrent calls queue instead of each counting the other's rows as still there.
  PERFORM 1 FROM public.organization_members x
  WHERE x.user_id = p_user
     OR (x.organization_id = p_org AND x.active AND NOT x.support AND 'admin' IN (x.role, coalesce(x.secondary_role, '')))
  ORDER BY x.organization_id, x.user_id
  FOR UPDATE;
  -- The caller may have lost admin while waiting.
  IF NOT EXISTS (SELECT 1 FROM public.organization_members c
                 WHERE c.organization_id = p_org AND c.user_id = v_uid AND c.active AND NOT c.support
                   AND 'admin' IN (c.role, coalesce(c.secondary_role, ''))) THEN
    RAISE EXCEPTION 'Only admins of that company can change who has access to it' USING ERRCODE = '42501', HINT = 'not_company_admin';
  END IF;
  -- Only someone already in a company the caller administers (an ordinary membership, active or not): a login with no such link,
  -- or no login at all, gets the same answer, so this can't be used to find or pull in anyone else's people.
  IF NOT EXISTS (SELECT 1 FROM public.organization_members t
                 JOIN public.organization_members c ON c.organization_id = t.organization_id AND c.user_id = v_uid
                 JOIN public.organizations o ON o.id = t.organization_id
                 WHERE t.user_id = p_user AND NOT t.support AND c.active AND NOT c.support AND o.status = 'active'
                   AND 'admin' IN (c.role, coalesce(c.secondary_role, ''))) THEN
    RAISE EXCEPTION 'Add this person to your company with Add user first' USING ERRCODE = '42501', HINT = 'unknown_login';
  END IF;

  SELECT m.role, m.secondary_role, m.active, m.support INTO v_old_role, v_old_second, v_old_active, v_old_support
  FROM public.organization_members m WHERE m.user_id = p_user AND m.organization_id = p_org;
  v_exists := FOUND;
  IF v_exists AND v_old_support THEN
    RAISE EXCEPTION 'A support membership can''t be changed here' USING ERRCODE = '42501', HINT = 'support_membership';
  END IF;
  -- 093: never a platform owner's login, nor one with ANY support membership (active or switched off, window open or over: a
  -- support row is only ever written for a platform owner, 036), unless it is the caller themself. Otherwise an admin could change,
  -- or pull into another company, the login that holds platform access (external audit, Thu 22 Oct).
  IF p_user <> v_uid
     AND (EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p_user)
          OR EXISTS (SELECT 1 FROM public.organization_members s WHERE s.user_id = p_user AND s.support)) THEN
    RAISE EXCEPTION 'This is a Tolra support login, so its access can''t be changed here' USING ERRCODE = '42501', HINT = 'protected_login';
  END IF;
  IF NOT v_exists THEN
    IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = p_user) THEN
      RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_active IS DISTINCT FROM TRUE THEN
      IF p_active IS FALSE THEN
        -- Nothing to remove.
        RETURN jsonb_build_object('changed', FALSE, 'action', NULL, 'organization_id', p_org, 'user_id', p_user, 'role', NULL,
                                  'secondary_role', NULL, 'active', FALSE, 'was_active', FALSE, 'reactivated', FALSE,
                                  'mfa_enrolment_required', FALSE);
      END IF;
      RAISE EXCEPTION 'Switch access on to add them to that company' USING ERRCODE = '22023';
    END IF;
    IF p_role IS NULL THEN
      RAISE EXCEPTION 'Choose a role for that company' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 4. What the membership will be. Removing keeps the role as it was (it is only switched off).
  v_active := coalesce(p_active, v_old_active);
  IF v_active THEN
    v_role   := coalesce(p_role, v_old_role);
    v_second := CASE WHEN coalesce(p_clear_secondary, FALSE) THEN NULL ELSE coalesce(p_secondary_role, v_old_second) END;
    IF v_second = v_role THEN v_second := NULL; END IF;
  ELSE
    v_role := v_old_role;
    v_second := v_old_second;
  END IF;
  IF v_exists AND v_role = v_old_role AND v_second IS NOT DISTINCT FROM v_old_second AND v_active = v_old_active THEN
    RETURN jsonb_build_object('changed', FALSE, 'action', NULL, 'organization_id', p_org, 'user_id', p_user, 'role', v_role,
                              'secondary_role', v_second, 'active', v_active, 'was_active', v_old_active, 'reactivated', FALSE,
                              'mfa_enrolment_required', coalesce((SELECT m.mfa_enrolment_required FROM public.organization_members m
                                                                  WHERE m.user_id = p_user AND m.organization_id = p_org), FALSE));
  END IF;
  v_was_admin  := v_exists AND v_old_active AND 'admin' IN (v_old_role, coalesce(v_old_second, ''));
  v_will_admin := v_active AND 'admin' IN (v_role, coalesce(v_second, ''));

  -- 5. The safeguards, each against p_org (rows locked above).
  -- An existing login is added to p_org, or switched back on there, only when it is the caller or the caller is an active,
  -- non-support admin of EVERY company where it has a membership (active or not, support included). Otherwise it would become
  -- shared with a company that does not own it, and its owner could no longer reset its password, username or two-step sign-in.
  IF v_active AND NOT coalesce(v_exists AND v_old_active, FALSE) AND p_user <> v_uid
     AND EXISTS (SELECT 1 FROM public.organization_members t
                 WHERE t.user_id = p_user
                   AND NOT EXISTS (SELECT 1 FROM public.organization_members c
                                   WHERE c.organization_id = t.organization_id AND c.user_id = v_uid AND c.active AND NOT c.support
                                     AND 'admin' IN (c.role, coalesce(c.secondary_role, '')))) THEN
    RAISE EXCEPTION 'This login belongs to another company. An admin of that company must add it.' USING ERRCODE = '42501', HINT = 'other_company_login';
  END IF;
  IF v_was_admin AND NOT v_will_admin THEN
    SELECT count(*) INTO v_count FROM public.organization_members x
    WHERE x.organization_id = p_org AND x.active AND NOT x.support AND x.user_id <> p_user
      AND 'admin' IN (x.role, coalesce(x.secondary_role, ''));
    IF v_count < 1 THEN
      RAISE EXCEPTION 'At least one active admin is required' USING ERRCODE = '23514', HINT = 'last_admin';
    END IF;
  END IF;
  IF p_user = v_uid AND NOT v_active THEN
    RAISE EXCEPTION 'You cannot remove your own access' USING ERRCODE = '23514', HINT = 'self_removal';
  END IF;
  IF p_user = v_uid AND NOT v_will_admin THEN
    RAISE EXCEPTION 'You cannot remove your own admin rights' USING ERRCODE = '23514', HINT = 'self_demotion';
  END IF;
  IF v_exists AND v_old_active AND NOT v_active THEN
    SELECT count(*) INTO v_count FROM public.organization_members x JOIN public.organizations o ON o.id = x.organization_id
    WHERE x.user_id = p_user AND x.organization_id <> p_org AND x.active AND NOT x.support AND o.status = 'active';
    IF v_count < 1 THEN
      RAISE EXCEPTION 'This login must keep access to at least one company' USING ERRCODE = '23514', HINT = 'last_company';
    END IF;
  END IF;

  -- 6. The change. A grant is an ordinary membership (never support); removal only switches it off.
  IF NOT v_exists THEN
    INSERT INTO public.organization_members (user_id, organization_id, role, secondary_role, active)
    VALUES (p_user, p_org, v_role, v_second, TRUE)
    ON CONFLICT (user_id, organization_id) DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Someone changed this at the same time. Try again.' USING ERRCODE = '40001', HINT = 'concurrent_change';
    END IF;
  ELSE
    UPDATE public.organization_members
       SET role = v_role, secondary_role = v_second, active = v_active, updated_at = now()
     WHERE user_id = p_user AND organization_id = p_org;
  END IF;
  SELECT m.mfa_enrolment_required INTO v_flag FROM public.organization_members m WHERE m.user_id = p_user AND m.organization_id = p_org;

  -- 7. Keep the profile's current company valid (as 036's set_member_access, with p_org as the company changed).
  SELECT organization_id INTO v_cur FROM public.user_profiles WHERE id = p_user FOR UPDATE;
  IF FOUND THEN
    IF v_cur = p_org THEN
      IF NOT v_active THEN
        SELECT m2.organization_id INTO v_alt
        FROM public.organization_members m2 JOIN public.organizations o ON o.id = m2.organization_id
        WHERE m2.user_id = p_user AND m2.active AND NOT m2.support AND o.status = 'active' AND m2.organization_id <> p_org
        ORDER BY m2.created_at, o.name LIMIT 1;
      END IF;
      PERFORM public._apply_membership_to_profile(p_user, coalesce(v_alt, p_org));
    ELSIF v_active THEN
      SELECT EXISTS (SELECT 1 FROM public.organization_members m2 JOIN public.organizations o ON o.id = m2.organization_id
                     WHERE m2.user_id = p_user AND m2.organization_id = v_cur AND m2.active AND NOT m2.support AND o.status = 'active')
        INTO v_cur_ok;
      IF NOT v_cur_ok THEN
        PERFORM public._apply_membership_to_profile(p_user, p_org);
      END IF;
    END IF;
  END IF;

  -- 8. The record, in p_org's own log.
  v_action := CASE WHEN NOT v_exists OR NOT v_old_active THEN 'GRANT_COMPANY_ACCESS'
                   WHEN NOT v_active THEN 'REMOVE_COMPANY_ACCESS'
                   ELSE 'CHANGE_COMPANY_ROLE' END;
  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_uid;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, old_data, new_data, metadata)
  VALUES (p_org, v_uid, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), v_action, 'user_profiles', p_user::TEXT,
          CASE WHEN v_exists THEN jsonb_build_object('role', v_old_role, 'secondary_role', v_old_second, 'active', v_old_active) END,
          jsonb_build_object('role', v_role, 'secondary_role', v_second, 'active', v_active),
          jsonb_build_object('source', 'company_access', 'session_organization_id', v_session_org, 'mfa_enrolment_required', coalesce(v_flag, FALSE)));

  RETURN jsonb_build_object('changed', TRUE, 'action', v_action, 'organization_id', p_org, 'user_id', p_user, 'role', v_role,
                            'secondary_role', v_second, 'active', v_active, 'was_active', coalesce(v_exists AND v_old_active, FALSE),
                            -- An existing, switched-off membership of p_org switched back on (not a new one): the app lifts its
                            -- own deactivation ban only then, never for a login new to p_org.
                            'reactivated', coalesce(v_exists AND NOT v_old_active AND v_active, FALSE),
                            'mfa_enrolment_required', coalesce(v_flag, FALSE));
END
$$;
REVOKE ALL ON FUNCTION public.admin_set_company_access(UUID, UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_company_access(UUID, UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) TO authenticated;
COMMENT ON FUNCTION public.admin_set_company_access(UUID, UUID, TEXT, TEXT, BOOLEAN, BOOLEAN) IS
  'Admins of p_org only (aal2 where p_org requires it). Grants, changes or removes one login''s access to p_org with the 036 safeguards against p_org, keeps one company per login, audits in p_org''s log (066); never a platform owner or a login with a support membership (093).';

-- -----------------------------------------------------------------------------------------------------
-- 3b. set_member_access (the session company's Admin > Users: role, second role, pages, Deactivate / Reactivate): 066's body plus the
-- same protected_login refusal, except the one intended change: switching that login's membership in this company OFF and nothing
-- else (Revoke support access; Deactivate). It is never switched on, and its role, second role or pages never change, from here.
CREATE OR REPLACE FUNCTION public.set_member_access(
  p_user            UUID,
  p_role            TEXT    DEFAULT NULL,
  p_active          BOOLEAN DEFAULT NULL,
  p_secondary_role  TEXT    DEFAULT NULL,
  p_clear_secondary BOOLEAN DEFAULT FALSE,
  p_hidden_sections TEXT[]  DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_org      UUID := public.current_user_organization_id();
  m          RECORD;
  v_role     TEXT;
  v_second   TEXT;
  v_active   BOOLEAN;
  v_admins   INT;
  v_cur      UUID;
  v_cur_ok   BOOLEAN;
  v_alt      UUID;
  v_others   INT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_uid IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can change member access' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public._session_membership() s WHERE s.is_support) THEN
    RAISE EXCEPTION 'Support access cannot change who has access to the company' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL AND p_active IS NULL AND p_secondary_role IS NULL AND NOT coalesce(p_clear_secondary, FALSE) AND p_hidden_sections IS NULL THEN
    RAISE EXCEPTION 'Nothing to change' USING ERRCODE = '22023';
  END IF;
  IF (p_role IS NOT NULL AND p_role NOT IN ('admin', 'office', 'workshop', 'viewer'))
     OR (p_secondary_role IS NOT NULL AND p_secondary_role NOT IN ('admin', 'office', 'workshop', 'viewer')) THEN
    RAISE EXCEPTION 'Invalid role' USING ERRCODE = '22023';
  END IF;
  IF p_hidden_sections IS NOT NULL AND NOT (p_hidden_sections <@ public.member_section_keys()) THEN
    RAISE EXCEPTION 'Invalid page section' USING ERRCODE = '22023';
  END IF;

  -- 066: lock the login's memberships (every company: the last-company rule) and this company's active admins (the last-admin rule)
  -- in one statement, in the same fixed order as admin_set_company_access, before anything is read or counted.
  PERFORM 1 FROM public.organization_members x
  WHERE x.user_id = p_user
     OR (x.organization_id = v_org AND x.active AND NOT x.support AND 'admin' IN (x.role, coalesce(x.secondary_role, '')))
  ORDER BY x.organization_id, x.user_id
  FOR UPDATE;

  SELECT * INTO m FROM public.organization_members WHERE user_id = p_user AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found in this organisation' USING ERRCODE = 'P0002';
  END IF;
  IF m.support AND (p_role IS NOT NULL OR p_secondary_role IS NOT NULL OR coalesce(p_clear_secondary, FALSE) OR p_hidden_sections IS NOT NULL
                    OR p_active IS DISTINCT FROM FALSE) THEN
    RAISE EXCEPTION 'A support membership can only be switched off' USING ERRCODE = '42501';
  END IF;
  -- 093: a platform owner's login, or one with ANY support membership (here or in another company, active or not, window open or over),
  -- is not changed from here, except switched off (p_active FALSE and nothing else). Not the caller themself.
  IF p_user <> v_uid
     AND (p_role IS NOT NULL OR p_secondary_role IS NOT NULL OR coalesce(p_clear_secondary, FALSE) OR p_hidden_sections IS NOT NULL
          OR p_active IS DISTINCT FROM FALSE)
     AND (EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p_user)
          OR EXISTS (SELECT 1 FROM public.organization_members s WHERE s.user_id = p_user AND s.support)) THEN
    RAISE EXCEPTION 'This is a Tolra support login, so it can only be switched off here' USING ERRCODE = '42501', HINT = 'protected_login';
  END IF;

  v_role   := coalesce(p_role, m.role);
  v_second := CASE WHEN coalesce(p_clear_secondary, FALSE) THEN NULL ELSE coalesce(p_secondary_role, m.secondary_role) END;
  IF v_second = v_role THEN v_second := NULL; END IF;
  v_active := coalesce(p_active, m.active);

  IF p_user = v_uid AND NOT v_active THEN
    RAISE EXCEPTION 'You cannot deactivate your own access' USING ERRCODE = '23514';
  END IF;
  IF p_user = v_uid AND 'admin' NOT IN (v_role, coalesce(v_second, '')) THEN
    RAISE EXCEPTION 'You cannot remove your own admin rights' USING ERRCODE = '23514';
  END IF;

  -- Was an active admin and won't be: someone else (not support) must still be one.
  IF m.active AND NOT m.support AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))
     AND (NOT v_active OR 'admin' NOT IN (v_role, coalesce(v_second, ''))) THEN
    SELECT count(*) INTO v_admins FROM (
      SELECT 1 FROM public.organization_members
      WHERE organization_id = v_org AND active AND NOT support AND user_id <> p_user AND 'admin' IN (role, coalesce(secondary_role, ''))
      FOR UPDATE
    ) x;
    IF v_admins < 1 THEN
      RAISE EXCEPTION 'At least one active admin is required' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 066: switching off an ordinary membership never leaves the login without an active company (the same rule and refusal as
  -- admin_set_company_access). A support membership is not a company of their own: it can still be switched off.
  IF m.active AND NOT m.support AND NOT v_active THEN
    SELECT count(*) INTO v_others FROM public.organization_members x JOIN public.organizations o ON o.id = x.organization_id
    WHERE x.user_id = p_user AND x.organization_id <> v_org AND x.active AND NOT x.support AND o.status = 'active';
    IF v_others < 1 THEN
      RAISE EXCEPTION 'This login must keep access to at least one company' USING ERRCODE = '23514', HINT = 'last_company';
    END IF;
  END IF;

  UPDATE public.organization_members
     SET role = v_role,
         secondary_role = v_second,
         active = v_active,
         hidden_sections = CASE WHEN p_hidden_sections IS NULL THEN hidden_sections
                                ELSE coalesce((SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(p_hidden_sections) s), '{}'::TEXT[]) END,
         updated_at = now()
   WHERE user_id = p_user AND organization_id = v_org
   RETURNING * INTO m;

  -- A support member has no company of their own to keep in step.
  IF m.support THEN
    RETURN;
  END IF;

  -- keep the profile in step (as in 007)
  SELECT organization_id INTO v_cur FROM public.user_profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_cur = v_org THEN
    IF NOT m.active THEN
      SELECT m2.organization_id INTO v_alt
      FROM public.organization_members m2 JOIN public.organizations o ON o.id = m2.organization_id
      WHERE m2.user_id = p_user AND m2.active AND NOT m2.support AND o.status = 'active' AND m2.organization_id <> v_org
      ORDER BY m2.created_at, o.name LIMIT 1;
      IF v_alt IS NOT NULL THEN
        PERFORM public._apply_membership_to_profile(p_user, v_alt);
        RETURN;
      END IF;
    END IF;
    PERFORM public._apply_membership_to_profile(p_user, v_org);
  ELSIF m.active THEN
    SELECT EXISTS (SELECT 1 FROM public.organization_members m2 JOIN public.organizations o ON o.id = m2.organization_id
                   WHERE m2.user_id = p_user AND m2.organization_id = v_cur AND m2.active AND o.status = 'active')
      INTO v_cur_ok;
    IF NOT v_cur_ok THEN
      PERFORM public._apply_membership_to_profile(p_user, v_org);
    END IF;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_access(UUID, TEXT, BOOLEAN, TEXT, BOOLEAN, TEXT[]) TO authenticated;


-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check: the three bodies are 093's, definer with the fixed search_path, signed-in only.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '378818d240f26ff55595ff4168f7a40e' OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)')) THEN
    RAISE EXCEPTION '093: admin_set_company_access is not 093''s after the replace';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'a938b2269bd2554f36acf0beaf7bb8f3' OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_login_is_protected(uuid)')) THEN
    RAISE EXCEPTION '093: admin_login_is_protected is not 093''s';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '2fc2a6a96b80cc9f7a7f8baf9b67df04' OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
      FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_member_access(uuid, text, boolean, text, boolean, text[])')) THEN
    RAISE EXCEPTION '093: set_member_access is not 093''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.admin_login_is_protected(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_login_is_protected(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_member_access(uuid, text, boolean, text, boolean, text[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_member_access(uuid, text, boolean, text, boolean, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION '093: the grants are not signed-in only';
  END IF;
END
$$;

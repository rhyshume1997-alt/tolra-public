-- 066: Per-company access in Admin > Users. An admin who is also an admin of another company grants, changes or removes a login's
-- access to that company from one screen, with the same safeguards as set_member_access (036), checked against THAT company.
--
-- Why SQL: set_member_access() works on the session's company only (current_user_organization_id()), and write_audit() always stamps
-- the session's company. Changing a login's access in ANOTHER company the admin administers needs every safeguard checked against
-- that company, atomically, and the audit row in that company's own log.
--
-- 1. my_admin_companies(): the companies where the caller is an active, non-support admin (role or second role) of an active
--    company. Nothing else is ever listed. Empty for a support session, a profile that is inactive or must change its password, and
--    a platform owner whose token has not passed the second step (as 036's _session_membership()).
-- 2. admin_company_access(p_user): for each company of (1), that login's membership there (or none). Nothing about any other company.
-- 3. admin_set_company_access(p_org, p_user, p_role, p_secondary_role, p_clear_secondary, p_active), in one transaction:
--    * the caller must be an active, non-support admin of p_org (42501, hint not_company_admin), not in a support session;
--    * p_org requires the second step (organizations.require_admin_mfa, 033) and the token is not aal2: refused (42501, hint
--      mfa_required), whatever the session's company requires (the session company's own rule is checked too, assert_privileged_aal);
--    * only a login that already has an ordinary membership (active or not) in a company the caller administers (42501, hint
--      unknown_login): the same answer whether or not the login exists, so nobody else's people can be found or pulled in. A person
--      new to the caller's companies is added with Add user (username / e-mail) first;
--    * granting or switching back on is allowed only for the caller themself, or a login all of whose companies (every membership,
--      active or not) the caller administers (42501, hint other_company_login): a Marpet-only admin can't make a JNR login shared,
--      which would stop JNR's admins resetting its password, username or two-step sign-in. An admin of both can;
--    * a support membership is never changed here (42501, hint support_membership);
--    * the last active admin of p_org can't be removed or demoted (23514, hint last_admin);
--    * nobody removes their own access or their own admin rights (23514, hints self_removal / self_demotion);
--    * a login's LAST active company can't be removed (23514, hint last_company): a login always keeps at least one company;
--    * grant = insert, or reactivate, an ordinary membership (support FALSE). The 065 trigger flags an admin grant
--      (mfa_enrolment_required) unless the person already has a verified authenticator factor. The result says `reactivated` only
--      when an existing switched-off membership of p_org is switched back on (the app lifts its own deactivation ban only then);
--    * removal = deactivate only, never delete; the profile's current company moves to another active company as 036 does;
--    * one audit row in p_org's own hash-chained log (security_audit.audit_log, chained by set_audit_hash, 006):
--      GRANT_COMPANY_ACCESS / CHANGE_COMPANY_ROLE / REMOVE_COMPANY_ACCESS on user_profiles / the login, with the actor, old and new
--      role, second role and active. These actions are written only by this function: write_audit (audit_event_allowed) still
--      refuses them from a client, so nobody can make one up.
--    Races: the login's memberships and p_org's active admins are locked (FOR UPDATE, one statement, fixed order) before anything is
--    counted, and the caller's own admin membership is checked again after the lock. Two admins removing the same login's last two
--    companies at once: the second waits, then is refused (last_company). Two admins demoting each other: the second is refused.
-- 4. set_member_access (036, Deactivate in Admin > Users on the session's company) keeps a login's last company too: the same 066
--    lock, then switching off an ordinary membership is refused (23514, hint last_company) when the login has no other active,
--    non-support membership in an active company. Everything else in it is exactly as 036 left it.
-- Executable by authenticated only (revoked from PUBLIC and anon). No table, column, policy or trigger changes.
--
-- Depends on 033 (require_admin_mfa, assert_privileged_aal), 036 (support memberships, _session_membership, platform owners,
-- _apply_membership_to_profile, set_member_access) and 065 (the enrolment flag trigger). Forward only, safe to run more than once.
-- Rollback: docs/RELEASE.md "066" (drops 1 to 3 and restores 036's set_member_access).

-- ---- 1. The companies the caller administers ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_admin_companies()
RETURNS TABLE (organization_id UUID, name TEXT, is_current BOOLEAN, require_admin_mfa BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT o.id, o.name, coalesce(o.id = public.current_user_organization_id(), FALSE), o.require_admin_mfa
  FROM public.user_profiles p
  JOIN public.organization_members m ON m.user_id = p.id
  JOIN public.organizations o ON o.id = m.organization_id
  WHERE p.id = auth.uid() AND p.active AND NOT p.must_change_password
    AND m.active AND NOT m.support AND o.status = 'active'
    AND 'admin' IN (m.role, coalesce(m.secondary_role, ''))
    -- A platform owner works in no company on a token that has not passed the second step (036).
    AND (coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
         OR NOT EXISTS (SELECT 1 FROM security_audit.platform_admins a WHERE a.user_id = p.id))
    -- Support access never manages who has access.
    AND NOT coalesce((SELECT s.is_support FROM public._session_membership() s), FALSE)
  ORDER BY o.name, o.id
$$;
REVOKE ALL ON FUNCTION public.my_admin_companies() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_admin_companies() TO authenticated;

-- ---- 2. One login's access in those companies -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_company_access(p_user UUID)
RETURNS TABLE (organization_id UUID, name TEXT, is_current BOOLEAN, require_admin_mfa BOOLEAN, member BOOLEAN, role TEXT,
               secondary_role TEXT, active BOOLEAN, support BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT c.organization_id, c.name, c.is_current, c.require_admin_mfa, m.user_id IS NOT NULL, m.role, m.secondary_role,
         coalesce(m.active, FALSE), coalesce(m.support, FALSE)
  FROM public.my_admin_companies() c
  LEFT JOIN public.organization_members m ON m.organization_id = c.organization_id AND m.user_id = p_user
  ORDER BY c.name, c.organization_id
$$;
REVOKE ALL ON FUNCTION public.admin_company_access(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_company_access(UUID) TO authenticated;

-- ---- 3. Grant, change or remove one login's access to one company ----------------------------------------------------------
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
  'Admins of p_org only (aal2 where p_org requires it). Grants, changes or removes one login''s access to p_org with the 036 safeguards against p_org, keeps one company per login, audits in p_org''s log (066).';

-- ---- 4. Deactivate on the session's company keeps a login's last company too ---------------------------------------------------
-- set_member_access as 036 defined it (unchanged since: same arguments, grants, SECURITY DEFINER, search_path, self, support and
-- last-admin rules), plus two things: the 066 lock (the login's memberships and this company's active admins, one statement, the
-- same fixed order as admin_set_company_access), and the last-company rule: switching off an ordinary membership is refused (23514,
-- hint last_company) when the login has no other active, non-support membership in an active company.
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

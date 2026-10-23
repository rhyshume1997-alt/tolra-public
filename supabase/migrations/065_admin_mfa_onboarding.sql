-- 065: Admin two-step sign-in onboarding (authenticator app, TOTP).
--
-- 1. organization_members.mfa_enrolment_required: set when a person is GIVEN admin in a company by another admin (Admin > Users:
--    created as admin, role or second role changed to admin, an admin membership reactivated, or an admin's two-step sign-in reset).
--    The app sends such a person to /mfa to set up an authenticator app at their next sign-in, until they have a verified factor,
--    whatever REQUIRE_ADMIN_MFA says (lib/mfa-policy.ts). Cleared whenever the membership no longer holds admin. An admin acting
--    through the app (role authenticated, set_member_access) sets it automatically and can never clear it; the service role (the
--    app's own create and reset paths) and the database owner write it explicitly.
-- 2. organizations.require_admin_mfa (033) can't be turned ON while any active admin of that company has no verified
--    authenticator factor (BEFORE trigger, every path: SQL editor, service role, a future RPC). Turning it off is never refused.
--    Promoting a not-yet-enrolled person to admin while the rule is on is ALLOWED: they are flagged (1), sent to /mfa, and the
--    database refuses their privileged actions at aal1 until they enrol (033), so the company is never locked out of adding an admin.
-- 3. admin_mfa_overview(): for the admins of the caller's current company (admins only): who has a verified factor, who must set
--    one up at next sign-in, the rule's state and whether it could be turned on. my_mfa_enrolment_required(): the caller's own answer,
--    read by the middleware. It is FALSE unless another active admin of the company can still sign in normally, so the last usable
--    admin is never sent to a set-up screen they might not be able to finish.
--
-- Reads auth.mfa_factors (verified TOTP factors) only inside SECURITY DEFINER functions owned by the migration owner.
-- Additive: one column (default FALSE, nothing flagged on apply), two triggers, four functions. Rollback: docs/RELEASE.md "Migration 065".

ALTER TABLE public.organization_members ADD COLUMN IF NOT EXISTS mfa_enrolment_required BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN public.organization_members.mfa_enrolment_required IS
  'Admin given admin by another admin: must set up an authenticator app at next sign-in (migration 065). Cleared when not admin.';

-- TRUE when the login has a verified authenticator-app (TOTP) factor. Internal: nobody calls it directly.
CREATE OR REPLACE FUNCTION public.member_has_verified_totp(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = p_user AND f.factor_type::TEXT = 'totp' AND f.status::TEXT = 'verified')
$$;
REVOKE ALL ON FUNCTION public.member_has_verified_totp(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- ---- 1. The flag ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.organization_members_mfa_enrolment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role    TEXT := coalesce(nullif(current_setting('role', true), 'none'), session_user::TEXT);
  v_now     BOOLEAN := coalesce(NEW.active AND NOT NEW.support AND 'admin' IN (NEW.role, coalesce(NEW.secondary_role, '')), FALSE);
  v_before  BOOLEAN := TG_OP = 'UPDATE' AND coalesce(OLD.active AND NOT OLD.support AND 'admin' IN (OLD.role, coalesce(OLD.secondary_role, '')), FALSE);
BEGIN
  IF NOT v_now THEN
    NEW.mfa_enrolment_required := FALSE;
  ELSIF v_role IN ('anon', 'authenticated') THEN
    -- A signed-in admin (through set_member_access or another SECURITY DEFINER path): given admin now -> required unless already
    -- enrolled; otherwise the value can't be changed from a signed-in session.
    IF NOT v_before THEN
      NEW.mfa_enrolment_required := NOT public.member_has_verified_totp(NEW.user_id);
    ELSE
      NEW.mfa_enrolment_required := OLD.mfa_enrolment_required;
    END IF;
  END IF;
  -- service_role and the database owner: the value they write stands (the app's create and reset paths, fixtures, setup scripts).
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.organization_members_mfa_enrolment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organization_members_mfa_enrolment ON public.organization_members;
CREATE TRIGGER organization_members_mfa_enrolment
  BEFORE INSERT OR UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.organization_members_mfa_enrolment();

-- ---- 2. The company rule can't turn on while an admin has not enrolled ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.organizations_require_admin_mfa_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_missing TEXT[];
BEGIN
  IF NOT NEW.require_admin_mfa OR (TG_OP = 'UPDATE' AND OLD.require_admin_mfa) THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(coalesce(nullif(p.email, ''), m.user_id::TEXT) ORDER BY p.email)
  INTO v_missing
  FROM public.organization_members m
  LEFT JOIN public.user_profiles p ON p.id = m.user_id
  WHERE m.organization_id = NEW.id
    AND m.active
    AND NOT m.support
    AND (m.role = 'admin' OR m.secondary_role = 'admin')
    AND NOT public.member_has_verified_totp(m.user_id);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Two-step sign-in can''t be required yet: % admin(s) have not set up an authenticator app (%).',
      cardinality(v_missing), array_to_string(v_missing, ', ')
      USING ERRCODE = '23514', HINT = 'admins_not_enrolled';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.organizations_require_admin_mfa_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organizations_require_admin_mfa_guard ON public.organizations;
CREATE TRIGGER organizations_require_admin_mfa_guard
  BEFORE INSERT OR UPDATE OF require_admin_mfa ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_require_admin_mfa_guard();

-- ---- 3. What the app reads --------------------------------------------------------------------------------------------------
-- Admins of the caller's current company (role or second role admin, active, not support): enrolled, enrolment required.
-- Admins only; another company's people are never listed.
CREATE OR REPLACE FUNCTION public.admin_mfa_overview()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_admins JSONB;
BEGIN
  IF auth.uid() IS NULL OR v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can see two-step sign-in status' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'user_id', m.user_id,
           'enrolled', public.member_has_verified_totp(m.user_id),
           'enrolment_required', m.mfa_enrolment_required) ORDER BY m.user_id), '[]'::JSONB)
  INTO v_admins
  FROM public.organization_members m
  WHERE m.organization_id = v_org AND m.active AND NOT m.support AND (m.role = 'admin' OR m.secondary_role = 'admin');
  RETURN jsonb_build_object(
    'require_admin_mfa', (SELECT o.require_admin_mfa FROM public.organizations o WHERE o.id = v_org),
    'can_require', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_admins) a WHERE NOT (a ->> 'enrolled')::BOOLEAN),
    'admins', v_admins);
END
$$;
REVOKE ALL ON FUNCTION public.admin_mfa_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mfa_overview() TO authenticated;

-- The caller's own answer for the session's company: TRUE when they were given admin, have no verified factor yet, and another
-- active admin of the company can still sign in normally (not flagged, or already enrolled). FALSE otherwise, never an error for a
-- signed-in person, so the middleware can treat any failure as "not required" (the global REQUIRE_ADMIN_MFA gate is separate).
CREATE OR REPLACE FUNCTION public.my_mfa_enrolment_required()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce((
    SELECT m.mfa_enrolment_required
       AND NOT public.member_has_verified_totp(m.user_id)
       AND EXISTS (
         SELECT 1 FROM public.organization_members o
         WHERE o.organization_id = m.organization_id AND o.user_id <> m.user_id
           AND o.active AND NOT o.support AND (o.role = 'admin' OR o.secondary_role = 'admin')
           AND (NOT o.mfa_enrolment_required OR public.member_has_verified_totp(o.user_id)))
    FROM public.organization_members m
    WHERE m.user_id = auth.uid()
      AND m.organization_id = public.current_user_organization_id()
      AND m.active AND NOT m.support AND (m.role = 'admin' OR m.secondary_role = 'admin')), FALSE)
$$;
REVOKE ALL ON FUNCTION public.my_mfa_enrolment_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_mfa_enrolment_required() TO authenticated;

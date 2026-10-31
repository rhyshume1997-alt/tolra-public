-- 102_security_guards.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 102: database guards from the pre-go-live security review (Z4, Z3 with T2, T1, T3). Needs 058 (organization_settings_guard_nav),
-- 028 (archive_after_months), 012 (user_profiles_guard), 007 (the user_profiles admin policies) and 093 (admin_login_is_protected).
-- Touches no table's columns and no row except the quote-attachments bucket's public flag. Safe to run again.
-- ORDER: INDEPENDENT OF 099 AND 101: it reads, replaces or names none of their objects, so it applies on production as it is (095 and
-- 100, without 099 and 101) and in the full chain. The AI helper part of the review (S2/S3) is 103, which needs 101 and ships with it.
--
-- WHAT CHANGES.
--   a. Z4. organization_settings_guard_nav (058's body) also makes archive_after_months admin only: an office user could change when
--      finished records move to Archived straight through the API (004's UPDATE policy lets admin and office write the row). Every
--      existing check is kept exactly as 058 wrote it; the new one is in the same style (an INSERT is compared with 028's default, 12).
--   b. Z3. "Admins update org members" (007) let a company admin update the profile row of ANY login with any membership in their
--      company: switched-off rows, support (platform owner) rows and logins shared with another company included. It now needs
--      public.admin_may_edit_profile(id) (NEW, SECURITY DEFINER, signed-in only): the caller is an admin of the session company, the
--      person has a NON-SUPPORT membership there (switched off too: an admin still renames their own former staff), NO membership in
--      any other company (active or not), and is not a protected login (093's admin_login_is_protected: a platform owner, any support
--      membership). The same rule as the app's ownsIdentity and loginIsProtected (app/api/admin/users/route.ts). An admin's own row
--      stays theirs through 000's "Users update own profile".
--      "Admins read org members" (007) now needs public.admin_may_read_profile(id) (NEW, the same kind): 007's rule (a membership in
--      the session company, switched off too) minus protected logins (the platform owner's email and name) and minus logins shared with
--      another company (T2: their organization_id / organization are a stale copy that can name the other company).
--   c. T1. user_profiles_guard (012's body) refuses a change to another person's full_name, organization or workshop_email unless
--      every membership that person has is in the caller's session company (42501). Every other check is 012's, unchanged.
--   d. T3. The quote-attachments bucket is set private (001 created it private, but nothing ever forced it).
-- NOT CHANGED: no column-level REVOKE on user_profiles.organization_id / organization (T2's first idea): the app reads those columns
-- as the signed-in user on their own row (lib/use-user.ts PROFILE_COLUMNS, lib/server/auth.ts, app/api/send-job/route.ts), and a column
-- revoke can't be limited to other people's rows. T2 is closed by the read policy in (b) instead.
-- GUARD (section 1): the bodies 102 replaces must be the ones it was written against (or already 102's), compared without
-- whitespace. SELF-CHECK (section 5). Verify: supabase/verify/security_guards_102.sql (every row TRUE).
-- Rollback: supabase/release/102_security_guards.rollback.sql (puts 058's and 012's bodies and 007's policies back; drops
-- admin_may_edit_profile and admin_may_read_profile; the bucket stays private; Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 102 builds on is there, and each body it replaces is the one it was written against (or already 102's).
DO $$
BEGIN
  IF to_regprocedure('public.has_org_role(text[])') IS NULL OR to_regprocedure('public.current_user_organization_id()') IS NULL
     OR to_regprocedure('public.admin_login_is_protected(uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'organization_settings' AND column_name = 'archive_after_months') THEN
    RAISE EXCEPTION '102: a function or column it needs (028, 058, 093) is missing';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.organization_settings_guard_nav()'))
       NOT IN ('a3524f981c1f7b122d0935c837408d0d', '99579bb09f2fcf9458103b3128af20c8') THEN
    RAISE EXCEPTION '102: public.organization_settings_guard_nav is neither 058''s nor 102''s; stop and compare it first';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.user_profiles_guard()'))
       NOT IN ('4dd071f7e70fc10a633ad11f9f5c0180', '986ea8500279eb9724eae987797281a7') THEN
    RAISE EXCEPTION '102: public.user_profiles_guard is neither 012''s nor 102''s; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. Z4: only an admin changes archive_after_months. 058's body, plus that one check in the same style.
CREATE OR REPLACE FUNCTION public.organization_settings_guard_nav()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NEW.hidden_nav IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.hidden_nav ELSE '{}'::TEXT[] END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change hidden menu items';
    END IF;
    IF NEW.company_profile IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.company_profile ELSE '{}'::JSONB END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change the company profile';
    END IF;
    IF NEW.auto_convert_sales_orders IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.auto_convert_sales_orders ELSE TRUE END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change whether sales orders become jobs automatically' USING ERRCODE = '42501';
    END IF;
    IF NEW.archive_after_months IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.archive_after_months ELSE 12 END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change when finished records move to Archived' USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------------------------------
-- 3. Z3 and T1: which profiles a company admin may change, and what they may change on another person's.

-- TRUE only when the caller is an admin of the session company and p_user is one of that company's own people: a NON-SUPPORT
-- membership there (switched off too), no membership in any other company, and not a protected login (093: a platform owner, any
-- support membership).
-- Read in the policy below; definer because the caller can't see other companies' memberships or the platform owner list.
CREATE OR REPLACE FUNCTION public.admin_may_edit_profile(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_user IS NOT NULL
     AND public.has_org_role(ARRAY['admin'])
     AND EXISTS (SELECT 1 FROM public.organization_members m
                 WHERE m.user_id = p_user AND m.organization_id = public.current_user_organization_id() AND NOT m.support)
     AND NOT EXISTS (SELECT 1 FROM public.organization_members o
                     WHERE o.user_id = p_user AND o.organization_id IS DISTINCT FROM public.current_user_organization_id())
     AND NOT public.admin_login_is_protected(p_user)
$$;
REVOKE ALL ON FUNCTION public.admin_may_edit_profile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_may_edit_profile(UUID) TO authenticated;

-- TRUE only when the caller is an admin of the session company and p_user is that company's own person to list: a membership there
-- (switched off too, as 007), no membership in any other company, and not a protected login. A login shared with another company is
-- not listed (its organization_id / organization are a stale copy of whichever company it was created in: T2).
CREATE OR REPLACE FUNCTION public.admin_may_read_profile(p_user UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_user IS NOT NULL
     AND public.has_org_role(ARRAY['admin'])
     AND EXISTS (SELECT 1 FROM public.organization_members m
                 WHERE m.user_id = p_user AND m.organization_id = public.current_user_organization_id())
     AND NOT EXISTS (SELECT 1 FROM public.organization_members o
                     WHERE o.user_id = p_user AND o.organization_id IS DISTINCT FROM public.current_user_organization_id())
     AND NOT public.admin_login_is_protected(p_user)
$$;
REVOKE ALL ON FUNCTION public.admin_may_read_profile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_may_read_profile(UUID) TO authenticated;

DROP POLICY IF EXISTS "Admins update org members" ON public.user_profiles;
CREATE POLICY "Admins update org members" ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (public.admin_may_edit_profile(user_profiles.id))
  WITH CHECK (public.admin_may_edit_profile(user_profiles.id));

-- 007's rule, minus a protected login (the platform owner's, a support login) and a login shared with another company.
DROP POLICY IF EXISTS "Admins read org members" ON public.user_profiles;
CREATE POLICY "Admins read org members" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (public.admin_may_read_profile(user_profiles.id));

-- 012's body, plus (T1): another person's full_name, organization and workshop_email only when every membership they have is in the
-- caller's session company.
CREATE OR REPLACE FUNCTION public.user_profiles_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  m RECORD;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(current_setting('quoteflow.switching_org', TRUE), '') <> 'on' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'The profile id cannot be changed' USING ERRCODE = '42501';
    END IF;

    IF NEW.username IS DISTINCT FROM OLD.username THEN
      RAISE EXCEPTION 'Usernames are set by an administrator in Admin > Users' USING ERRCODE = '42501';
    END IF;

    IF NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
      RAISE EXCEPTION 'Password requirements are managed in Admin > Users' USING ERRCODE = '42501';
    END IF;

    IF OLD.id IS DISTINCT FROM auth.uid()
       AND (NEW.full_name IS DISTINCT FROM OLD.full_name OR NEW.organization IS DISTINCT FROM OLD.organization
            OR NEW.workshop_email IS DISTINCT FROM OLD.workshop_email)
       AND EXISTS (SELECT 1 FROM public.organization_members om
                   WHERE om.user_id = OLD.id AND om.organization_id IS DISTINCT FROM public.current_user_organization_id()) THEN
      RAISE EXCEPTION 'This person also uses their login with another company, so only they can change their name or e-mail settings' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_org_role(ARRAY['admin']) THEN
      IF NEW.email IS DISTINCT FROM OLD.email
         OR NEW.role IS DISTINCT FROM OLD.role
         OR NEW.secondary_role IS DISTINCT FROM OLD.secondary_role
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.active IS DISTINCT FROM OLD.active
         OR NEW.mfa_required IS DISTINCT FROM OLD.mfa_required THEN
        RAISE EXCEPTION 'Only admins can change role, organisation, status or email' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.active IS DISTINCT FROM OLD.active THEN
        RAISE EXCEPTION 'Use set_member_access to change access; the account-level switch is not editable here' USING ERRCODE = '42501';
      END IF;
      IF NEW.email IS DISTINCT FROM OLD.email AND OLD.id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'An admin cannot change another person''s e-mail' USING ERRCODE = '42501';
      END IF;
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        IF OLD.id IS DISTINCT FROM auth.uid() THEN
          RAISE EXCEPTION 'Only the person can switch their own current organisation' USING ERRCODE = '42501';
        END IF;
        SELECT mm.role, mm.secondary_role, o.name AS org_name INTO m
        FROM public.organization_members mm JOIN public.organizations o ON o.id = mm.organization_id
        WHERE mm.user_id = OLD.id AND mm.organization_id = NEW.organization_id AND mm.active AND o.status = 'active';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'The person is not an active member of that organisation' USING ERRCODE = '42501';
        END IF;
        NEW.role := m.role;
        NEW.secondary_role := m.secondary_role;
        NEW.organization := m.org_name;
      ELSIF NEW.role IS DISTINCT FROM OLD.role OR NEW.secondary_role IS DISTINCT FROM OLD.secondary_role THEN
        RAISE EXCEPTION 'Use set_member_access to change a role' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.user_profiles_guard() FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. T3: the quote-attachments bucket is private (as 001 created it; nothing forced it since).
DO $do$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    UPDATE storage.buckets SET public = FALSE WHERE id = 'quote-attachments' AND public IS DISTINCT FROM FALSE;
  END IF;
END
$do$;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check: each change above is in place.
DO $$
BEGIN
  IF position('archive_after_months' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.organization_settings_guard_nav()'))) = 0 THEN
    RAISE EXCEPTION '102: organization_settings_guard_nav does not check archive_after_months';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles' AND policyname = 'Admins update org members'
                   AND cmd = 'UPDATE' AND qual LIKE '%admin_may_edit_profile%' AND with_check LIKE '%admin_may_edit_profile%')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles' AND policyname = 'Admins read org members'
                      AND cmd = 'SELECT' AND qual LIKE '%admin_may_read_profile%') THEN
    RAISE EXCEPTION '102: the user_profiles admin policies are not 102''s';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public.admin_may_edit_profile(uuid)', 'public.admin_may_read_profile(uuid)']) AS f(sig)
             WHERE NOT coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p WHERE p.oid = to_regprocedure(f.sig)), FALSE)
                OR NOT has_function_privilege('authenticated', f.sig, 'EXECUTE') OR has_function_privilege('anon', f.sig, 'EXECUTE')) THEN
    RAISE EXCEPTION '102: admin_may_edit_profile or admin_may_read_profile is not definer, pinned and signed-in only';
  END IF;
  IF position('workshop_email' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.user_profiles_guard()'))) = 0 THEN
    RAISE EXCEPTION '102: user_profiles_guard does not check another person''s name and e-mail settings';
  END IF;
  IF to_regclass('storage.buckets') IS NOT NULL AND EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'quote-attachments' AND public) THEN
    RAISE EXCEPTION '102: the quote-attachments bucket is public';
  END IF;
END
$$;

COMMIT;

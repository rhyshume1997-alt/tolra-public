-- 102 rollback: ONLY with Rhys's approval. Puts back, byte for byte, 058's organization_settings_guard_nav, 012's user_profiles_guard
-- and 007's two user_profiles admin policies, and drops admin_may_edit_profile and admin_may_read_profile. The quote-attachments bucket
-- stays private (001 created it private; nothing needs it public). No row is changed. Touches nothing of 099, 101 or 103. Run the whole
-- text as one transaction, then the release preflight (marker 102 shows "not applied"). Rolling back reopens Z4, Z3, T2 and T1.
BEGIN;
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.organization_settings_guard_nav()'))
       NOT IN ('99579bb09f2fcf9458103b3128af20c8', 'a3524f981c1f7b122d0935c837408d0d') THEN
    RAISE EXCEPTION '102 rollback: organization_settings_guard_nav is neither 102''s nor 058''s; stop and compare';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.user_profiles_guard()'))
       NOT IN ('986ea8500279eb9724eae987797281a7', '4dd071f7e70fc10a633ad11f9f5c0180') THEN
    RAISE EXCEPTION '102 rollback: user_profiles_guard is neither 102''s nor 012''s; stop and compare';
  END IF;
END
$$;

-- 058's organization_settings_guard_nav, verbatim (supabase/migrations/058_quote_to_job.sql).
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
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 007's two policies, verbatim (supabase/migrations/007_tenant_onboarding.sql); then 102's two helpers go.
DROP POLICY IF EXISTS "Admins read org members" ON public.user_profiles;
DROP POLICY IF EXISTS "Admins update org members" ON public.user_profiles;

CREATE POLICY "Admins read org members" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (public.has_org_role(ARRAY['admin'])
         AND EXISTS (SELECT 1 FROM public.organization_members m
                     WHERE m.user_id = user_profiles.id AND m.organization_id = public.current_user_organization_id()));

CREATE POLICY "Admins update org members" ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (public.has_org_role(ARRAY['admin'])
         AND EXISTS (SELECT 1 FROM public.organization_members m
                     WHERE m.user_id = user_profiles.id AND m.organization_id = public.current_user_organization_id()))
  WITH CHECK (public.has_org_role(ARRAY['admin'])
         AND EXISTS (SELECT 1 FROM public.organization_members m
                     WHERE m.user_id = user_profiles.id AND m.organization_id = public.current_user_organization_id()));

DROP FUNCTION IF EXISTS public.admin_may_edit_profile(UUID);
DROP FUNCTION IF EXISTS public.admin_may_read_profile(UUID);

-- 012's user_profiles_guard, verbatim (supabase/migrations/012_user_management.sql).
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

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.organization_settings_guard_nav()')) <> 'a3524f981c1f7b122d0935c837408d0d'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.user_profiles_guard()')) <> '4dd071f7e70fc10a633ad11f9f5c0180' THEN
    RAISE EXCEPTION '102 rollback: a function body is not back to its 058 or 012 version';
  END IF;
  IF to_regprocedure('public.admin_may_edit_profile(uuid)') IS NOT NULL
     OR to_regprocedure('public.admin_may_read_profile(uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles'
                  AND (qual LIKE '%admin_may_edit_profile%' OR qual LIKE '%admin_may_read_profile%')) THEN
    RAISE EXCEPTION '102 rollback: a helper or a policy is not back to 007''s';
  END IF;
END
$$;
COMMIT;

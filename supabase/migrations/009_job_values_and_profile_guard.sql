-- =====================================================================================================
-- 009: JOB PRICES OUT OF REACH OF THE WORKSHOP + PROFILE GUARD
--
-- 1. jobs.value (the order value) was readable and writable by every role that can open the job board,
--    including workshop and viewer: RLS works per row, not per column. The value moves to job_values, which only
--    admin and office can read or change. Existing values are copied over, then jobs.value is dropped.
-- 2. An admin could switch another person's CURRENT organisation (user_profiles.organization_id) to any other
--    organisation that person belongs to. Now only the person can switch their own (switch_organization() is
--    the normal path and is unaffected).
--
-- Run after 008. Then re-run supabase/import/import_legacy_tenant.sql: the import now writes job values to
-- job_values. Safe to re-run.
-- =====================================================================================================

-- ----- 1. job_values ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_values (
  job_id          UUID PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  value           NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- security_audit.log_row_change() records NEW.id / OLD.id, so give the table an id (always equal to job_id).
ALTER TABLE public.job_values ADD COLUMN IF NOT EXISTS id UUID GENERATED ALWAYS AS (job_id) STORED;
CREATE INDEX IF NOT EXISTS job_values_org_idx ON public.job_values (organization_id);

-- The organisation always comes from the job itself, so a value can never be attached across organisations.
CREATE OR REPLACE FUNCTION public.job_values_set_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  SELECT j.organization_id INTO NEW.organization_id FROM public.jobs j WHERE j.id = NEW.job_id;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'Job % not found', NEW.job_id USING ERRCODE = '23503';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.job_values_set_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS job_values_set_org ON public.job_values;
CREATE TRIGGER job_values_set_org BEFORE INSERT OR UPDATE ON public.job_values
  FOR EACH ROW EXECUTE FUNCTION public.job_values_set_org();

ALTER TABLE public.job_values ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_values FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_values TO authenticated;

DROP POLICY IF EXISTS "job_values select" ON public.job_values;
DROP POLICY IF EXISTS "job_values insert" ON public.job_values;
DROP POLICY IF EXISTS "job_values update" ON public.job_values;
DROP POLICY IF EXISTS "job_values delete" ON public.job_values;
CREATE POLICY "job_values select" ON public.job_values FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
CREATE POLICY "job_values insert" ON public.job_values FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
CREATE POLICY "job_values update" ON public.job_values FOR UPDATE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']))
  WITH CHECK (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
CREATE POLICY "job_values delete" ON public.job_values FOR DELETE TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));

DROP TRIGGER IF EXISTS audit_job_values_changes ON public.job_values;
CREATE TRIGGER audit_job_values_changes AFTER INSERT OR UPDATE OR DELETE ON public.job_values
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();

-- Copy existing values, then remove the column the workshop could read.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'value') THEN
    INSERT INTO public.job_values (job_id, organization_id, value)
    SELECT id, organization_id, value FROM public.jobs WHERE value IS NOT NULL
    ON CONFLICT (job_id) DO NOTHING;
    ALTER TABLE public.jobs DROP COLUMN value;
  END IF;
END
$do$;

-- ----- 2. user_profiles guard: only you switch your own current organisation ------------------------
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

-- Check: expect jobs_value_column = 0, job_values_policies = 4.
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'value') AS jobs_value_column,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_values') AS job_values_policies,
  (SELECT count(*) FROM public.job_values) AS job_values_rows;

-- Release 170 proposal (module K, the worksheet builder; number 170 allocated by Rhys; NOT yet a numbered phase in supabase/release-plan.json).
-- Canonical source of supabase/release/170_worksheet_custom.release.sql (its body between "-- ---- BODY ----" lines is this file's, verbatim; a unit
-- test fails if they drift). Adds ONE column and ONE guard so a company's own custom worksheet fields (custom tick boxes, custom text fields and
-- extra checklist items) are stored per job WITHOUT touching any existing job data:
--   public.jobs.worksheet_custom jsonb NOT NULL DEFAULT '{}' (an object, at most 20000 characters; every existing job gets {}).
--   public.jobs_worksheet_custom_lock(): a browser session (anon or authenticated; the service role, the owner and the SQL editor are exempt)
--   may not change worksheet_custom of a job whose CURRENT revision (jobs.worksheet_version) has a primary sign-off. A signed-off worksheet never
--   changes (refusal 42501, hint signed_off_custom_locked). A job edited since its sign-off (a newer revision, no sign-off yet) can be changed.
-- It does NOT: change any other column, row, function, trigger, policy or grant; add the column to jobs_worksheet_version's watched list (so a custom
-- value never raises the worksheet revision, withdraws an inspection pass or stales a sign-off) or to the sign-off snapshot; gate anything (the app
-- is flag-gated and treats a missing column as "not available yet"); touch AI, e-mail or Xero.
-- Rollback: supabase/release/170_worksheet_custom.rollback.sql drops the trigger, the function, the constraint and the column. Values saved in the
-- column are lost by the rollback (they exist nowhere else); take a backup first if any were saved.
-- Needs: public.jobs (with worksheet_version, job_no) and public.job_signoffs (release 045 and the migrations before it).
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS worksheet_custom JSONB NOT NULL DEFAULT '{}'::JSONB;
DO $p170_constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.jobs'::regclass AND k.conname = 'jobs_worksheet_custom_shape') THEN
    ALTER TABLE public.jobs ADD CONSTRAINT jobs_worksheet_custom_shape CHECK (jsonb_typeof(worksheet_custom) = 'object' AND octet_length(worksheet_custom::TEXT) <= 20000);
  END IF;
END
$p170_constraint$;

CREATE OR REPLACE FUNCTION public.jobs_worksheet_custom_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Browser sessions only (like 034 and 157): the service role, the owner and the SQL editor are exempt.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF NEW.worksheet_custom IS DISTINCT FROM OLD.worksheet_custom
     AND EXISTS (SELECT 1 FROM public.job_signoffs s WHERE s.job_id = OLD.id AND s.kind = 'primary' AND s.worksheet_version = OLD.worksheet_version) THEN
    RAISE EXCEPTION 'Job %: the worksheet is signed off, so its custom fields cannot be changed.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'signed_off_custom_locked';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_worksheet_custom_lock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS jobs_worksheet_custom_lock ON public.jobs;
CREATE TRIGGER jobs_worksheet_custom_lock BEFORE UPDATE OF worksheet_custom ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_worksheet_custom_lock();

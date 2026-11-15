-- =====================================================================================================
-- p157 (post-144 release 157, after 156 in supabase/release-plan.json; 155 is reserved for AI credentials and not in this candidate):
-- jobs_integrity_guard. One trigger function and one trigger on public.jobs that close four confirmed defects for BROWSER sessions
-- (anon, authenticated; also inside definer functions, as for 034's, 037's and 081's job locks):
--   C1  a recorded start time (jobs.started_at) could be replaced or cleared by editing the job. Who started it (jobs.started_by)
--       was replaced or blanked with it.
--   C2  a workshop-only user could withdraw a passed inspection (and move a Complete job back to Awaiting inspection) just by editing
--       the worksheet or the stage; the same on a despatched or invoiced job (P1).
--   C3  a workshop-only user could change a job's customer or job number (P2).
--   C4  a finish time (jobs.finished_at) could be set by editing the job, including a back-dated one, without the Finish workflow.
-- PROPOSAL ONLY. Not applied anywhere hosted. Packaged verbatim (the body inside its transaction) into
-- supabase/release/157_jobs_integrity_guard.release.sql, which adds the guard (the 034, 035, 037, 044/061, 081 and 083 job
-- objects in place), a before/after fingerprint of everything else on jobs and the self-check. Migration allowed for exactly the
-- 157 files, for development, scratch and CI; nothing in production or in a hosted project (PM, 15 Nov 2026).
-- Verify: supabase/verify/jobs_integrity_guard_157.sql (every row true).
-- Rollback: supabase/release/157_jobs_integrity_guard.rollback.sql (drops the trigger and the function; touches no row).
--
-- INPUTS: none (one new function and one new trigger). OUTPUTS: public.jobs_integrity_guard() and the trigger
--   jobs_zzz_integrity_guard on public.jobs. The trigger only REFUSES (SQLSTATE 42501, with a HINT); it never widens a permission and
--   never changes a row.
-- WHEN IT RUNS: BEFORE UPDATE ... FOR EACH ROW, not column-limited. PostgreSQL fires BEFORE row triggers in byte order of their
--   names, so jobs_zzz_integrity_guard runs AFTER jobs_worksheet_version (022), jobs_worksheet_version_release (034: when the
--   worksheet changes on an inspected job it has already set inspected_at and inspected_by to NULL and moved stage complete to
--   inspection) and jobs_zz_drawing_revision (083), and BEFORE zzz_actor_stamp (035). So it sees the row the other locks have settled.
-- WHO: the service role, the database owner, the SQL editor and imports are exempt (the same test as 034's jobs_release_guard).
--   Admin and office are not touched by C2 or C3.
-- RULES (each refuses with ERRCODE 42501):
--   C1  started_at: once set it can't be changed or cleared (HINT start_kept). The first set from empty stays allowed. finish_job
--       (coalesce(started_at, ...)) and start_machine_run (sets it only while empty) are unaffected.
--       WHO STARTED IT: jobs.started_by is the actor column of started_at (035). aa_actor_keep keeps it at its old value on every
--       browser update and zzz_actor_stamp rewrites it only when started_at itself moves. Protecting started_at therefore protects
--       the starter's name as well; no other column is protected.
--   C4  finished_at: an update that sets it from empty is refused unless the statement runs inside finish_job (which sets
--       tolra.finish_job to 'on' around its own update; HINT finish_via_rpc). Clearing it stays governed by 081's ad_finish_kept and
--       reopen_job, not repeated here.
--   C3  customer, job_no: refused for a workshop-only user, alone or inside a wider update (HINT job_identity_office). Workshop-only
--       is has_org_role(['workshop']) AND NOT has_org_role(['admin','office']), the test reopen_job (081) uses.
--   C2  a workshop-only user can't withdraw a passed inspection: the update is refused when OLD.inspected_at is set and NEW.inspected_at
--       is empty (this is how a worksheet edit shows up after 034's jobs_release_guard ran), or when OLD.stage is 'complete' and
--       NEW.stage is not (HINT inspection_kept), UNLESS an authorised workflow names this job in quoteflow.job_inspection (034, 037:
--       record_job_inspection, fail_job_inspection, open_replacement_rework, finish_job_rework), quoteflow.job_rework (037) or
--       quoteflow.job_reopen (081 reopen_job, 113 _reopen_job_signed_off). inspect_job (083) sets none of them itself and reaches
--       them through the functions it calls. An office or admin edit of a Complete job still withdraws the pass as before.
-- DRAWING REVISION: a workshop-only person can never reach C2 through job_files_revision_change (034: a drawing attached with a revision
--   re-saves the job, which counts as a worksheet change): job_files_guard (034) lets only an admin attach or set a revision, and
--   set_job_drawing_revision (083) refuses a Complete job for everyone. The admin path is unchanged by 157 (it still withdraws the pass).
-- MUST NOT CHANGE: any existing function, trigger, grant, RLS policy or row; any RPC permission; company isolation. The grants of the
--   new function: callable by no API role (REVOKE ALL FROM PUBLIC, anon, authenticated).
-- BEHAVIOUR CHANGE FOR WORKSHOP USERS: editing the worksheet, the stage, the customer or the job number of a job that has passed
--   inspection is now refused (it used to withdraw the pass). Re-inspection, rework and reopen work as before.
-- =====================================================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.jobs_integrity_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job BOOLEAN;
BEGIN
  -- 157 jobs_integrity_guard (marker; the release guard and the verify script recognise this body by it and by its checksum).
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- C1: a recorded start is kept; the first Start (from empty) is allowed.
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'Job %: its start time is kept as it was recorded and can''t be changed or cleared.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'start_kept';
  END IF;
  -- C4: a finish time is set only by finish_job, which names itself in tolra.finish_job for its own statement.
  IF OLD.finished_at IS NULL AND NEW.finished_at IS NOT NULL AND coalesce(current_setting('tolra.finish_job', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION 'Job %: finish it from the Job Board (Finish); the finish time can''t be set by editing the job.', OLD.job_no
      USING ERRCODE = '42501', HINT = 'finish_via_rpc';
  END IF;
  -- C3 and C2 concern a workshop-only user (admin and office are unchanged). The role lookup runs only when one of them applies.
  IF NEW.customer IS DISTINCT FROM OLD.customer OR NEW.job_no IS DISTINCT FROM OLD.job_no
     OR (OLD.inspected_at IS NOT NULL AND NEW.inspected_at IS NULL) OR (OLD.stage = 'complete' AND NEW.stage IS DISTINCT FROM 'complete') THEN
    IF public.has_org_role(ARRAY['workshop']) AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
      IF NEW.customer IS DISTINCT FROM OLD.customer OR NEW.job_no IS DISTINCT FROM OLD.job_no THEN
        RAISE EXCEPTION 'Job %: only admin and office staff change a job''s customer or job number.', OLD.job_no
          USING ERRCODE = '42501', HINT = 'job_identity_office';
      END IF;
      v_job := current_setting('quoteflow.job_inspection', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT
            OR current_setting('quoteflow.job_rework', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT
            OR current_setting('quoteflow.job_reopen', TRUE) IS NOT DISTINCT FROM NEW.id::TEXT;
      IF NOT v_job THEN
        RAISE EXCEPTION 'Job %: its passed inspection is withdrawn only by the office or an admin, or by recording a failed inspection, raising rework or reopening the job.', OLD.job_no
          USING ERRCODE = '42501', HINT = 'inspection_kept';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_integrity_guard() FROM PUBLIC, anon, authenticated;

-- One trigger, created once (running this again changes nothing). Its name sorts after jobs_zz_drawing_revision and before zzz_actor_stamp.
DO $p157_trigger$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal) THEN
    CREATE TRIGGER jobs_zzz_integrity_guard BEFORE UPDATE ON public.jobs
      FOR EACH ROW EXECUTE FUNCTION public.jobs_integrity_guard();
  END IF;
END
$p157_trigger$;

COMMIT;

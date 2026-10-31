-- 117 rollback: ONLY with Rhys's approval. Removes the job problem reports: the two functions and the table (with its policy, triggers and indexes).
-- The reports themselves are lost (nothing else reads them); the named events already written to the job's history (REPORT_JOB_PROBLEM,
-- RESOLVE_JOB_PROBLEM) and the table's row audit entries stay in security_audit.audit_log, which nothing can edit. 117 replaced no existing
-- object, so nothing else is touched. The app then hides every Problem control and the Needs attention rule shows nothing (the table is missing).
-- Run the whole text as one transaction, then the release preflight (marker 117 shows "not applied").
BEGIN;

DROP FUNCTION IF EXISTS public.report_job_problem(UUID, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.resolve_job_problem(UUID, TEXT);
DROP TABLE IF EXISTS public.job_problems;

DO $$
BEGIN
  IF to_regclass('public.job_problems') IS NOT NULL
     OR to_regprocedure('public.report_job_problem(uuid,text,text,uuid)') IS NOT NULL
     OR to_regprocedure('public.resolve_job_problem(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '117 rollback: the job problem reports are still there';
  END IF;
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION '117 rollback: the jobs table is missing';
  END IF;
END
$$;

COMMIT;

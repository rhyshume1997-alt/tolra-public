-- 118 rollback: ONLY with Rhys's approval. Removes the parts-done log: the two functions and the table (with its policy, triggers and indexes).
-- The logged counts are lost (nothing else reads them); the named events already written to the job's history (LOG_JOB_PARTS) and the table's
-- row audit entries stay in security_audit.audit_log, which nothing can edit. 118 replaced no existing object, so nothing else is touched. The app
-- then hides every parts control and "N of M" (the table is missing).
-- Run the whole text as one transaction, then the release preflight (marker 118 shows "not applied").
BEGIN;

DROP FUNCTION IF EXISTS public.log_job_parts(UUID, INTEGER, TEXT, UUID);
DROP FUNCTION IF EXISTS public.job_parts_done(UUID[]);
DROP TABLE IF EXISTS public.job_part_logs;

DO $$
BEGIN
  IF to_regclass('public.job_part_logs') IS NOT NULL
     OR to_regprocedure('public.log_job_parts(uuid,integer,text,uuid)') IS NOT NULL
     OR to_regprocedure('public.job_parts_done(uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION '118 rollback: the parts-done log is still there';
  END IF;
  IF to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION '118 rollback: the jobs table is missing';
  END IF;
END
$$;

COMMIT;

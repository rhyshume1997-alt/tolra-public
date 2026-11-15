-- Read only: after release 157 (jobs integrity guard; registered in supabase/release-plan.json as phase 157, after 156), every row must say true. Proves:
-- the trigger function is 157's (invoker, search_path pinned, callable by no API role); the trigger is the BEFORE UPDATE row trigger without a column list
-- and sorts after 022's, 034's and 083's job triggers and before 035's actor stamp; the job locks it relies on are all still there and the workflows still
-- name the flags it reads (tolra.finish_job, quoteflow.job_inspection, quoteflow.job_rework, quoteflow.job_reopen); release preflight's 157 marker holds.
-- Whether it refuses and allows what it should is proved by tests/db/jobs-integrity-157.test.ts, not here (this script reads the catalogue only).
SELECT 'function: public.jobs_integrity_guard() is 157''s trigger function (checksum), invoker, search_path pinned' AS check_name,
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '4a6399c2cd5da6c05e455be32bca8c89'
            AND p.prorettype = 'trigger'::regtype AND NOT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']) AS ok
UNION ALL SELECT 'function: public.jobs_integrity_guard() is callable by no API role (PUBLIC, anon, authenticated)',
  to_regprocedure('public.jobs_integrity_guard()') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()') AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))))
UNION ALL SELECT 'trigger: jobs_zzz_integrity_guard is the enabled BEFORE UPDATE row trigger on public.jobs without a column list, running jobs_integrity_guard()',
  EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal
            AND t.tgfoid = to_regprocedure('public.jobs_integrity_guard()') AND t.tgtype = 19 AND t.tgattr::TEXT = '' AND t.tgnargs = 0 AND t.tgenabled = 'O' AND t.tgqual IS NULL)
UNION ALL SELECT 'order: it fires after jobs_worksheet_version, jobs_worksheet_version_release and jobs_zz_drawing_revision and before zzz_actor_stamp (byte order of the names)',
  (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND NOT t.tgisinternal AND t.tgtype & 19 = 19
     AND t.tgname IN ('jobs_worksheet_version', 'jobs_worksheet_version_release', 'jobs_zz_drawing_revision', 'zzz_actor_stamp', 'jobs_zzz_integrity_guard')) = 5
  AND 'jobs_worksheet_version' COLLATE "C" < 'jobs_zzz_integrity_guard' AND 'jobs_worksheet_version_release' COLLATE "C" < 'jobs_zzz_integrity_guard'
  AND 'jobs_zz_drawing_revision' COLLATE "C" < 'jobs_zzz_integrity_guard' AND 'jobs_zzz_integrity_guard' COLLATE "C" < 'zzz_actor_stamp'
UNION ALL SELECT 'locks: the other job triggers it sits beside are all still in place (022, 034, 035, 037, 044, 081, 083)',
  (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND NOT t.tgisinternal
     AND t.tgname IN ('jobs_worksheet_version', 'jobs_worksheet_version_release', 'jobs_zz_drawing_revision', 'zzz_actor_stamp', 'ad_finish_kept', 'ac_finish_guard', 'jobs_rework_stage_guard')) = 7
UNION ALL SELECT 'flags: finish_job names tolra.finish_job; the inspection, rework and reopen workflows name quoteflow.job_inspection, quoteflow.job_rework and quoteflow.job_reopen',
  (SELECT count(*) = 7 FROM (VALUES
     ('finish_job', 'tolra.finish_job'), ('reopen_job', 'quoteflow.job_reopen'), ('_reopen_job_signed_off', 'quoteflow.job_reopen'),
     ('record_job_inspection', 'quoteflow.job_inspection'), ('fail_job_inspection', 'quoteflow.job_inspection'),
     ('open_replacement_rework', 'quoteflow.job_rework'), ('finish_job_rework', 'quoteflow.job_rework')) AS f(fn, flag)
   WHERE EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = f.fn AND position(f.flag IN p.prosrc) > 0))
UNION ALL SELECT 'marker: release preflight''s "post-144 marker 157 jobs_integrity_guard" condition holds',
  coalesce((EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()') AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '4a6399c2cd5da6c05e455be32bca8c89')
      AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal
                    AND t.tgfoid = to_regprocedure('public.jobs_integrity_guard()') AND t.tgtype = 19 AND t.tgattr::TEXT = '' AND t.tgnargs = 0 AND t.tgenabled = 'O' AND t.tgqual IS NULL)), FALSE);

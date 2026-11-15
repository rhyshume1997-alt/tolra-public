-- Rollback of release step 157 (jobs integrity guard). One transaction.
-- Drops the trigger jobs_zzz_integrity_guard from public.jobs and the function public.jobs_integrity_guard(). No row is touched; no other function,
-- trigger, grant or policy is touched (a before/after fingerprint must be identical). Running it twice equals running it once. After it, the four
-- defects (a start time that can be replaced or cleared by editing the job, a finish time that can be set by editing the job, a workshop-only user
-- changing a job's customer or number, and a workshop-only user withdrawing a passed inspection) are open again.
-- Refuses, changing nothing, if a function named jobs_integrity_guard or a trigger named jobs_zzz_integrity_guard exists and is not 157's (stop and
-- compare it first).
BEGIN;
DO $rollback_guard$
DECLARE
  v TEXT;
BEGIN
 IF to_regprocedure('public.jobs_integrity_guard()') IS NOT NULL THEN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_integrity_guard()');
  IF v IS DISTINCT FROM '4a6399c2cd5da6c05e455be32bca8c89' THEN
   RAISE EXCEPTION '157 rollback: public.jobs_integrity_guard() is not 157''s; stop and compare it first';
  END IF;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal)
    AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.jobs') AND t.tgname = 'jobs_zzz_integrity_guard' AND NOT t.tgisinternal
                      AND t.tgfoid = to_regprocedure('public.jobs_integrity_guard()') AND t.tgtype = 19 AND t.tgattr::TEXT = '' AND t.tgnargs = 0
                      AND t.tgenabled = 'O' AND t.tgqual IS NULL) THEN
  RAISE EXCEPTION '157 rollback: a trigger named jobs_zzz_integrity_guard exists on public.jobs and is not 157''s; stop and compare it first';
 END IF;
END $rollback_guard$;

-- Before: the same fingerprint the release takes (the other triggers on jobs, its policies, grants and row security, every other function in public).
CREATE FUNCTION pg_temp.p157_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p157fp$
  SELECT 'jobs triggers'::TEXT, md5(coalesce(string_agg(t.tgname || ' ' || pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::TEXT, E'\n' ORDER BY t.tgname COLLATE "C"), ''))
  FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND NOT t.tgisinternal AND t.tgname <> 'jobs_zzz_integrity_guard'
  UNION ALL SELECT 'jobs policies', md5(coalesce(string_agg(p.polname::TEXT || ' ' || p.polcmd::TEXT || ' ' || p.polpermissive::TEXT || ' ' || p.polroles::TEXT || ' '
                                                           || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), E'\n' ORDER BY p.polname COLLATE "C"), ''))
  FROM pg_policy p WHERE p.polrelid = 'public.jobs'::regclass
  UNION ALL SELECT 'jobs grants and row security', md5(coalesce((SELECT c.relacl::TEXT FROM pg_class c WHERE c.oid = 'public.jobs'::regclass), '') || '|'
                                                    || (SELECT c.relrowsecurity::TEXT || c.relforcerowsecurity::TEXT FROM pg_class c WHERE c.oid = 'public.jobs'::regclass) || '|'
                                                    || coalesce((SELECT string_agg(a.attname::TEXT || ':' || a.attacl::TEXT, ',' ORDER BY a.attname COLLATE "C") FROM pg_attribute a
                                                                 WHERE a.attrelid = 'public.jobs'::regclass AND a.attacl IS NOT NULL), ''))
  UNION ALL SELECT 'public functions', md5(coalesce(string_agg(p.oid::regprocedure::TEXT || ' ' || md5(p.prosrc) || ' ' || p.prosecdef::TEXT || ' ' || coalesce(p.proacl::TEXT, '') || ' '
                                                              || coalesce(p.proconfig::TEXT, ''), E'\n' ORDER BY p.oid::regprocedure::TEXT COLLATE "C"), ''))
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'jobs_integrity_guard'
$p157fp$;
CREATE TEMP TABLE p157_before ON COMMIT DROP AS SELECT * FROM pg_temp.p157_fingerprint();

DROP TRIGGER IF EXISTS jobs_zzz_integrity_guard ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_integrity_guard();

DO $rollback_self_check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_zzz_integrity_guard')
     OR to_regprocedure('public.jobs_integrity_guard()') IS NOT NULL THEN
    RAISE EXCEPTION '157 rollback self-check: the trigger jobs_zzz_integrity_guard and the function public.jobs_integrity_guard() must be gone';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p157_before EXCEPT SELECT * FROM pg_temp.p157_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p157_fingerprint() EXCEPT SELECT * FROM pg_temp.p157_before) THEN
    RAISE EXCEPTION '157 rollback self-check: another trigger, policy or grant on jobs, or another function in public, changed';
  END IF;
END
$rollback_self_check$;
DROP TABLE pg_temp.p157_before;
DROP FUNCTION pg_temp.p157_fingerprint();
COMMIT;

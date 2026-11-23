-- Rollback of release 170 (supabase/release/170_worksheet_custom.release.sql). Drops ONLY the four objects 170 added: the trigger
-- jobs_worksheet_custom_lock, the function public.jobs_worksheet_custom_lock(), the constraint jobs_worksheet_custom_shape and the column
-- public.jobs.worksheet_custom. Every other column and row of jobs is exactly as before 170. REFUSES, changing nothing, while any job holds a custom
-- worksheet value (anything other than {}): those values exist nowhere else and this file never deletes records. To go back while values exist, switch the
-- worksheet builder off for the company (the layouts stay as they are) or have Rhys decide on an export first. After the rollback the app treats the column
-- as missing ("not available yet") and the builder's custom fields can no longer be saved (printing and everything else are unaffected).
-- STATE: ABSENT (none of the four objects: nothing to do, nothing is changed), INSTALLED as 170 left it (the four objects are dropped), DRIFTED (any of
-- them present but not exactly 170's: REFUSES, changes nothing).
-- The self-check compares the same fingerprint as the release before and after and requires the four objects gone. Inputs: the database. Outputs:
-- four objects removed. Must not change: anything else. Production only with Rhys's separate yes.
BEGIN;
DO $rollback_guard$
DECLARE
  v_col BOOLEAN;
  v_fun BOOLEAN;
  v_trg BOOLEAN;
BEGIN
 SELECT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = 'worksheet_custom') INTO v_col;
 SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'jobs_worksheet_custom_lock') INTO v_fun;
 SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_worksheet_custom_lock') INTO v_trg;
 IF v_col THEN
  -- Only planned when the column exists (a plain AND would plan the query, and fail, on a database that is already rolled back).
  IF EXISTS (SELECT 1 FROM public.jobs j WHERE j.worksheet_custom <> '{}'::jsonb) THEN
   RAISE EXCEPTION '170 rollback: % job(s) hold custom worksheet values; they exist nowhere else and this file never deletes records, so nothing was changed (switch the worksheet builder off instead, or have Rhys decide on an export first)', (SELECT count(*) FROM public.jobs j WHERE j.worksheet_custom <> '{}'::jsonb);
  END IF;
 END IF;
 IF v_fun AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.jobs_worksheet_custom_lock()') AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'a7d2d5df942ae0fc369d15d7bd7ee21c') THEN
  RAISE EXCEPTION '170 rollback: public.jobs_worksheet_custom_lock is not 170''s (body, security, search_path or argument list differ); stop and compare it first, nothing was changed';
 END IF;
 IF v_col AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = 'worksheet_custom'
                   AND c.data_type = 'jsonb' AND c.is_nullable = 'NO' AND c.column_default = '''{}''::jsonb') THEN
  RAISE EXCEPTION '170 rollback: jobs.worksheet_custom is not 170''s (type, nullability or default differ); stop and compare it first, nothing was changed';
 END IF;
 IF v_trg AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_worksheet_custom_lock' AND t.tgfoid = to_regprocedure('public.jobs_worksheet_custom_lock()')) THEN
  RAISE EXCEPTION '170 rollback: the jobs_worksheet_custom_lock trigger is not 170''s; stop and compare it first, nothing was changed';
 END IF;
END $rollback_guard$;

CREATE FUNCTION pg_temp.p170_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p170fp$
  SELECT 'every other function (name, args, security, config, body, grants)'::TEXT,
         md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), p.prosecdef::TEXT, coalesce(p.proconfig::TEXT, ''), md5(p.prosrc), coalesce(p.proacl::TEXT, ''))), '' ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), ''))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND NOT (n.nspname = 'public' AND p.proname = 'jobs_worksheet_custom_lock')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 'jobs: every column except worksheet_custom',
         md5(coalesce(string_agg(concat_ws('|', c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.ordinal_position), ''))
  FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name <> 'worksheet_custom'
  UNION ALL SELECT 'jobs: every constraint except 170''s',
         md5(coalesce(string_agg(concat_ws('|', k.conname, pg_catalog.pg_get_constraintdef(k.oid)), ';' ORDER BY k.conname), ''))
  FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.jobs'::regclass AND k.conname <> 'jobs_worksheet_custom_shape'
  UNION ALL SELECT 'jobs: every trigger except 170''s',
         md5(coalesce(string_agg(concat_ws('|', t.tgname, t.tgenabled::TEXT, pg_catalog.pg_get_triggerdef(t.oid)), ';' ORDER BY t.tgname), ''))
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.jobs'::regclass AND t.tgname <> 'jobs_worksheet_custom_lock'
  UNION ALL SELECT 'jobs: policies, row security, owner, grants',
         md5(coalesce((SELECT string_agg(concat_ws('|', p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, '')), ';' ORDER BY p.policyname) FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'jobs'), ''))
         || '|' || (SELECT c.relrowsecurity::TEXT || '|' || c.relforcerowsecurity::TEXT || '|' || c.relowner::regrole::TEXT || '|' || coalesce(c.relacl::TEXT, '') FROM pg_catalog.pg_class c WHERE c.oid = 'public.jobs'::regclass)
  UNION ALL SELECT 'jobs rows (every column except worksheet_custom)', md5(coalesce(string_agg((to_jsonb(j) - 'worksheet_custom')::TEXT, ';' ORDER BY j.id), ''))
  FROM public.jobs j
$p170fp$;
CREATE TEMP TABLE p170_before ON COMMIT DROP AS SELECT * FROM pg_temp.p170_fingerprint();

DROP TRIGGER IF EXISTS jobs_worksheet_custom_lock ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_worksheet_custom_lock();
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_worksheet_custom_shape;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS worksheet_custom;

DO $p170_rollback_check$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = 'worksheet_custom')
     OR to_regprocedure('public.jobs_worksheet_custom_lock()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.jobs'::regclass AND k.conname = 'jobs_worksheet_custom_shape')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_worksheet_custom_lock') THEN
    RAISE EXCEPTION '170 rollback self-check: one of the four objects is still there';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p170_before EXCEPT SELECT * FROM pg_temp.p170_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p170_fingerprint() EXCEPT SELECT * FROM pg_temp.p170_before) THEN
    RAISE EXCEPTION '170 rollback self-check: another function, a jobs column, constraint, trigger, policy or grant, or a jobs row changed';
  END IF;
END
$p170_rollback_check$;
DROP TABLE pg_temp.p170_before;
DROP FUNCTION pg_temp.p170_fingerprint();
COMMIT;

-- Post-144 release step 170 (module K, the worksheet builder: a company's own custom worksheet fields; registered in supabase/release-plan.json as phase 170,
-- after 167; CI's post-144 step installs it). Number 170 allocated by Rhys; promoted from proposal with his approval for go-live. One transaction; never part
-- of baseline replay. Not applied anywhere hosted: production only with Rhys's separate yes on this exact file after a fresh backup. Canonical source:
-- supabase/proposals/p170_worksheet_custom.sql (its body between BEGIN; and COMMIT; is copied below verbatim; scripts/check-release-plan.mjs fails if they drift).
-- WHAT IT DOES: adds public.jobs.worksheet_custom (jsonb, NOT NULL, default '{}', an object of at most 20000 characters; every existing job gets {}),
-- and public.jobs_worksheet_custom_lock() with its BEFORE UPDATE OF worksheet_custom trigger: a browser session cannot change worksheet_custom of a job
-- whose current revision has a primary sign-off (42501, hint signed_off_custom_locked). The worksheet builder is off by default in the app and treats a
-- missing column as "not available yet".
-- WHAT IT DOES NOT DO: change any existing column, row, other function, trigger, policy or grant; it does not add the column to jobs_worksheet_version's
-- watched fields (a custom value never raises the revision, withdraws a pass or stales a sign-off) or to the sign-off snapshot.
-- HOW IT BEHAVES: SECURITY DEFINER with search_path pg_catalog, public (only so the guard can see job_signoffs for a workshop session; it answers
-- nothing, names nothing); EXECUTE revoked from PUBLIC, anon and authenticated (it is a trigger function). Browser sessions (anon, authenticated) only;
-- the service role, the owner and the SQL editor are exempt.
-- STATE: ABSENT (no worksheet_custom column, no 170 constraint, function or trigger): the release applies. INSTALLED (all four exactly as below): running
-- again changes nothing. DRIFTED (any of them present but not exactly 170's): the file REFUSES with a message and changes nothing.
-- The self-check compares a fingerprint of everything else (every other function with grants, every other jobs column, constraint, trigger, policy and
-- grant, and every jobs row except the new column) before and after, and requires the new objects exactly as below.
-- Verify: supabase/verify/worksheet_custom_170.sql (every row true). Rollback: supabase/release/170_worksheet_custom.rollback.sql (drops only the four new
-- objects; REFUSES while any job holds a custom value, so no record is deleted). Behavioural proof: tests/db/worksheet-custom-170.test.ts (Supabase stack, CI)
-- and tests/postgres/worksheet-custom-170.proof.sql (plain PostgreSQL 16).
-- Inputs: the database. Outputs: one column, one constraint, one function, one trigger. Must not change: anything else.
BEGIN;
DO $post_release_guard$
DECLARE
  v_col BOOLEAN;
  v_con BOOLEAN;
  v_fun BOOLEAN;
  v_trg BOOLEAN;
BEGIN
 IF to_regclass('public.jobs') IS NULL OR to_regclass('public.job_signoffs') IS NULL THEN
  RAISE EXCEPTION '170: public.jobs or public.job_signoffs is missing; apply the migrations through 045 first (see release preflight)';
 END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name IN ('id', 'job_no', 'worksheet_version')) <> 3
    OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_signoffs' AND column_name IN ('job_id', 'worksheet_version', 'kind')) <> 3 THEN
  RAISE EXCEPTION '170: public.jobs (id, job_no, worksheet_version) or public.job_signoffs (job_id, worksheet_version, kind) lacks a column the guard reads; stop and run release preflight';
 END IF;
 SELECT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = 'worksheet_custom') INTO v_col;
 SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.jobs'::regclass AND k.conname = 'jobs_worksheet_custom_shape') INTO v_con;
 SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'jobs_worksheet_custom_lock') INTO v_fun;
 SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_worksheet_custom_lock') INTO v_trg;
 IF NOT (v_col OR v_con OR v_fun OR v_trg) THEN
  RETURN; -- ABSENT: the release applies
 END IF;
 -- Something is there: it must be exactly 170's, all four of it (INSTALLED); anything else is DRIFTED.
 IF NOT (v_col AND v_con AND v_fun AND v_trg)
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = 'worksheet_custom'
                     AND c.data_type = 'jsonb' AND c.is_nullable = 'NO' AND c.column_default = '''{}''::jsonb')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.jobs_worksheet_custom_lock()') AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'a7d2d5df942ae0fc369d15d7bd7ee21c')
    OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'jobs_worksheet_custom_lock') <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_worksheet_custom_lock' AND t.tgenabled = 'O'
                     AND t.tgfoid = to_regprocedure('public.jobs_worksheet_custom_lock()')) THEN
  RAISE EXCEPTION '170: worksheet_custom, its constraint, function or trigger exists but is not exactly 170''s (type, default, body, security, search_path or trigger differ); stop and compare it first, nothing was changed';
 END IF;
END $post_release_guard$;

-- Before: a fingerprint of everything 170 must not touch. Session-only helper, dropped before COMMIT.
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

DO $p170_self_check$
DECLARE
  v_oid OID := to_regprocedure('public.jobs_worksheet_custom_lock()');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs' AND c.column_name = 'worksheet_custom'
                   AND c.data_type = 'jsonb' AND c.is_nullable = 'NO' AND c.column_default = '''{}''::jsonb') THEN
    RAISE EXCEPTION '170 self-check: jobs.worksheet_custom must be jsonb NOT NULL default {}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.jobs'::regclass AND k.conname = 'jobs_worksheet_custom_shape' AND k.contype = 'c' AND k.convalidated) THEN
    RAISE EXCEPTION '170 self-check: the shape constraint is missing or not validated';
  END IF;
  IF v_oid IS NULL OR (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'jobs_worksheet_custom_lock') <> 1 THEN
    RAISE EXCEPTION '170 self-check: there must be exactly one function named jobs_worksheet_custom_lock';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_oid AND p.prorettype = 'trigger'::regtype AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'a7d2d5df942ae0fc369d15d7bd7ee21c') THEN
    RAISE EXCEPTION '170 self-check: the function must be SECURITY DEFINER, search_path pg_catalog, public, returning trigger, with 170''s body (md5 a7d2d5df...)';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '170 self-check: no browser role and not PUBLIC may execute the trigger function';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid = 'public.jobs'::regclass AND t.tgname = 'jobs_worksheet_custom_lock' AND t.tgenabled = 'O' AND t.tgfoid = v_oid
        AND pg_catalog.pg_get_triggerdef(t.oid) LIKE '%BEFORE UPDATE OF worksheet_custom ON public.jobs FOR EACH ROW%') <> 1 THEN
    RAISE EXCEPTION '170 self-check: the trigger must be enabled, BEFORE UPDATE OF worksheet_custom, FOR EACH ROW';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p170_before EXCEPT SELECT * FROM pg_temp.p170_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p170_fingerprint() EXCEPT SELECT * FROM pg_temp.p170_before) THEN
    RAISE EXCEPTION '170 self-check: another function, a jobs column, constraint, trigger, policy or grant, or a jobs row (other than the new column) changed';
  END IF;
END
$p170_self_check$;
DROP TABLE pg_temp.p170_before;
DROP FUNCTION pg_temp.p170_fingerprint();
COMMIT;

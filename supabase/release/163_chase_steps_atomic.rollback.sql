-- Rollback of post-144 release step 163 (supabase/release/163_chase_steps_atomic.release.sql). Drops ONLY
-- public.save_chase_steps_atomic(uuid, jsonb, jsonb), so the database is exactly as it was before 163 (163 created that one function and
-- changed nothing else). Chase steps already saved stay; after this the Settings screen cannot save changed chase steps again until 163 is
-- re-applied (reading steps is unaffected). Stop the app's chase steps save first if you are rolling back a live system.
-- STATE is judged by the function's exact body: ABSENT (nothing to do, refuses nothing, changes nothing), INSTALLED as 163 left it (the
-- function is dropped), DRIFTED (any other body, security or search_path, or another overload of the same name: REFUSES, changes nothing).
-- The self-check compares the same fingerprint as the release (every other function with grants, chase_steps and chase_pauses structure,
-- the chase_steps rows) before and after, and requires the function gone. Inputs: the database. Outputs: one function removed. Must not
-- change: anything else. Production only with Rhys's separate yes.
BEGIN;
DO $rollback_guard$
DECLARE
  v_oid OID := to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)');
BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'save_chase_steps_atomic' AND p.oid IS DISTINCT FROM v_oid) THEN
  RAISE EXCEPTION '163 rollback: another function named save_chase_steps_atomic exists (a different argument list); stop and compare it first, nothing was changed';
 END IF;
 IF v_oid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = v_oid AND NOT p.prosecdef
                   AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '63145f3026fdc7db5dc1ba0a5928177a') THEN
  RAISE EXCEPTION '163 rollback: public.save_chase_steps_atomic(uuid, jsonb, jsonb) is not 163''s (body, security or search_path differ); stop and compare it first, nothing was changed';
 END IF;
END $rollback_guard$;

CREATE FUNCTION pg_temp.p163_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p163fp$
  SELECT 'every other function (name, args, security, config, body, grants)'::TEXT,
         md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), p.prosecdef::TEXT, coalesce(p.proconfig::TEXT, ''), md5(p.prosrc), coalesce(p.proacl::TEXT, ''))), '' ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), ''))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND NOT (n.nspname = 'public' AND p.proname = 'save_chase_steps_atomic')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 'chase_steps and chase_pauses: columns',
         md5(coalesce(string_agg(concat_ws('|', c.table_name, c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.table_name, c.ordinal_position), ''))
  FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('chase_steps', 'chase_pauses')
  UNION ALL SELECT 'chase_steps and chase_pauses: constraints',
         md5(coalesce(string_agg(concat_ws('|', k.conrelid::regclass::TEXT, k.conname, pg_catalog.pg_get_constraintdef(k.oid)), ';' ORDER BY k.conrelid::regclass::TEXT, k.conname), ''))
  FROM pg_catalog.pg_constraint k WHERE k.conrelid IN ('public.chase_steps'::regclass, 'public.chase_pauses'::regclass)
  UNION ALL SELECT 'chase_steps and chase_pauses: triggers',
         md5(coalesce(string_agg(concat_ws('|', t.tgrelid::regclass::TEXT, t.tgname, t.tgenabled::TEXT, pg_catalog.pg_get_triggerdef(t.oid)), ';' ORDER BY t.tgrelid::regclass::TEXT, t.tgname), ''))
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN ('public.chase_steps'::regclass, 'public.chase_pauses'::regclass)
  UNION ALL SELECT 'chase_steps and chase_pauses: policies',
         md5(coalesce(string_agg(concat_ws('|', p.tablename, p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, '')), ';' ORDER BY p.tablename, p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN ('chase_steps', 'chase_pauses')
  UNION ALL SELECT 'chase_steps and chase_pauses: row security, owner, grants',
         coalesce(string_agg(c.relname || '|' || c.relrowsecurity::TEXT || '|' || c.relforcerowsecurity::TEXT || '|' || c.relowner::regrole::TEXT || '|' || coalesce(c.relacl::TEXT, ''), ';' ORDER BY c.relname), '')
  FROM pg_catalog.pg_class c WHERE c.oid IN ('public.chase_steps'::regclass, 'public.chase_pauses'::regclass)
  UNION ALL SELECT 'chase_steps rows', md5(coalesce(string_agg(to_jsonb(s)::TEXT, ';' ORDER BY s.id), ''))
  FROM public.chase_steps s
$p163fp$;
CREATE TEMP TABLE p163_before ON COMMIT DROP AS SELECT * FROM pg_temp.p163_fingerprint();

DROP FUNCTION IF EXISTS public.save_chase_steps_atomic(uuid,jsonb,jsonb);

DO $rollback_self_check$
BEGIN
  IF to_regprocedure('public.save_chase_steps_atomic(uuid,jsonb,jsonb)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'save_chase_steps_atomic') THEN
    RAISE EXCEPTION '163 rollback self-check: the function is still there';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p163_before EXCEPT SELECT * FROM pg_temp.p163_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p163_fingerprint() EXCEPT SELECT * FROM pg_temp.p163_before) THEN
    RAISE EXCEPTION '163 rollback self-check: another function, chase_steps or chase_pauses or a chase_steps row changed';
  END IF;
END
$rollback_self_check$;
DROP TABLE pg_temp.p163_before;
DROP FUNCTION pg_temp.p163_fingerprint();
COMMIT;

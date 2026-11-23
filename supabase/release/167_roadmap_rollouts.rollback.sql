-- Rollback of post-144 release step 167 (supabase/release/167_roadmap_rollouts.release.sql). Drops ONLY 167's two tables and seven functions, so the
-- database is exactly as before 167 (167 changed nothing else). REFUSES, changing nothing, while either table holds a row: the roadmap and the
-- rollout log are records, and this file never deletes records. To go back while they hold rows, turn the app screens off with the server flags
-- PLATFORM_ROADMAP_ENABLED and PLATFORM_ROLLOUTS_ENABLED (unset them); the tables then sit unused. Switches already turned on or off by a rollout
-- stay as they are (a rollback of 167 does not touch any company's setting; turn them off from the Rollouts screen first if wanted).
-- STATE is judged by the objects: ABSENT (nothing to do, changes nothing), INSTALLED as 167 left it (tables empty: dropped), DRIFTED (anything else:
-- REFUSES, changes nothing). The self-check compares the same fingerprint as the release before and after. Inputs: the database. Outputs: two tables
-- and seven functions removed. Must not change: anything else. Production only with Rhys's separate yes.
BEGIN;
DO $rollback_guard$
DECLARE
  v_tables INTEGER := (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('platform_roadmap_items', 'platform_rollout_log') AND c.relkind = 'r');
  v_fns    INTEGER := (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply'));
BEGIN
 IF v_tables = 0 AND v_fns = 0 THEN
  RETURN; -- ABSENT
 END IF;
 IF NOT (v_tables = 2 AND v_fns = 7 AND (SELECT md5(string_agg(md5(regexp_replace(p.prosrc, '\s', '', 'g')), '' ORDER BY p.proname)) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply')) = 'ec318b0a585fdf72cbbb60a0f49f70e6'
         AND (SELECT md5(string_agg(concat_ws('|', c.table_name, c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.table_name, c.ordinal_position)) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('platform_roadmap_items', 'platform_rollout_log')) = '49a0d757be4df0ee3b1101c0b2b1f74d') THEN
  RAISE EXCEPTION '167 rollback: some of its tables or functions exist but are not 167''s; stop and compare them first, nothing was changed';
 END IF;
 IF EXISTS (SELECT 1 FROM public.platform_roadmap_items) OR EXISTS (SELECT 1 FROM public.platform_rollout_log) THEN
  RAISE EXCEPTION '167 rollback: the roadmap or the rollout log holds rows; this file never deletes records, nothing was changed (turn the screens off with their server flags instead)';
 END IF;
END $rollback_guard$;

CREATE FUNCTION pg_temp.p167_fingerprint()
RETURNS TABLE (kind TEXT, fp TEXT)
LANGUAGE sql
AS $p167fp$
  SELECT 'every other function (name, args, security, config, body, grants)'::TEXT,
         md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid), p.prosecdef::TEXT, coalesce(p.proconfig::TEXT, ''), md5(p.prosrc), coalesce(p.proacl::TEXT, ''))), '' ORDER BY n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)), ''))
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'security_audit') AND NOT (n.nspname = 'public' AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  UNION ALL SELECT 'organization_settings: columns',
         md5(coalesce(string_agg(concat_ws('|', c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.ordinal_position), ''))
  FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'organization_settings'
  UNION ALL SELECT 'organization_settings: constraints',
         md5(coalesce(string_agg(concat_ws('|', k.conname, pg_catalog.pg_get_constraintdef(k.oid)), ';' ORDER BY k.conname), ''))
  FROM pg_catalog.pg_constraint k WHERE k.conrelid = 'public.organization_settings'::regclass
  UNION ALL SELECT 'organization_settings: triggers',
         md5(coalesce(string_agg(concat_ws('|', t.tgname, t.tgenabled::TEXT, pg_catalog.pg_get_triggerdef(t.oid)), ';' ORDER BY t.tgname), ''))
  FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid = 'public.organization_settings'::regclass
  UNION ALL SELECT 'organization_settings: policies',
         md5(coalesce(string_agg(concat_ws('|', p.policyname, p.permissive, p.roles::TEXT, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, '')), ';' ORDER BY p.policyname), ''))
  FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'organization_settings'
  UNION ALL SELECT 'organization_settings: row security, owner, grants',
         coalesce(string_agg(c.relname || '|' || c.relrowsecurity::TEXT || '|' || c.relforcerowsecurity::TEXT || '|' || c.relowner::regrole::TEXT || '|' || coalesce(c.relacl::TEXT, ''), ';' ORDER BY c.relname), '')
  FROM pg_catalog.pg_class c WHERE c.oid = 'public.organization_settings'::regclass
  UNION ALL SELECT 'organization_settings rows', md5(coalesce(string_agg(to_jsonb(s)::TEXT, ';' ORDER BY s.organization_id), ''))
  FROM public.organization_settings s
  UNION ALL SELECT 'organizations rows', md5(coalesce(string_agg(to_jsonb(o)::TEXT, ';' ORDER BY o.id), ''))
  FROM public.organizations o
$p167fp$;
CREATE TEMP TABLE p167_before ON COMMIT DROP AS SELECT * FROM pg_temp.p167_fingerprint();

DROP FUNCTION IF EXISTS public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text);
DROP FUNCTION IF EXISTS public.platform_rollout_overview();
DROP FUNCTION IF EXISTS public.platform_roadmap_move(uuid,text);
DROP FUNCTION IF EXISTS public.platform_roadmap_save(uuid,text,text,text,text,uuid[]);
DROP FUNCTION IF EXISTS public.platform_roadmap_list();
DROP FUNCTION IF EXISTS public._platform_owner_check(boolean);
DROP TABLE IF EXISTS public.platform_rollout_log;
DROP TABLE IF EXISTS public.platform_roadmap_items;
DROP FUNCTION IF EXISTS public.platform_rollout_log_guard();

DO $rollback_self_check$
BEGIN
  IF to_regclass('public.platform_roadmap_items') IS NOT NULL OR to_regclass('public.platform_rollout_log') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply')) THEN
    RAISE EXCEPTION '167 rollback self-check: a table or function of 167 is still there';
  END IF;
  IF EXISTS (SELECT * FROM pg_temp.p167_before EXCEPT SELECT * FROM pg_temp.p167_fingerprint())
     OR EXISTS (SELECT * FROM pg_temp.p167_fingerprint() EXCEPT SELECT * FROM pg_temp.p167_before) THEN
    RAISE EXCEPTION '167 rollback self-check: another function, organizations or organization_settings changed';
  END IF;
END
$rollback_self_check$;
DROP TABLE pg_temp.p167_before;
DROP FUNCTION pg_temp.p167_fingerprint();
COMMIT;

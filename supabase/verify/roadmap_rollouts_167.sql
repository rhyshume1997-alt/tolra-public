-- Release 167 (owner-only Roadmap and Rollouts; phase 167 in supabase/release-plan.json). Read only: every row should be TRUE (10).
-- Inputs: none. Outputs: one row per check (check_name, ok). Must not change: this file only reads. Function bodies are compared with every whitespace
-- character removed (an SQL-editor paste may store CRLF). The behavioural proof is tests/db/roadmap-rollouts-167.test.ts.
SELECT 'both tables exist with row security on' AS check_name,
       (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('platform_roadmap_items', 'platform_rollout_log') AND c.relkind = 'r' AND c.relrowsecurity) = 2 AS ok
UNION ALL SELECT 'the seven functions exist, one of each name', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply')) = 7
UNION ALL SELECT 'function bodies are 167''s (md5 ec318b0a...)', coalesce((SELECT md5(string_agg(md5(regexp_replace(p.prosrc, '\s', '', 'g')), '' ORDER BY p.proname)) FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('platform_rollout_log_guard','_platform_owner_check','platform_roadmap_list','platform_roadmap_save','platform_roadmap_move','platform_rollout_overview','platform_rollout_apply')) = 'ec318b0a585fdf72cbbb60a0f49f70e6', FALSE)
UNION ALL SELECT 'table columns are 167''s (md5 49a0d757...)', coalesce((SELECT md5(string_agg(concat_ws('|', c.table_name, c.column_name, c.data_type, c.is_nullable, coalesce(c.column_default, '')), ';' ORDER BY c.table_name, c.ordinal_position)) FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN ('platform_roadmap_items', 'platform_rollout_log')) = '49a0d757be4df0ee3b1101c0b2b1f74d', FALSE)
UNION ALL SELECT 'no API role has a grant on either table',
       NOT (has_table_privilege('anon', 'public.platform_roadmap_items', 'SELECT') OR has_table_privilege('authenticated', 'public.platform_roadmap_items', 'SELECT') OR has_table_privilege('service_role', 'public.platform_roadmap_items', 'SELECT')
            OR has_table_privilege('anon', 'public.platform_rollout_log', 'SELECT') OR has_table_privilege('authenticated', 'public.platform_rollout_log', 'SELECT') OR has_table_privilege('service_role', 'public.platform_rollout_log', 'SELECT'))
UNION ALL SELECT 'signed-in users can run the roadmap and overview functions; anon and PUBLIC cannot',
       has_function_privilege('authenticated', 'public.platform_roadmap_list()', 'EXECUTE') AND has_function_privilege('authenticated', 'public.platform_roadmap_save(uuid,text,text,text,text,uuid[])', 'EXECUTE')
       AND has_function_privilege('authenticated', 'public.platform_roadmap_move(uuid,text)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.platform_rollout_overview()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.platform_roadmap_list()', 'EXECUTE') AND NOT has_function_privilege('public', 'public.platform_roadmap_list()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.platform_rollout_overview()', 'EXECUTE') AND NOT has_function_privilege('public', 'public.platform_rollout_overview()', 'EXECUTE')
UNION ALL SELECT 'rollout apply is service role only',
       has_function_privilege('service_role', 'public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text)', 'EXECUTE')
       AND NOT has_function_privilege('public', 'public.platform_rollout_apply(uuid,text,text,uuid[],boolean,text)', 'EXECUTE')
UNION ALL SELECT 'the owner-check helper has no API caller',
       NOT has_function_privilege('authenticated', 'public._platform_owner_check(boolean)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public._platform_owner_check(boolean)', 'EXECUTE')
       AND NOT has_function_privilege('public', 'public._platform_owner_check(boolean)', 'EXECUTE')
UNION ALL SELECT 'the rollout log is append-only (update/delete trigger and truncate trigger enabled)',
       (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = to_regclass('public.platform_rollout_log') AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgname IN ('platform_rollout_log_guard', 'platform_rollout_log_no_truncate')) = 2
UNION ALL SELECT 'the helpers it calls exist (is_platform_admin, assert_platform_aal, session_read_only, platform_admins)',
       to_regprocedure('public.is_platform_admin()') IS NOT NULL AND to_regprocedure('public.assert_platform_aal()') IS NOT NULL
       AND to_regprocedure('public.session_read_only()') IS NOT NULL AND to_regclass('security_audit.platform_admins') IS NOT NULL;

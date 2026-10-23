-- Migration 074 (day flags on the daily job sheet). Read only: every row should be TRUE.
SELECT 'tables_present' AS check_name, to_regclass('public.time_day_flags') IS NOT NULL AND to_regclass('public.time_day_flag_ops') IS NOT NULL AS ok
UNION ALL SELECT 'rls_enabled', (SELECT bool_and(c.relrowsecurity) AND count(*) = 2 FROM pg_class c
                                 WHERE c.oid IN ('public.time_day_flags'::regclass, 'public.time_day_flag_ops'::regclass))
UNION ALL SELECT 'no_direct_api_writes', NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['public.time_day_flags', 'public.time_day_flag_ops']) t, unnest(ARRAY['anon', 'authenticated']) r,
                unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
  WHERE has_table_privilege(r, t, p))
  AND NOT has_table_privilege('anon', 'public.time_day_flags', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.time_day_flag_ops', 'SELECT')
UNION ALL SELECT 'read_policy_company_scoped', EXISTS (
  SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'time_day_flags' AND p.cmd = 'SELECT'
    AND p.qual LIKE '%current_user_organization_id()%' AND p.qual LIKE '%auth.uid()%')
UNION ALL SELECT 'save_signed_in_definer_pinned', (
  SELECT p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND p.proconfig @> ARRAY['search_path=pg_catalog, public'] AND p.prosrc LIKE '%assert_privileged_aal()%'
         AND p.prosrc LIKE '%time_week_locked(%' AND p.prosrc LIKE '%attendance_lock(v_org, v_user)%'
         AND strpos(p.prosrc, 'attendance_lock(v_org, v_user)') < strpos(p.prosrc, 'time_week_locked(')
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_time_day_flags(uuid,uuid,date,boolean,boolean,boolean,boolean)'))
UNION ALL SELECT 'revision_internal_with_flags', (
  SELECT p.prosrc LIKE '%time_day_flags%' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.time_week_revision(uuid,uuid,date)'))
UNION ALL SELECT 'guards', (
  SELECT count(*) = 3 FROM pg_trigger WHERE tgrelid = 'public.time_day_flags'::regclass AND tgenabled = 'O'
    AND tgname IN ('audit_time_day_flags_changes', 'support_read_only', 'admin_mfa'))
  AND (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.time_day_flag_ops'::regclass AND tgenabled = 'O'
    AND tgname IN ('support_read_only', 'admin_mfa'))
-- Data: every saved day belongs to someone of that company, and was changed by someone of that company (or nobody recorded).
UNION ALL SELECT 'flags_consistent', NOT EXISTS (
  SELECT 1 FROM public.time_day_flags f
  WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = f.organization_id AND m.user_id = f.user_id)
     OR (f.updated_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = f.organization_id AND m.user_id = f.updated_by)));

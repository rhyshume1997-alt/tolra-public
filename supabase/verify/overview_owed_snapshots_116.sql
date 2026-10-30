-- Migration 116 (the Overview's owed snapshots). Read only: every row should be TRUE (6).
SELECT 'table_columns' AS check_name,
  (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'overview_owed_snapshots')
    = 'captured_at,late_amount,organization_id,owed_amount,snapshot_date' AS ok
-- RLS on, and exactly two policies: the admin read and the Invoices page switch.
UNION ALL SELECT 'rls_on_two_policies',
  coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.overview_owed_snapshots')), FALSE)
  AND (SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd, ',' ORDER BY policyname) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'overview_owed_snapshots')
    = 'overview_owed_snapshots admin select PERMISSIVE SELECT,overview_owed_snapshots section access RESTRICTIVE ALL'
-- Signed-in people may only read; anon nothing.
UNION ALL SELECT 'grants_read_only',
  coalesce((SELECT string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee, privilege_type) FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'overview_owed_snapshots' AND grantee IN ('PUBLIC', 'anon', 'authenticated')), '')
    = 'authenticated:SELECT'
UNION ALL SELECT 'support_read_only_trigger',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'support_read_only' AND tgrelid = to_regclass('public.overview_owed_snapshots') AND NOT tgisinternal)
-- The capture function: definer with a fixed search path, the service role only.
UNION ALL SELECT 'capture_definer_service_role_only',
  coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('service_role', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.capture_overview_owed()')), FALSE)
-- It writes today (London) only, never a date it is given.
UNION ALL SELECT 'capture_writes_today_only',
  coalesce((SELECT pronargs = 0 AND position('Europe/London' IN prosrc) > 0 FROM pg_proc WHERE oid = to_regprocedure('public.capture_overview_owed()')), FALSE);

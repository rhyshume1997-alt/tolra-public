-- Migration 114 (clock-in network lock). Read only: every row should be TRUE (7).
-- The three tables exist with row level security on.
SELECT 'three_tables_rls_on' AS check_name,
  (SELECT count(*) = 3 AND bool_and(c.relrowsecurity) FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('clock_in_network_locks', 'clock_in_network_exemptions', 'clock_in_network_unverified')) AS ok
-- Signed-in users may only read them; anon nothing.
UNION ALL SELECT 'grants_select_only',
  has_table_privilege('authenticated', 'public.clock_in_network_locks', 'SELECT') AND has_table_privilege('authenticated', 'public.clock_in_network_unverified', 'SELECT')
  AND has_table_privilege('authenticated', 'public.clock_in_network_exemptions', 'SELECT')
  AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.table_schema = 'public'
                  AND g.table_name IN ('clock_in_network_locks', 'clock_in_network_exemptions', 'clock_in_network_unverified')
                  AND (g.grantee = 'anon' OR (g.grantee = 'authenticated' AND g.privilege_type <> 'SELECT')))
-- One SELECT policy each, scoped to the caller's company; no other policy.
UNION ALL SELECT 'select_policies_company',
  (SELECT count(*) = 3 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('clock_in_network_locks', 'clock_in_network_exemptions', 'clock_in_network_unverified')
     AND cmd = 'SELECT' AND qual LIKE '%current_user_organization_id()%')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('clock_in_network_locks', 'clock_in_network_exemptions', 'clock_in_network_unverified') AND cmd <> 'SELECT')
-- The three admin functions: definer, pinned, signed-in only.
UNION ALL SELECT 'admin_functions_signed_in_only',
  (SELECT count(*) = 3 AND bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.lock_clock_in_network()'), to_regprocedure('public.unlock_clock_in_network()'),
                                to_regprocedure('public.set_clock_in_off_site_allowed(uuid,boolean)')))
-- The two trigger functions: no API role may run them.
UNION ALL SELECT 'trigger_functions_internal',
  (SELECT count(*) = 2 AND bool_and(NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
   FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.clock_in_network_lock_check()'), to_regprocedure('public.clock_in_network_unverified_record()')))
-- Both triggers on attendance_events, enabled.
UNION ALL SELECT 'triggers_on_attendance_events',
  (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.attendance_events'::regclass AND tgenabled = 'O'
     AND tgname IN ('clock_in_network_lock', 'zz_clock_in_network_unverified'))
-- How many companies are locked (informational: 0 until an admin presses Lock; TRUE either way).
UNION ALL SELECT 'locked_companies_' || (SELECT count(*) FROM public.clock_in_network_locks)::TEXT, TRUE;

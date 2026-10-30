-- Migration 111 (the dashboard's figures worked out in the database). Read only: every row should be TRUE (4). Bodies are compared
-- with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.dashboard_work_figures(date,date,date,date,date,timestamp with time zone,timestamp with time zone,timestamp with time zone)'),
                  to_regprocedure('public.dashboard_money_figures(date,date)'))
)
-- Both functions are 111's bodies.
SELECT 'dashboard_work_figures_is_111' AS check_name,
       coalesce((SELECT body = '8d4725ea13d23d27ae0be5cbfbfd012d' FROM fn WHERE proname = 'dashboard_work_figures'), FALSE) AS ok
UNION ALL SELECT 'dashboard_money_figures_is_111',
       coalesce((SELECT body = 'd57a0bd65b8669a48e171dbe49bd95ab' FROM fn WHERE proname = 'dashboard_money_figures'), FALSE)
-- SECURITY INVOKER (row-level security applies to the caller), STABLE (read only), fixed search_path.
UNION ALL SELECT 'dashboard_figures_invoker_stable',
       (SELECT count(*) = 2 AND bool_and(NOT prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=pg_catalog, public']) FROM fn)
-- Signed-in only: authenticated may call them; anon and PUBLIC may not.
UNION ALL SELECT 'dashboard_figures_signed_in_only',
       (SELECT count(*) = 2 AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')) FROM fn);

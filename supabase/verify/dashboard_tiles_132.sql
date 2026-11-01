-- Migration 132 (the dashboard's tile figures counted in the database). Read only: every row should be TRUE (6).
-- Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.oid IN (to_regprocedure('public.dashboard_open_quotes(date)'), to_regprocedure('public.dashboard_quotes_sent(date)'),
    to_regprocedure('public.dashboard_quotes_won(date)'), to_regprocedure('public.dashboard_quote_outcomes(date, date)'),
    to_regprocedure('public.dashboard_rfqs_to_quote()'), to_regprocedure('public.dashboard_money_owed(date)'))
)
-- The six functions, with exactly these arguments.
SELECT 'six_functions' AS check_name, (SELECT count(*) = 6 FROM f) AS ok
-- Each is 132's body.
UNION ALL SELECT 'bodies_are_132', (SELECT count(*) = 6 FROM f WHERE (proname, body) IN (
  ('dashboard_open_quotes', 'd2c5bd23f4c46c421b989012e74c2e80'), ('dashboard_quotes_sent', '308be040514eab13aca8cf86dd7f2c63'),
  ('dashboard_quotes_won', 'd2ca2c957383ede97833c95b84b0f8fa'), ('dashboard_quote_outcomes', '774a67cfe0e7fd2f013f7fd3abcc7dad'),
  ('dashboard_rfqs_to_quote', 'feb2db260235700a2166bb4c1a550467'), ('dashboard_money_owed', '717e79e4e15894b2392c3c9d0eda4e96')))
-- Row-level security applies: SECURITY INVOKER, never definer.
UNION ALL SELECT 'security_invoker', (SELECT count(*) = 6 AND bool_and(NOT prosecdef) FROM f)
-- Read only and search_path pinned.
UNION ALL SELECT 'stable_search_path', (SELECT count(*) = 6 AND bool_and(provolatile = 's' AND proconfig = '{"search_path=pg_catalog, public"}') FROM f)
-- Signed-in users may call them; anon and PUBLIC may not.
UNION ALL SELECT 'execute_authenticated_only', (SELECT count(*) = 6 AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')
  AND NOT has_function_privilege('anon', oid, 'EXECUTE')) FROM f)
  AND NOT EXISTS (SELECT 1 FROM f, aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = f.oid), acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = f.oid)))) a WHERE a.grantee = 0)
-- Nothing else changed: the tables they read still have row-level security on.
UNION ALL SELECT 'tables_still_rls', (SELECT bool_and(c.relrowsecurity) FROM pg_class c WHERE c.oid IN ('public.quotes'::regclass, 'public.rfqs'::regclass, 'public.invoices'::regclass));

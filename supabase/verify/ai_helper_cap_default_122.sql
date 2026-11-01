-- Migration 122 (the AI helper's monthly cap defaults to 500p). Read only: every row should be TRUE (3). Bodies are compared with
-- every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.ai_helper_status()')
)
-- The column default is 500 (101's CHECK, 0 to 100000, unchanged).
SELECT 'cap_defaults_to_500' AS check_name,
  coalesce((SELECT column_default = '500' FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'ai_helper_settings' AND column_name = 'monthly_cap_pence'), FALSE) AS ok
-- ai_helper_status: 122's body (no settings row reads 500), stable.
UNION ALL SELECT 'status_is_122',
  coalesce((SELECT body = '3ef44c838451b46ea14030164d9b1384' AND provolatile = 's' FROM fn WHERE proname = 'ai_helper_status'), FALSE)
-- ai_helper_status: definer, 101's search_path, signed-in only (authenticated may; anon and PUBLIC may not).
UNION ALL SELECT 'status_definer_signed_in_only',
  (SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
            AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
   FROM fn);

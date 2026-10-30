-- Migration 118 (the row-level-security helpers' resolver keeps its plan). Read only: every row should be TRUE (3). The body is
-- compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.prosecdef, p.provolatile, p.proretset, p.proconfig, l.lanname, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = to_regprocedure('public._session_membership()')
)
-- _session_membership: 116's query run by PL/pgSQL (118's text); definer, stable, 036's search_path.
SELECT 'session_membership_is_118' AS check_name,
       coalesce((SELECT body = '38ad8bd255ea9a2d2b8713aa04eb7c82' AND lanname = 'plpgsql' AND prosecdef AND provolatile = 's' AND proretset
                        AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM fn), FALSE) AS ok
-- No API role may call it (as 036): anon, authenticated and PUBLIC hold no EXECUTE.
UNION ALL SELECT 'session_membership_not_callable_by_api_roles',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn), FALSE)
-- The six access helpers still answer from it (036, unchanged by 118).
UNION ALL SELECT 'access_helpers_read_session_membership',
  (SELECT count(*) = 6 AND bool_and(p.prosrc ILIKE '%_session_membership%' AND p.prosecdef AND p.provolatile = 's') FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('current_user_organization_id', 'user_organization_id', 'current_user_role', 'current_user_secondary_role', 'has_org_role', 'section_allowed'));

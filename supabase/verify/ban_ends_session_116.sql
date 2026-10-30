-- Migration 116 (a disabled sign-in ends the session at once). Read only: every row should be TRUE (5). Bodies are compared with
-- every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.proname, p.oid, p.prosecdef, p.provolatile, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.session_is_active()'), to_regprocedure('public._session_membership()'),
                                 to_regprocedure('public.check_request_session()'))
)
-- session_is_active: 017's body plus the ban test (auth.users.banned_until > now()); definer, stable, 017's search_path.
SELECT 'session_is_active_is_116' AS check_name,
       coalesce((SELECT body = 'af6457cae4d8b89cd34b5963574fbe58' AND prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=pg_catalog, public']
                 FROM fn WHERE proname = 'session_is_active'), FALSE) AS ok
-- _session_membership: 036's body plus the same ban test on the person; definer, stable, 036's search_path.
UNION ALL SELECT '_session_membership_is_116',
       coalesce((SELECT body = 'b9c4e5c7147e1c7893b4e586dae0be2e' AND prosecdef AND provolatile = 's' AND proconfig = ARRAY['search_path=pg_catalog, public']
                 FROM fn WHERE proname = '_session_membership'), FALSE)
-- 017's grants on session_is_active: signed-in users and the service role; not anon, not PUBLIC.
UNION ALL SELECT 'session_is_active_grants_are_017s',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND has_function_privilege('service_role', oid, 'EXECUTE')
              AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = 'session_is_active'), FALSE)
-- 036's grants on _session_membership: no API role may call it.
UNION ALL SELECT '_session_membership_not_callable_by_api_roles',
  coalesce((SELECT NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = '_session_membership'), FALSE)
-- The request hook is unchanged: still 017's check_request_session (which calls session_is_active), set for the authenticator role.
UNION ALL SELECT 'request_hook_is_017s_check_request_session',
  coalesce((SELECT body = 'c51bcea051451b9f6703a9bcbb7865e4' FROM fn WHERE proname = 'check_request_session'), FALSE)
  AND EXISTS (SELECT 1 FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
              WHERE s.setrole = 'authenticator'::regrole AND cfg = 'pgrst.db_pre_request=public.check_request_session');

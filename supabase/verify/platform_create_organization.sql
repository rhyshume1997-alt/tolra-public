-- READ ONLY. Migration 039 (the platform owner's "New company", checked and recorded by the database): run in a read-only transaction
-- AFTER applying 039 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 5 are facts about the schema and must be "true". Row 6 is informational: how many
-- companies the platform owner has created through the function so far.
WITH
fn AS (SELECT p.proname, p.prosrc, p.prosecdef, p.proconfig, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('platform_create_organization', 'create_organization'))
SELECT * FROM (
  SELECT 1 AS n, 'platform_create_organization(text, text, text) exists, is SECURITY DEFINER with a fixed search_path' AS check_name,
      (SELECT count(*) = 1 AND bool_and(prosecdef) AND bool_and('search_path=pg_catalog, public, security_audit' = ANY (proconfig))
       FROM fn WHERE proname = 'platform_create_organization')::text AS value, 'true' AS expected
  UNION ALL SELECT 2, 'It is executable by authenticated, and not by anon or PUBLIC',
      (SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
         AND NOT coalesce((SELECT bool_or(a.grantee = 0) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.privilege_type = 'EXECUTE'), FALSE)
       FROM fn WHERE proname = 'platform_create_organization')::text, 'true'
  UNION ALL SELECT 3, 'It checks the platform owner list and the second step before creating anything',
      (SELECT prosrc LIKE '%is_platform_admin()%assert_platform_aal()%create_organization(%' FROM fn WHERE proname = 'platform_create_organization')::text, 'true'
  UNION ALL SELECT 4, 'It writes the PLATFORM_CREATE_ORGANIZATION audit row',
      (SELECT prosrc LIKE '%INSERT INTO security_audit.audit_log%''PLATFORM_CREATE_ORGANIZATION''%' FROM fn WHERE proname = 'platform_create_organization')::text, 'true'
  UNION ALL SELECT 5, 'create_organization (007) is still closed to anon and authenticated',
      (SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
       FROM fn WHERE proname = 'create_organization')::text, 'true'
  UNION ALL SELECT 6, 'Companies created through the platform function', (SELECT count(*) FROM security_audit.audit_log WHERE action = 'PLATFORM_CREATE_ORGANIZATION')::text, 'informational'
) AS t
ORDER BY n;

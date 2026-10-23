-- READ ONLY. Migration 036 (two-level access): run in a read-only transaction AFTER applying 036 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 9 and 13 are facts about the schema and must be "true". Rows 10 onwards are informational: how
-- many platform owners are listed (none until the owner is added by hand, see docs/RELEASE.md), how many support memberships are open
-- and how many company entries are logged.
WITH
fn AS (SELECT p.proname, p.prosrc, p.prosecdef, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'security_audit')),
guarded AS (
  SELECT c.table_schema, c.table_name
  FROM information_schema.columns c
  JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
  WHERE c.column_name = 'organization_id' AND c.table_schema IN ('public', 'security_audit')
    AND c.table_name NOT IN ('user_profiles', 'organization_members', 'organization_invites', 'org_entry_log', 'session_company')
)
SELECT * FROM (
  SELECT 1 AS n, 'The three access tables exist with row-level security on' AS check_name,
      (SELECT count(*) = 3 AND bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'security_audit' AND c.relname IN ('platform_admins', 'session_company', 'org_entry_log'))::text AS value, 'true' AS expected
  UNION ALL SELECT 2, 'No API role (anon, authenticated, service_role) holds any privilege on them',
      (SELECT count(*) = 0 FROM information_schema.role_table_grants g
       WHERE g.table_schema = 'security_audit' AND g.table_name IN ('platform_admins', 'session_company', 'org_entry_log')
         AND g.grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC'))::text, 'true'
  UNION ALL SELECT 3, 'The access helpers answer from the session''s company (_session_membership)',
      (SELECT count(*) = 6 AND bool_and(prosrc ILIKE '%_session_membership%') FROM fn
       WHERE proname IN ('current_user_organization_id', 'user_organization_id', 'current_user_role', 'current_user_secondary_role', 'has_org_role', 'section_allowed'))::text, 'true'
  UNION ALL SELECT 4, '_session_membership() and assert_platform_aal() exist and no API role can call them; the platform functions check aal2',
      (SELECT count(*) = 2
         AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE') OR has_function_privilege('authenticated', oid, 'EXECUTE'))
         AND (SELECT count(*) = 4 FROM fn WHERE proname IN ('platform_list_organizations', 'platform_enter_organization', 'platform_elevate_support', 'platform_exit_organization')
                AND prosrc LIKE '%assert_platform_aal%')
       FROM fn WHERE proname IN ('_session_membership', 'assert_platform_aal'))::text, 'true'
  UNION ALL SELECT 5, 'The platform and session functions exist, are SECURITY DEFINER and are closed to anon',
      (SELECT count(*) = 8 AND bool_and(prosecdef) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) FROM fn
       WHERE proname IN ('is_platform_admin', 'session_read_only', 'my_session', 'platform_list_organizations', 'platform_enter_organization',
                         'platform_elevate_support', 'platform_exit_organization', 'org_entry_history'))::text, 'true'
  UNION ALL SELECT 6, 'Every company table has the read-only support trigger',
      (SELECT (SELECT count(*) FROM guarded) > 0
          AND NOT EXISTS (SELECT 1 FROM guarded g WHERE NOT EXISTS (
                SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE t.tgname = 'support_read_only' AND NOT t.tgisinternal AND n.nspname = g.table_schema AND c.relname = g.table_name)))::text, 'true'
  UNION ALL SELECT 7, 'No row-level policy refers to is_platform_admin()',
      (SELECT count(*) = 0 FROM pg_policies WHERE coalesce(qual, '') ILIKE '%is_platform_admin%' OR coalesce(with_check, '') ILIKE '%is_platform_admin%')::text, 'true'
  UNION ALL SELECT 8, 'The company entry log refuses updates and deletes from the API roles',
      (SELECT count(*) = 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'org_entry_log' AND t.tgname = 'org_entry_log_immutable' AND NOT t.tgisinternal)::text, 'true'
  UNION ALL SELECT 9, 'Only support memberships carry an expiry (none of the ordinary ones do)',
      (SELECT count(*) = 0 FROM public.organization_members WHERE support <> (expires_at IS NOT NULL))::text, 'true'
  UNION ALL SELECT 10, 'Platform owners listed', (SELECT count(*) FROM security_audit.platform_admins)::text, 'informational (0 until the owner is added by hand)'
  UNION ALL SELECT 11, 'Support memberships open now', (SELECT count(*) FROM public.organization_members WHERE support AND active AND expires_at > now())::text, 'informational'
  UNION ALL SELECT 12, 'Company entries logged', (SELECT count(*) FROM security_audit.org_entry_log)::text, 'informational'
  UNION ALL SELECT 13, 'A company admin''s member changes need the second step (set_member_access calls assert_privileged_aal), and a choice under a new support grant is logged',
      ((SELECT bool_and(prosrc LIKE '%assert_privileged_aal()%') FROM fn WHERE proname = 'set_member_access')
       AND (SELECT bool_and(prosrc LIKE '%v_prior_grant%') FROM fn WHERE proname = 'switch_organization'))::text, 'true'
) AS t
ORDER BY n;

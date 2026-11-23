-- Release 164 (the platform owner's Companies screen: counts, Close and Reopen; phase 164 in supabase/release-plan.json). Read only: every row should be TRUE (9).
-- Inputs: none. Outputs: one row per check (check_name, ok). Must not change: this file only reads. Function bodies are compared with every whitespace
-- character removed (an SQL-editor paste may store CRLF). The behavioural proof is tests/db/platform-companies-164.test.ts.
WITH o AS (SELECT p.oid, p.prosecdef, p.proconfig, p.proretset, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.platform_company_overview()')),
     s AS (SELECT p.oid, p.prosecdef, p.proconfig, p.prorettype, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)'))
SELECT 'both functions exist, exactly one of each name' AS check_name,
       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'platform_company_overview') = 1
       AND (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'platform_set_organization_status') = 1
       AND EXISTS (SELECT 1 FROM o) AND EXISTS (SELECT 1 FROM s) AS ok
UNION ALL SELECT 'platform_company_overview body is 164''s (md5 ed9d541c...)', coalesce((SELECT body_md5 = 'ed9d541cde10b9a815eb8fce4eae238f' FROM o), FALSE)
UNION ALL SELECT 'platform_set_organization_status body is 164''s (md5 4e4c0d80...)', coalesce((SELECT body_md5 = '4e4c0d80bc2b93a1656da5aeaa8eab8e' FROM s), FALSE)
UNION ALL SELECT 'both are definer with a pinned search_path (overview returns a table, status returns jsonb)',
       coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] AND proretset FROM o), FALSE)
       AND coalesce((SELECT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit'] AND prorettype = 'jsonb'::regtype FROM s), FALSE)
UNION ALL SELECT 'signed-in users can execute both; anon, PUBLIC and service_role cannot',
       coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('public', oid, 'EXECUTE') AND NOT has_function_privilege('service_role', oid, 'EXECUTE') FROM o), FALSE)
       AND coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('public', oid, 'EXECUTE') AND NOT has_function_privilege('service_role', oid, 'EXECUTE') FROM s), FALSE)
UNION ALL SELECT 'no ACL entry names PUBLIC, anon or service_role on either function',
       NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid IN (to_regprocedure('public.platform_company_overview()'), to_regprocedure('public.platform_set_organization_status(uuid,text,text,text)')) AND a.privilege_type = 'EXECUTE'
                     AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('anon', 'service_role'))))
UNION ALL SELECT '036 is in place: is_platform_admin, assert_platform_aal and the platform owner list and session company tables',
       to_regprocedure('public.is_platform_admin()') IS NOT NULL AND to_regprocedure('public.assert_platform_aal()') IS NOT NULL
       AND to_regclass('security_audit.platform_admins') IS NOT NULL AND to_regclass('security_audit.session_company') IS NOT NULL
UNION ALL SELECT 'the audit helper exists and organizations.status allows closed',
       to_regprocedure('security_audit.log_named_event(uuid,text,text,text,jsonb)') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'public.organizations'::regclass AND k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%closed%')
UNION ALL SELECT 'release preflight''s "post-144 marker 164 platform_companies" condition holds',
       coalesce((SELECT body_md5 = 'ed9d541cde10b9a815eb8fce4eae238f' AND prosecdef FROM o), FALSE) AND coalesce((SELECT body_md5 = '4e4c0d80bc2b93a1656da5aeaa8eab8e' AND prosecdef FROM s), FALSE);

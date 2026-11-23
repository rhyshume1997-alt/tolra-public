-- Release 165 (Raise an issue and the owner issues inbox; phase 165 in supabase/release-plan.json). Read only: every row should be TRUE (11).
-- Inputs: none. Outputs: one row per check (check_name, ok). Must not change: this file only reads. Function bodies are compared with every
-- whitespace character removed (an SQL-editor paste may store CRLF). The behavioural proof is tests/db/owner-issues-165.test.ts.
SELECT 'both tables exist with row security on' AS check_name,
       coalesce((SELECT count(*) = 2 AND bool_and(c.relrowsecurity) FROM pg_class c WHERE c.oid IN (to_regclass('public.issues'), to_regclass('public.issue_owner_notes'))), FALSE) AS ok
UNION ALL SELECT 'issues has exactly one policy (a company reads its own rows); issue_owner_notes has none',
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'issues') = 1
       AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'issue_owner_notes')
UNION ALL SELECT 'the issues policy reads only the session company (select wrapped, current_user_organization_id)',
       coalesce((SELECT p.cmd = 'SELECT' AND p.roles = ARRAY['authenticated']::name[] AND p.qual LIKE '%current_user_organization_id%' FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'issues'), FALSE)
UNION ALL SELECT 'signed-in users can only SELECT issues; anon and PUBLIC nothing',
       has_table_privilege('authenticated', 'public.issues', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.issues', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.issues', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.issues', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.issues', 'SELECT') AND NOT has_table_privilege('public', 'public.issues', 'SELECT')
UNION ALL SELECT 'no browser role has any privilege on issue_owner_notes',
       NOT has_table_privilege('authenticated', 'public.issue_owner_notes', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.issue_owner_notes', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.issue_owner_notes', 'UPDATE') AND NOT has_table_privilege('authenticated', 'public.issue_owner_notes', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.issue_owner_notes', 'SELECT') AND NOT has_table_privilege('public', 'public.issue_owner_notes', 'SELECT')
UNION ALL SELECT 'status is limited to new, looking, fixing, fixed, closed and closed_at follows it',
       (SELECT count(*) = 2 FROM pg_constraint k WHERE k.conrelid = to_regclass('public.issues') AND k.conname IN ('issues_status', 'issues_closed_at_fits'))
UNION ALL SELECT 'raise_issue: security definer, pinned search_path, 165''s body (md5 393e29b3...)',
       coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '393e29b3c90ca0a4407ebe40a54b924f' FROM pg_proc p WHERE p.oid = to_regprocedure('public.raise_issue(text,text,boolean)')), FALSE)
UNION ALL SELECT 'platform_list_issues: security definer, pinned search_path, 165''s body (md5 98e13a0f...)',
       coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '98e13a0f91183696ec04341659749cfc' FROM pg_proc p WHERE p.oid = to_regprocedure('public.platform_list_issues(uuid,text,boolean,integer)')), FALSE)
UNION ALL SELECT 'platform_update_issue: security definer, pinned search_path, 165''s body (md5 bca6425e...)',
       coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'bca6425ea57393a49841fc343f0a435e' FROM pg_proc p WHERE p.oid = to_regprocedure('public.platform_update_issue(uuid,text,text,text)')), FALSE)
UNION ALL SELECT 'the three functions: signed-in users can execute; anon and PUBLIC cannot (no ACL entry names them)',
       (SELECT count(*) = 3 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('raise_issue', 'platform_list_issues', 'platform_update_issue') AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
       AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('raise_issue', 'platform_list_issues', 'platform_update_issue') AND a.privilege_type = 'EXECUTE'
                         AND (a.grantee = 0 OR a.grantee IN (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'anon')))
UNION ALL SELECT 'the helpers it calls exist (is_platform_admin, assert_platform_aal, my_session, current_user_organization_id)',
       to_regprocedure('public.is_platform_admin()') IS NOT NULL AND to_regprocedure('public.assert_platform_aal()') IS NOT NULL
       AND to_regprocedure('public.my_session()') IS NOT NULL AND to_regprocedure('public.current_user_organization_id()') IS NOT NULL;

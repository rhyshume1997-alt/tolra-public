-- Read only: after a separately approved release, every row must say true.
SELECT 'RLS enabled' AS check_name, relrowsecurity AS ok FROM pg_class WHERE oid='public.company_setup_progress'::regclass
UNION ALL SELECT 'three separate policies', count(*)=3 FROM pg_policies WHERE schemaname='public' AND tablename='company_setup_progress'
UNION ALL SELECT 'anon cannot read', NOT has_table_privilege('anon','public.company_setup_progress','SELECT')
UNION ALL SELECT 'authenticated cannot delete', NOT has_table_privilege('authenticated','public.company_setup_progress','DELETE')
UNION ALL SELECT 'session API callable', has_function_privilege('authenticated','public.my_session()','EXECUTE')
UNION ALL SELECT 'private membership helper stays private', NOT has_function_privilege('authenticated','public._session_membership()','EXECUTE') AND NOT has_function_privilege('anon','public._session_membership()','EXECUTE')
UNION ALL SELECT 'all clauses reject support through scoped API', count(*)=3 AND bool_and(
 roles=ARRAY['authenticated']::name[] AND cmd IN ('SELECT','INSERT','UPDATE')
 AND (cmd='INSERT' OR (qual LIKE '%current_user_organization_id%' AND qual LIKE '%has_org_role%' AND qual LIKE '%my_session%' AND qual LIKE '%support%' AND qual NOT LIKE '%_session_membership%' AND qual !~ '\mOR\M'))
 AND (cmd='SELECT' OR (with_check LIKE '%current_user_organization_id%' AND with_check LIKE '%has_org_role%' AND with_check LIKE '%my_session%' AND with_check LIKE '%support%' AND with_check NOT LIKE '%_session_membership%' AND with_check !~ '\mOR\M')))
 FROM pg_policies WHERE schemaname='public' AND tablename='company_setup_progress'
UNION ALL SELECT 'no orphan company progress', NOT EXISTS (SELECT 1 FROM public.company_setup_progress p LEFT JOIN public.organizations o ON o.id=p.organization_id WHERE o.id IS NULL);
-- Also run tests/db/company-setup-isolation.test.ts against a disposable database, never a live tenant.

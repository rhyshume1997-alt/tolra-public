-- Read only: after a separately approved release, every row must say true.
SELECT 'RLS enabled' AS check_name, relrowsecurity AS ok FROM pg_class WHERE oid='public.company_setup_progress'::regclass
UNION ALL SELECT 'three separate policies', count(*)=3 FROM pg_policies WHERE schemaname='public' AND tablename='company_setup_progress'
UNION ALL SELECT 'anon cannot read', NOT has_table_privilege('anon','public.company_setup_progress','SELECT')
UNION ALL SELECT 'authenticated cannot delete', NOT has_table_privilege('authenticated','public.company_setup_progress','DELETE')
UNION ALL SELECT 'no orphan company progress', NOT EXISTS (SELECT 1 FROM public.company_setup_progress p LEFT JOIN public.organizations o ON o.id=p.organization_id WHERE o.id IS NULL);
-- Also run tests/db/company-setup-isolation.test.ts against a disposable database, never a live tenant.

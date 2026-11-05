-- READ ONLY. Every row must be true. Does not enable costing or change any rate.
WITH tables AS (
 SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname IN ('job_costing_settings','job_machine_cost_rates','job_cost_estimates','job_costing_rate_history')
), fns AS (
 SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
 AND p.proname IN ('job_costing_access','save_job_costing_rates','save_job_cost_estimate','job_profitability_actual_inputs')
)
SELECT 'four_rls_tables_no_direct_writes' AS check_name, count(*) = 4 AND bool_and(relrowsecurity
 AND NOT has_table_privilege('authenticated',oid,'INSERT,UPDATE,DELETE')
 AND NOT has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE')) AS ok FROM tables
UNION ALL SELECT 'four_pinned_definers_no_anonymous_execute', count(*) = 4 AND bool_and(prosecdef
 AND proconfig = ARRAY['search_path=pg_catalog, public'] AND NOT has_function_privilege('anon',oid,'EXECUTE')
 AND NOT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')) FROM fns
UNION ALL SELECT 'default_off', EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
 AND table_name='job_costing_settings' AND column_name='enabled' AND column_default='false')
UNION ALL SELECT 'four_financial_read_policies', (SELECT count(*)=4 FROM pg_policies WHERE schemaname='public'
 AND tablename IN ('job_costing_settings','job_machine_cost_rates','job_cost_estimates','job_costing_rate_history') AND policyname='financial_read')
UNION ALL SELECT 'four_support_read_only_triggers', (SELECT count(*)=4 FROM pg_trigger WHERE tgname='support_read_only'
 AND tgrelid IN (SELECT oid FROM tables))
UNION ALL SELECT 'two_company_parent_guards', (SELECT count(*)=2 FROM pg_trigger WHERE tgname IN ('zz_same_org_machine','zz_same_org_job')
 AND tgrelid IN (SELECT oid FROM tables));

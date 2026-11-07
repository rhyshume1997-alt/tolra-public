-- Post-144 release 148 (optional actual job costing on 143's rates). READ ONLY: every row must be TRUE (12). Does not enable costing or change a rate.
WITH t(name) AS (VALUES ('job_costing_settings'), ('job_costing_machine_links'), ('job_cost_declarations'), ('job_cost_snapshots')),
tables AS (SELECT c.oid, c.relname, c.relrowsecurity FROM pg_class c WHERE c.oid IN (SELECT to_regclass('public.' || name) FROM t)),
api(sig) AS (VALUES ('public.set_job_costing_enabled(uuid,integer,boolean)'), ('public.save_job_costing_machine_links(uuid,jsonb)'),
  ('public.save_job_cost_declarations(uuid,boolean,boolean)'), ('public.refresh_job_cost_snapshot(uuid)'), ('public.job_profitability_actual_inputs(uuid)')),
internal(sig) AS (VALUES ('public.job_costing_access(boolean)'), ('public.job_cost_rates(uuid)'), ('public.job_cost_figures(uuid,uuid,jsonb)'),
  ('public.job_cost_take_snapshot(uuid,uuid,text)'), ('public.job_cost_snapshot_on_close()')),
helpers(sig) AS (VALUES ('public.job_cost_round(numeric,numeric)'), ('public.job_cost_us(tstzmultirange)'), ('public.job_cost_snapshot_frozen()'))
SELECT 'four_rls_tables_read_only_to_the_api' AS check_name, (SELECT count(*) = 4 AND bool_and(relrowsecurity
  AND has_table_privilege('authenticated', oid, 'SELECT') AND NOT has_table_privilege('authenticated', oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
  AND NOT has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AND NOT has_table_privilege('service_role', oid, 'INSERT,UPDATE,DELETE,TRUNCATE')) FROM tables) AS ok
UNION ALL SELECT 'four_financial_read_policies_only', (SELECT count(*) = 4 AND bool_and(cmd = 'SELECT' AND roles = '{authenticated}'
  AND qual LIKE '%current_user_organization_id()%' AND qual LIKE '%has_org_role(ARRAY[''admin''::text, ''office''::text])%' AND qual LIKE '%purchase-orders%')
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN (SELECT name FROM t))
-- The ONLY rate source is 143: no 148 table has a rate column; #378's own rate tables and rate editor do not exist; 143's one save function is unchanged.
UNION ALL SELECT 'no_second_rate_store_or_editor',
  NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (SELECT name FROM t) AND column_name LIKE '%rate%' AND column_name <> 'rates')
  AND to_regclass('public.job_machine_cost_rates') IS NULL AND to_regclass('public.job_costing_rate_history') IS NULL
  AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('save_job_costing_rates', 'save_job_cost_estimate'))
  AND coalesce((SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '2c779bca11212d8bf660c4526719c919' FROM pg_proc WHERE oid = to_regprocedure('public.save_costing_settings_atomic(uuid,jsonb,jsonb)')), FALSE)
UNION ALL SELECT 'default_off_and_no_company_on_at_install',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_costing_settings' AND column_name = 'enabled' AND column_default = 'false')
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.job_costing_settings') AND conname = 'job_costing_settings_approved' AND convalidated)
UNION ALL SELECT 'api_functions_pinned_definers_authenticated_only', (SELECT count(*) = 5 AND bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
  FROM api JOIN pg_proc p ON p.oid = to_regprocedure(api.sig))
UNION ALL SELECT 'internal_functions_not_callable_by_any_api_role', (SELECT count(*) = 8 AND bool_and(p.proconfig[1] LIKE 'search_path=pg_catalog%'
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))
  FROM (SELECT sig FROM internal UNION ALL SELECT sig FROM helpers) x JOIN pg_proc p ON p.oid = to_regprocedure(x.sig))
UNION ALL SELECT 'snapshot_taken_at_commit_on_finish_and_invoice', (SELECT count(*) = 2 AND bool_and(g.tgdeferrable AND g.tginitdeferred AND g.tgenabled = 'O'
  AND g.tgfoid = to_regprocedure('public.job_cost_snapshot_on_close()')) FROM pg_trigger g WHERE g.tgname = 'zz_job_cost_snapshot'
  AND g.tgrelid IN ('public.jobs'::regclass, 'public.invoices'::regclass))
UNION ALL SELECT 'snapshot_rates_frozen_one_per_job', EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.job_cost_snapshots')
  AND tgname = 'job_cost_snapshot_frozen' AND tgenabled = 'O' AND tgfoid = to_regprocedure('public.job_cost_snapshot_frozen()'))
  AND EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
              WHERE i.indrelid = to_regclass('public.job_cost_snapshots') AND i.indisunique AND i.indnatts = 1 AND a.attname = 'job_id')
UNION ALL SELECT 'snapshot_no_figure_without_complete', EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.job_cost_snapshots')
  AND conname = 'job_cost_snapshots_figures' AND convalidated)
  AND (SELECT bool_and(data_type = 'bigint') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_cost_snapshots' AND column_name LIKE '%pence')
UNION ALL SELECT 'four_support_read_only_triggers', (SELECT count(*) = 4 FROM pg_trigger WHERE tgname = 'support_read_only' AND tgrelid IN (SELECT oid FROM tables))
UNION ALL SELECT 'three_company_parent_guards', (SELECT count(*) = 3 FROM pg_trigger WHERE tgname IN ('zz_same_org_machine', 'zz_same_org_job') AND tgrelid IN (SELECT oid FROM tables))
UNION ALL SELECT 'company_delete_cascades', (SELECT count(*) = 4 FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.organizations'::regclass
  AND confdeltype = 'c' AND conrelid IN (SELECT oid FROM tables))
UNION ALL SELECT 'money_half_pennies_round_up',public.job_cost_round(1,2)=1 AND public.job_cost_round(5,2)=3 AND public.job_cost_round(1001,2)=501
  AND public.job_cost_round(9007199254740993::numeric,2)=4503599627370497::bigint
  AND public.job_cost_round(18446744073709551613::numeric,2)=9223372036854775807::bigint
  AND public.job_cost_round(NULL::numeric,2) IS NULL;

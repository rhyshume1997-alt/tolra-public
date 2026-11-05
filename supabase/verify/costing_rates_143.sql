-- Migration 143 (costing rates inside Tolra: costing_materials, costing_machines, costing_defaults, save_costing_settings_txn). Read only: every row should be TRUE (14).
WITH t(name) AS (VALUES ('costing_materials'), ('costing_machines'), ('costing_defaults')),
want(table_name, cols) AS (VALUES
  ('costing_materials', 'created_at:timestamp with time zone:NO,id:uuid:NO,name:text:NO,organization_id:uuid:NO,price_pence:integer:NO,price_unit:text:NO,scrap_pct:numeric:NO,updated_at:timestamp with time zone:NO,updated_by:uuid:YES'),
  ('costing_machines', 'created_at:timestamp with time zone:NO,hourly_rate_pence:integer:NO,id:uuid:NO,labour_rate_pence:integer:YES,name:text:NO,organization_id:uuid:NO,updated_at:timestamp with time zone:NO,updated_by:uuid:YES'),
  ('costing_defaults', 'default_margin_pct:numeric:NO,id:uuid:NO,labour_rate_pence:integer:NO,organization_id:uuid:NO,overhead_pct:numeric:NO,programming_rate_pence:integer:NO,updated_at:timestamp with time zone:NO,updated_by:uuid:YES')
)
SELECT 'three_tables_with_their_columns' AS check_name,
  (SELECT count(*) = 3 AND bool_and(w.cols = (SELECT string_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable, ',' ORDER BY c.column_name)
                                              FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = w.table_name))
   FROM want w) AS ok
-- Money in whole pence (INTEGER 0 to 10,000,000); percentages bounded; a price unit of kg or each; one-line names of 1 to 80 characters.
UNION ALL SELECT 'checks_validated',
  (SELECT count(*) = 11 AND bool_and(convalidated) FROM pg_constraint WHERE contype = 'c' AND conrelid IN (SELECT to_regclass('public.' || name) FROM t) AND conname IN (
     'costing_materials_name', 'costing_materials_price', 'costing_materials_price_unit', 'costing_materials_scrap',
     'costing_machines_name', 'costing_machines_hourly_rate', 'costing_machines_labour_rate',
     'costing_defaults_labour_rate', 'costing_defaults_programming_rate', 'costing_defaults_overhead', 'costing_defaults_margin'))
-- One name per company (ignoring case and outer spaces); one defaults row per company.
UNION ALL SELECT 'unique_names_and_one_defaults_row',
  (SELECT count(*) = 2 FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('costing_materials_org_name', 'costing_machines_org_name')
     AND indexdef LIKE 'CREATE UNIQUE INDEX % USING btree (organization_id, lower(btrim(name)))')
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.costing_defaults') AND conname = 'costing_defaults_org' AND contype = 'u')
UNION ALL SELECT 'rls_on',
  (SELECT count(*) = 3 FROM pg_class WHERE oid IN (SELECT to_regclass('public.' || name) FROM t) AND relrowsecurity)
-- One permissive policy per command, admin and office of the caller's own company, helpers in sub-selects (131's form).
UNION ALL SELECT 'policies_admin_office_own_company',
  (SELECT count(*) = 12 AND bool_and(p.permissive = 'PERMISSIVE' AND p.roles = '{authenticated}'
       AND p.policyname = p.tablename || ' office ' || lower(p.cmd)
       AND coalesce(p.qual, p.with_check) = '((organization_id = ( SELECT current_user_organization_id() AS current_user_organization_id)) AND ( SELECT has_org_role(ARRAY[''admin''::text, ''office''::text]) AS has_org_role))'
       AND (p.cmd <> 'UPDATE' OR p.with_check = p.qual) AND (p.cmd <> 'INSERT' OR p.qual IS NULL))
   FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename IN (SELECT name FROM t))
UNION ALL SELECT 'grants_authenticated_only',
  (SELECT bool_and(has_table_privilege('authenticated', 'public.' || name, 'SELECT, INSERT, UPDATE, DELETE')
                   AND NOT has_table_privilege('authenticated', 'public.' || name, 'TRUNCATE')
                   AND NOT has_table_privilege('anon', 'public.' || name, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) FROM t)
UNION ALL SELECT 'four_triggers_each',
  (SELECT count(*) = 12 FROM pg_trigger g WHERE NOT g.tgisinternal AND g.tgrelid IN (SELECT to_regclass('public.' || name) FROM t)
     AND g.tgname IN ('costing_rates_stamp', 'support_read_only', 'admin_mfa', 'audit_' || (SELECT relname FROM pg_class WHERE oid = g.tgrelid) || '_changes'))
UNION ALL SELECT 'stamp_is_143s_not_definer',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '7e262df9f33ad0ece30d5ac7122995f3' AND NOT p.prosecdef
                   AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.costing_rates_stamp()')), FALSE)
-- 131's check still holds with 143's policies in: no role or company helper called once per row.
UNION ALL SELECT 'no_helper_called_per_row',
  (SELECT count(*) FROM pg_catalog.pg_policies p
     WHERE p.schemaname = 'public' AND p.tablename IN (SELECT name FROM t)
       AND regexp_replace(coalesce(p.qual, '') || ' | ' || coalesce(p.with_check, ''), '\( SELECT (auth\.)?[a-z_]+\([^()]*\) AS [a-z_]+\)', '', 'g')
           ~ '(^|[^a-z_.])(has_org_role|current_user_organization_id)\(') = 0
UNION ALL SELECT 'company_delete_cascades',
  (SELECT count(*) = 3 FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public.organizations'::regclass AND confdeltype = 'c'
     AND conrelid IN (SELECT to_regclass('public.' || name) FROM t))
-- NO RATE IS BUILT IN: no figure column has a default, and every figure is NOT NULL (a machine's own labour rate may be NULL = use the company default).
-- A company with no defaults row, no machine or no material is not configured: costing is off for it.
UNION ALL SELECT 'no_built_in_rates',
  (SELECT count(*) = 9 AND bool_and(c.column_default IS NULL) AND bool_and((c.is_nullable = 'YES') = (c.table_name = 'costing_machines' AND c.column_name = 'labour_rate_pence'))
   FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name IN (SELECT name FROM t)
     AND c.column_name IN ('price_pence', 'price_unit', 'scrap_pct', 'hourly_rate_pence', 'labour_rate_pence', 'programming_rate_pence', 'overhead_pct', 'default_margin_pct'))
-- The rate tables are inputs only: nothing but their own company (organizations) is referenced by them, and no foreign key points at them.
UNION ALL SELECT 'inputs_only_no_foreign_key_into_them',
  NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid IN (SELECT to_regclass('public.' || name) FROM t))
-- The save function: this file's body, invoker (RLS and the table triggers apply), search_path pinned, authenticated only.
UNION ALL SELECT 'save_function_is_143s_invoker',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '2c779bca11212d8bf660c4526719c919' AND NOT p.prosecdef AND p.prorettype = 'void'::regtype
                   AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=pg_catalog%')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_costing_settings_txn(uuid,jsonb,jsonb)')), FALSE)
UNION ALL SELECT 'save_function_execute_authenticated_only',
  coalesce((SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('public', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_costing_settings_txn(uuid,jsonb,jsonb)')), FALSE);

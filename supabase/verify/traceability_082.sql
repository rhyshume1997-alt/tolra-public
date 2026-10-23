-- Migration 082 (ISO 9001: traceability before a pass, records kept, a simple supplier status). Read only: every row should be TRUE.
WITH fn AS (
  SELECT p.oid, p.prosecdef, p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
           OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS api
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.jobs_traceability()'), to_regprocedure('public.job_inspections_traceability()'),
                  to_regprocedure('public.purchase_orders_supplier_status()'), to_regprocedure('public.suppliers_status_guard()'),
                  to_regprocedure('public.suppliers_in_use_guard()'), to_regprocedure('public.customers_in_use_guard()'))
),
trg(tbl, name, fn) AS (
  VALUES ('public.jobs', 'jobs_traceability', 'public.jobs_traceability()'),
         ('public.job_inspections', 'job_inspections_traceability', 'public.job_inspections_traceability()'),
         ('public.purchase_orders', 'purchase_orders_supplier_status', 'public.purchase_orders_supplier_status()'),
         ('public.suppliers', 'suppliers_status_guard', 'public.suppliers_status_guard()'),
         ('public.suppliers', 'suppliers_in_use_guard', 'public.suppliers_in_use_guard()'),
         ('public.customers', 'customers_in_use_guard', 'public.customers_in_use_guard()')
),
col(tbl, name, type, not_null, def) AS (
  VALUES ('suppliers', 'supplier_status', 'text', TRUE, '''approved''::text'),
         ('customers', 'traceable_default', 'boolean', TRUE, 'false'), ('jobs', 'traceable', 'boolean', TRUE, 'false')
)
-- No new function is callable from the API (PUBLIC, anon, authenticated); each is SECURITY DEFINER with a fixed search_path.
SELECT 'functions_internal' AS check_name,
       (SELECT count(*) = 6 AND bool_and(NOT api) AND bool_and(prosecdef) AND bool_and(proconfig = ARRAY['search_path=pg_catalog, public']) FROM fn) AS ok
UNION ALL SELECT 'triggers_enabled',
  (SELECT count(*) = 6 FROM trg JOIN pg_trigger t ON t.tgrelid = to_regclass(trg.tbl) AND t.tgname = trg.name AND NOT t.tgisinternal
   WHERE t.tgenabled = 'O' AND t.tgfoid = to_regprocedure(trg.fn))
UNION ALL SELECT 'columns',
  (SELECT count(*) = 3 FROM col JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = col.tbl AND c.column_name = col.name
   WHERE c.data_type = col.type AND (c.is_nullable = 'NO') = col.not_null AND c.column_default IS NOT DISTINCT FROM col.def)
UNION ALL SELECT 'status_check',
  EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'c' AND conrelid = 'public.suppliers'::regclass AND conname = 'suppliers_supplier_status_check'
          AND pg_get_constraintdef(oid) = 'CHECK ((supplier_status = ANY (ARRAY[''approved''::text, ''conditional''::text, ''blocked''::text])))')
-- Every supplier has a valid status (the existing ones started approved).
UNION ALL SELECT 'suppliers_have_status',
  NOT EXISTS (SELECT 1 FROM public.suppliers WHERE supplier_status IS NULL OR supplier_status NOT IN ('approved', 'conditional', 'blocked'))
-- No row rule was added or changed on these tables (who sees what is unchanged): each keeps row security on.
UNION ALL SELECT 'row_security_on',
  (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.suppliers'::regclass, 'public.customers'::regclass, 'public.purchase_orders'::regclass,
                                                               'public.jobs'::regclass, 'public.job_inspections'::regclass))
-- job_inspections is still written only by the database's own functions (no insert, update or delete rule for API roles).
UNION ALL SELECT 'inspections_not_writable',
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'job_inspections' AND cmd <> 'SELECT');

-- Read only: after release 152 (SliQ go-live import route; registered in supabase/release-plan.json as phase 152, after 151), every row must say true.
-- What it proves: the map and batch tables exist with row security, are readable (not writable) through the API, and the map's records are
-- foreign keys that cascade; the map and batch guards are in place; only the preflight and the batch are callable, by signed-in users only,
-- both SECURITY DEFINER with a pinned search_path; every map row names a record that exists in its own company; every invoice in the map is
-- paid exactly the sum of its payments and never more than its total; no customer or invoice number appears twice in a company that used it.
SELECT 'tables: import_source_rows and import_source_batches exist with row security' AS check_name,
  coalesce((SELECT bool_and(c.relrowsecurity) AND count(*) = 2 FROM pg_class c WHERE c.oid IN (to_regclass('public.import_source_rows'), to_regclass('public.import_source_batches'))), false) AS ok
UNION ALL SELECT 'API: map and batches readable by signed-in users, never writable; nothing for anon',
  has_table_privilege('authenticated', 'public.import_source_rows', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.import_source_rows', 'INSERT,UPDATE,DELETE')
  AND has_table_privilege('authenticated', 'public.import_source_batches', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.import_source_batches', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('anon', 'public.import_source_rows', 'SELECT') AND NOT has_table_privilege('anon', 'public.import_source_batches', 'SELECT')
UNION ALL SELECT 'map: each record column is a foreign key with ON DELETE CASCADE (the map goes with its data)',
  (SELECT count(*) = 4 FROM pg_constraint c WHERE c.conrelid = to_regclass('public.import_source_rows') AND c.contype = 'f' AND c.confdeltype = 'c'
     AND c.confrelid IN (to_regclass('public.customers'), to_regclass('public.suppliers'), to_regclass('public.invoices'), to_regclass('public.invoice_payments')))
UNION ALL SELECT 'guards: map rows locked while their record exists; batches immutable',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.import_source_rows') AND tgname = 'import_source_rows_guard' AND tgenabled = 'O')
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('public.import_source_batches') AND tgname = 'import_source_batches_immutable' AND tgenabled = 'O')
UNION ALL SELECT 'functions: only the preflight and the batch are callable (signed-in only), both definer with a pinned search_path',
  (SELECT count(*) = 2 FROM pg_proc p WHERE (p.proname LIKE 'import_sliq%' OR p.proname LIKE 'import_source%') AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  AND (SELECT bool_and(p.prosecdef AND p.proconfig::TEXT LIKE '%search_path=pg_catalog, public%') FROM pg_proc p
       WHERE p.oid IN (to_regprocedure('public.import_sliq_preflight(text,jsonb,jsonb)'), to_regprocedure('public.import_sliq_batch(text,jsonb,text,text,integer,jsonb,boolean)')))
  AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE (p.proname LIKE 'import_sliq%' OR p.proname LIKE 'import_source%')
                  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE')))
UNION ALL SELECT 'data: every map row names an existing record of its own company',
  NOT EXISTS (SELECT 1 FROM public.import_source_rows m
              WHERE NOT EXISTS (SELECT 1 FROM public.customers x WHERE x.id = m.customer_id AND x.organization_id = m.organization_id)
                AND NOT EXISTS (SELECT 1 FROM public.suppliers x WHERE x.id = m.supplier_id AND x.organization_id = m.organization_id)
                AND NOT EXISTS (SELECT 1 FROM public.invoices x WHERE x.id = m.invoice_id AND x.organization_id = m.organization_id)
                AND NOT EXISTS (SELECT 1 FROM public.invoice_payments x WHERE x.id = m.payment_id AND x.organization_id = m.organization_id))
UNION ALL SELECT 'balances: every imported invoice is paid exactly the sum of its payments, never more than its total',
  NOT EXISTS (SELECT 1 FROM public.import_source_rows m JOIN public.invoices v ON v.id = m.invoice_id
              WHERE coalesce(v.amount_paid, 0) <> coalesce((SELECT sum(p.amount) FROM public.invoice_payments p WHERE p.invoice_id = v.id), 0) OR coalesce(v.amount_paid, 0) > v.total)
UNION ALL SELECT 'no duplicates: no invoice number twice in a company that imported',
  NOT EXISTS (SELECT 1 FROM public.invoices v WHERE v.organization_id IN (SELECT DISTINCT organization_id FROM public.import_source_rows)
              GROUP BY v.organization_id, v.invoice_ref HAVING count(*) > 1);

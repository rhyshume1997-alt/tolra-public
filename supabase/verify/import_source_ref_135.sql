-- Migration 135 (PROVISIONAL NUMBER: the SliQ number an imported invoice, quote or purchase order had in SliQ). Read only: every row
-- should be TRUE (6).
SELECT 'three_columns_text_nullable' AS check_name,
  (SELECT string_agg(table_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY table_name) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('invoices', 'quotes', 'purchase_orders') AND column_name = 'source_ref')
    = 'invoices:text:YES,purchase_orders:text:YES,quotes:text:YES' AS ok
UNION ALL SELECT 'three_checks_validated',
  (SELECT count(*) FROM pg_constraint WHERE conname IN ('invoices_source_ref_check', 'quotes_source_ref_check', 'purchase_orders_source_ref_check')
     AND convalidated AND contype = 'c') = 3
UNION ALL SELECT 'three_triggers_enabled',
  (SELECT count(*) FROM pg_trigger t WHERE t.tgname = 'source_ref_import_only' AND NOT t.tgisinternal AND t.tgenabled = 'O'
     AND t.tgfoid = to_regprocedure('public.source_ref_import_only()')
     AND t.tgrelid IN (to_regclass('public.invoices'), to_regclass('public.quotes'), to_regclass('public.purchase_orders'))) = 3
UNION ALL SELECT 'function_is_135s',
  coalesce((SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '169cd2798340f7ba1d43b8b85e3be923' AND NOT prosecdef
            AND proconfig = ARRAY['search_path=pg_catalog, public']
            FROM pg_proc WHERE oid = to_regprocedure('public.source_ref_import_only()')), FALSE)
UNION ALL SELECT 'function_not_callable_from_the_api',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
            FROM pg_proc WHERE oid = to_regprocedure('public.source_ref_import_only()')), FALSE)
UNION ALL SELECT 'source_ref_well_formed',
  NOT EXISTS (SELECT 1 FROM public.invoices WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.quotes WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.purchase_orders WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100));

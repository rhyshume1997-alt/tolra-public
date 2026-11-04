-- 140 rollback: ONLY with Rhys's approval. Removes the SliQ number on imported documents: the five source_ref_import_only triggers,
-- public.source_ref_import_only(), the five CHECKs and the five source_ref columns (invoices, quotes, purchase_orders, jobs,
-- sales_orders).
-- STOPS while any document has a source_ref: dropping the column would lose the number SliQ printed on an imported document (a
-- renamed duplicate such as INV-0100-B would no longer say it was INV-0100 in SliQ). Nothing else is touched. Run the whole text as
-- one transaction, then the release preflight (marker 140 shows "not applied").
BEGIN;
DO $ca_rollback_verify$
DECLARE checked record;
BEGIN
 FOR checked IN
-- Migration 140 (the SliQ number an imported invoice, quote, purchase order, job or sales order had in SliQ).
-- Read only: every row should be TRUE (6).
SELECT 'five_columns_text_nullable' AS check_name,
  (SELECT string_agg(table_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY table_name) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('invoices', 'quotes', 'purchase_orders', 'jobs', 'sales_orders') AND column_name = 'source_ref')
    = 'invoices:text:YES,jobs:text:YES,purchase_orders:text:YES,quotes:text:YES,sales_orders:text:YES' AS ok
UNION ALL SELECT 'five_checks_validated',
  (SELECT count(*) FROM pg_constraint WHERE conname IN ('invoices_source_ref_check', 'quotes_source_ref_check', 'purchase_orders_source_ref_check',
     'jobs_source_ref_check', 'sales_orders_source_ref_check') AND convalidated AND contype = 'c') = 5
UNION ALL SELECT 'five_triggers_enabled',
  (SELECT count(*) FROM pg_trigger t WHERE t.tgname = 'source_ref_import_only' AND NOT t.tgisinternal AND t.tgenabled = 'O'
     AND t.tgfoid = to_regprocedure('public.source_ref_import_only()')
     AND t.tgrelid IN (to_regclass('public.invoices'), to_regclass('public.quotes'), to_regclass('public.purchase_orders'),
                       to_regclass('public.jobs'), to_regclass('public.sales_orders'))) = 5
UNION ALL SELECT 'function_is_140s',
  coalesce((SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '169cd2798340f7ba1d43b8b85e3be923' AND NOT prosecdef
            AND proconfig = ARRAY['search_path=pg_catalog, public']
            FROM pg_proc WHERE oid = to_regprocedure('public.source_ref_import_only()')), FALSE)
UNION ALL SELECT 'function_not_callable_from_the_api',
  coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
            FROM pg_proc WHERE oid = to_regprocedure('public.source_ref_import_only()')), FALSE)
UNION ALL SELECT 'source_ref_well_formed',
  NOT EXISTS (SELECT 1 FROM public.invoices WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.quotes WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.purchase_orders WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.jobs WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
  AND NOT EXISTS (SELECT 1 FROM public.sales_orders WHERE source_ref IS NOT NULL AND (source_ref <> btrim(source_ref) OR length(source_ref) NOT BETWEEN 1 AND 100))
 LOOP
  IF checked.ok IS DISTINCT FROM true THEN RAISE EXCEPTION '140 rollback: reviewed shape differs, stop: %',checked.check_name; END IF;
 END LOOP;
END; $ca_rollback_verify$;

DO $$
DECLARE
  v_n BIGINT := 0;
  v_t TEXT;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['invoices', 'quotes', 'purchase_orders', 'jobs', 'sales_orders'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = v_t AND column_name = 'source_ref') THEN
      EXECUTE format('SELECT %s + count(*) FROM public.%I WHERE source_ref IS NOT NULL', v_n, v_t) INTO v_n;
    END IF;
  END LOOP;
  IF v_n > 0 THEN
    RAISE EXCEPTION '140 rollback stopped: % imported document(s) carry their SliQ number in source_ref; export them first and get Rhys''s approval to drop it', v_n;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS source_ref_import_only ON public.invoices;
DROP TRIGGER IF EXISTS source_ref_import_only ON public.quotes;
DROP TRIGGER IF EXISTS source_ref_import_only ON public.purchase_orders;
DROP TRIGGER IF EXISTS source_ref_import_only ON public.jobs;
DROP TRIGGER IF EXISTS source_ref_import_only ON public.sales_orders;
DROP FUNCTION IF EXISTS public.source_ref_import_only();
ALTER TABLE public.invoices        DROP CONSTRAINT IF EXISTS invoices_source_ref_check;
ALTER TABLE public.quotes          DROP CONSTRAINT IF EXISTS quotes_source_ref_check;
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_source_ref_check;
ALTER TABLE public.jobs            DROP CONSTRAINT IF EXISTS jobs_source_ref_check;
ALTER TABLE public.sales_orders    DROP CONSTRAINT IF EXISTS sales_orders_source_ref_check;
ALTER TABLE public.invoices        DROP COLUMN IF EXISTS source_ref;
ALTER TABLE public.quotes          DROP COLUMN IF EXISTS source_ref;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS source_ref;
ALTER TABLE public.jobs            DROP COLUMN IF EXISTS source_ref;
ALTER TABLE public.sales_orders    DROP COLUMN IF EXISTS source_ref;

COMMIT;

-- 135 rollback: ONLY with Rhys's approval. Removes the SliQ number on imported documents: the three source_ref_import_only triggers,
-- public.source_ref_import_only(), the three CHECKs and the three source_ref columns (invoices, quotes, purchase_orders).
-- STOPS while any document has a source_ref: dropping the column would lose the number SliQ printed on an imported document (a
-- renamed duplicate such as INV-0100-B would no longer say it was INV-0100 in SliQ). Nothing else is touched. Run the whole text as
-- one transaction, then the release preflight (marker 135 shows "not applied").
BEGIN;

DO $$
DECLARE
  v_n BIGINT := 0;
  v_t TEXT;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['invoices', 'quotes', 'purchase_orders'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = v_t AND column_name = 'source_ref') THEN
      EXECUTE format('SELECT %s + count(*) FROM public.%I WHERE source_ref IS NOT NULL', v_n, v_t) INTO v_n;
    END IF;
  END LOOP;
  IF v_n > 0 THEN
    RAISE EXCEPTION '135 rollback stopped: % imported document(s) carry their SliQ number in source_ref; export them first and get Rhys''s approval to drop it', v_n;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS source_ref_import_only ON public.invoices;
DROP TRIGGER IF EXISTS source_ref_import_only ON public.quotes;
DROP TRIGGER IF EXISTS source_ref_import_only ON public.purchase_orders;
DROP FUNCTION IF EXISTS public.source_ref_import_only();
ALTER TABLE public.invoices        DROP CONSTRAINT IF EXISTS invoices_source_ref_check;
ALTER TABLE public.quotes          DROP CONSTRAINT IF EXISTS quotes_source_ref_check;
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_source_ref_check;
ALTER TABLE public.invoices        DROP COLUMN IF EXISTS source_ref;
ALTER TABLE public.quotes          DROP COLUMN IF EXISTS source_ref;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS source_ref;

COMMIT;

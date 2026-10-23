-- Rollback of 089 (an invoice's receipts change only through the payment and credit steps; a draft is issued only with what its records
-- add up to). ONE transaction: run the whole text; if anything fails, nothing of it is kept. Only with Rhys's approval. Removes the
-- trigger zz_invoice_receipts on public.invoices and its function public.invoice_receipts_guard(); nothing else was created or changed by
-- 089, and no data is touched. Afterwards admin and office can again write a DRAFT invoice's amount paid, paid date, credits, refunds and
-- unverified flag through the API, move a draft to paid / part paid / credited, and issue a draft whatever it shows as paid (076's lock
-- still guards an issued invoice). STOPS (nothing changed) while the function exists with a body other than 089's. Safe to run twice.
-- Then `notify pgrst, 'reload schema';` and the release preflight (marker 089 "not applied").
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.invoice_receipts_guard()')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '18851e08d5d58c3bb648bb13e0fe0e22') THEN
    RAISE EXCEPTION '089 rollback: public.invoice_receipts_guard() is not 089''s; stop and compare';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS zz_invoice_receipts ON public.invoices;
DROP FUNCTION IF EXISTS public.invoice_receipts_guard();

DO $$
BEGIN
  IF to_regprocedure('public.invoice_receipts_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'zz_invoice_receipts' AND t.tgrelid = 'public.invoices'::regclass) THEN
    RAISE EXCEPTION '089 rollback: the trigger or its function is still there';
  END IF;
END
$$;

COMMIT;

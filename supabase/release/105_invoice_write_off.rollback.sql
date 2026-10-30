-- Rollback of 105 (an invoice is written off, and a write-off reversed, only with write_off_invoice / reverse_write_off). ONE
-- transaction: run the whole text; if anything fails, nothing of it is kept. Only with Rhys's approval. Removes the trigger
-- invoices_write_off_guard on public.invoices, its function public.invoices_write_off_guard(), and public.write_off_invoice(uuid, text)
-- and public.reverse_write_off(uuid, text). Nothing else was created or changed by 105, and no data is touched: invoices written off
-- (or brought back) through the two functions keep their status, and their WRITE_OFF_INVOICE / REVERSE_WRITE_OFF audit rows stay.
-- Afterwards admin and office can again move an issued or sent invoice to written off, and back, with a direct API update (S5-A1), and
-- the app's Write off / Reverse write-off answer "Available after database update 105".
-- STOPS (nothing changed) while any of the three functions exists with a body other than 105's. Safe to run twice. Then
-- `notify pgrst, 'reload schema';` and the release preflight (marker 105 "not applied").
BEGIN;

DO $$
DECLARE
  v_fn  TEXT;
  v_md5 TEXT;
BEGIN
  FOR v_fn, v_md5 IN VALUES
    ('public.invoices_write_off_guard()', '6ec5e742ef64fe23121c8099c42d2200'),
    ('public.write_off_invoice(uuid,text)', 'c7449f4564711533d43a1aa252eddfdf'),
    ('public.reverse_write_off(uuid,text)', '4750ac042335694164b634edca559f23') LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn) AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> v_md5) THEN
      RAISE EXCEPTION '105 rollback: % is not 105''s; stop and compare', v_fn;
    END IF;
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS invoices_write_off_guard ON public.invoices;
DROP FUNCTION IF EXISTS public.invoices_write_off_guard();
DROP FUNCTION IF EXISTS public.write_off_invoice(UUID, TEXT);
DROP FUNCTION IF EXISTS public.reverse_write_off(UUID, TEXT);

DO $$
BEGIN
  IF to_regprocedure('public.invoices_write_off_guard()') IS NOT NULL OR to_regprocedure('public.write_off_invoice(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.reverse_write_off(uuid,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'invoices_write_off_guard' AND t.tgrelid = 'public.invoices'::regclass) THEN
    RAISE EXCEPTION '105 rollback: the trigger or a function is still there';
  END IF;
END
$$;

COMMIT;

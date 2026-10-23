-- Rollback of 088 (a converted sales order's value and VAT are its job's). ONE transaction: run the whole text; if anything fails,
-- nothing of it is kept. Only with Rhys's approval. Removes the trigger zz_converted_order_money on public.sales_orders and its function
-- public.sales_orders_converted_money_guard(), and the trigger zz_converted_order_link on public.jobs and its function
-- public.jobs_converted_order_link_guard(); nothing else was created or changed by 088, and no data is touched. Afterwards admin and
-- office can again change a converted order's value and VAT through the API, and admin, office and workshop can again clear a job's
-- link to its order (the app still hides Edit on a converted order).
-- STOPS (nothing changed) while either function exists with a body other than 088's. Safe to run twice. Then `notify pgrst, 'reload schema';`
-- and the release preflight (marker 088 "not applied").
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.sales_orders_converted_money_guard()')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '6ef7d52b93dee149a290afec414ada86') THEN
    RAISE EXCEPTION '088 rollback: public.sales_orders_converted_money_guard() is not 088''s; stop and compare';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.jobs_converted_order_link_guard()')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'b81e2cea3f3051325c67bf065858b437') THEN
    RAISE EXCEPTION '088 rollback: public.jobs_converted_order_link_guard() is not 088''s; stop and compare';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS zz_converted_order_money ON public.sales_orders;
DROP FUNCTION IF EXISTS public.sales_orders_converted_money_guard();
DROP TRIGGER IF EXISTS zz_converted_order_link ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_converted_order_link_guard();

DO $$
BEGIN
  IF to_regprocedure('public.sales_orders_converted_money_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'zz_converted_order_money' AND t.tgrelid = 'public.sales_orders'::regclass)
     OR to_regprocedure('public.jobs_converted_order_link_guard()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'zz_converted_order_link' AND t.tgrelid = 'public.jobs'::regclass) THEN
    RAISE EXCEPTION '088 rollback: a trigger or its function is still there';
  END IF;
END
$$;

COMMIT;

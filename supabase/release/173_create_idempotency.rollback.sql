-- Rollback for release 173 (supabase/release/173_create_idempotency.release.sql).
-- Inputs: installed release 173 objects. Outputs: drops only release 173 functions, triggers, unique indexes, and request_id columns.
-- Safety: REFUSES without changing anything if any row in quotes, invoices, sales_orders, purchase_orders, or jobs holds a non-null request_id (never deletes history).
BEGIN;
DO $rollback_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quotes' AND column_name = 'request_id') THEN
    IF EXISTS (SELECT 1 FROM public.quotes WHERE request_id IS NOT NULL) THEN
      RAISE EXCEPTION '173 rollback: quotes holds non-null request_id values; this rollback never deletes history';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'request_id') THEN
    IF EXISTS (SELECT 1 FROM public.invoices WHERE request_id IS NOT NULL) THEN
      RAISE EXCEPTION '173 rollback: invoices holds non-null request_id values; this rollback never deletes history';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'request_id') THEN
    IF EXISTS (SELECT 1 FROM public.sales_orders WHERE request_id IS NOT NULL) THEN
      RAISE EXCEPTION '173 rollback: sales_orders holds non-null request_id values; this rollback never deletes history';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'purchase_orders' AND column_name = 'request_id') THEN
    IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE request_id IS NOT NULL) THEN
      RAISE EXCEPTION '173 rollback: purchase_orders holds non-null request_id values; this rollback never deletes history';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'request_id') THEN
    IF EXISTS (SELECT 1 FROM public.jobs WHERE request_id IS NOT NULL) THEN
      RAISE EXCEPTION '173 rollback: jobs holds non-null request_id values; this rollback never deletes history';
    END IF;
  END IF;
END
$rollback_guard$;

DROP FUNCTION IF EXISTS public.create_job_idempotent(UUID, TEXT, TEXT, BOOLEAN, UUID, DATE, JSONB, BOOLEAN, JSONB, TEXT);
DROP FUNCTION IF EXISTS public.create_purchase_order_idempotent(UUID, JSONB);
DROP FUNCTION IF EXISTS public.create_sales_order_idempotent(UUID, JSONB);
DROP FUNCTION IF EXISTS public.create_with_lines_idempotent(UUID, TEXT, JSONB, TEXT, TEXT, JSONB);

DROP TRIGGER IF EXISTS quotes_request_id_immutable ON public.quotes;
DROP TRIGGER IF EXISTS invoices_request_id_immutable ON public.invoices;
DROP TRIGGER IF EXISTS sales_orders_request_id_immutable ON public.sales_orders;
DROP TRIGGER IF EXISTS purchase_orders_request_id_immutable ON public.purchase_orders;
DROP TRIGGER IF EXISTS jobs_request_id_immutable ON public.jobs;
DROP FUNCTION IF EXISTS public.create_request_id_immutable();

DROP INDEX IF EXISTS public.quotes_org_request_uniq;
DROP INDEX IF EXISTS public.invoices_org_request_uniq;
DROP INDEX IF EXISTS public.sales_orders_org_request_uniq;
DROP INDEX IF EXISTS public.purchase_orders_org_request_uniq;
DROP INDEX IF EXISTS public.jobs_org_request_uniq;

ALTER TABLE public.quotes DROP COLUMN IF EXISTS request_id;
ALTER TABLE public.invoices DROP COLUMN IF EXISTS request_id;
ALTER TABLE public.sales_orders DROP COLUMN IF EXISTS request_id;
ALTER TABLE public.purchase_orders DROP COLUMN IF EXISTS request_id;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS request_id;
COMMIT;

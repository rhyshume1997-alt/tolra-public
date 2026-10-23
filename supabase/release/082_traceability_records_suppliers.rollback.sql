-- 082 rollback: ONLY with Rhys's approval. Drops what 082 added. The values in 082's columns go with them: supplier statuses, the
-- jobs' traceable flags and the customers' defaults. Their history stays in the activity trail (each change was audited). After it:
-- passes no longer need a cert no. and heat/cast no., used suppliers and customers can be deleted and renamed again, and purchase
-- orders are not checked against the Suppliers list or a supplier status. The app of 082 hides its fields when the columns are missing. Run the whole text as one
-- transaction, then the release preflight (082 shows "not applied").
BEGIN;
DROP TRIGGER IF EXISTS jobs_traceability ON public.jobs;
DROP TRIGGER IF EXISTS job_inspections_traceability ON public.job_inspections;
DROP TRIGGER IF EXISTS purchase_orders_supplier_status ON public.purchase_orders;
DROP TRIGGER IF EXISTS suppliers_status_guard ON public.suppliers;
DROP TRIGGER IF EXISTS suppliers_in_use_guard ON public.suppliers;
DROP TRIGGER IF EXISTS customers_in_use_guard ON public.customers;
DROP FUNCTION IF EXISTS public.jobs_traceability();
DROP FUNCTION IF EXISTS public.job_inspections_traceability();
DROP FUNCTION IF EXISTS public.purchase_orders_supplier_status();
DROP FUNCTION IF EXISTS public.suppliers_status_guard();
DROP FUNCTION IF EXISTS public.suppliers_in_use_guard();
DROP FUNCTION IF EXISTS public.customers_in_use_guard();
ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS suppliers_supplier_status_check;
ALTER TABLE public.suppliers DROP COLUMN IF EXISTS supplier_status;
ALTER TABLE public.customers DROP COLUMN IF EXISTS traceable_default;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS traceable;
COMMIT;

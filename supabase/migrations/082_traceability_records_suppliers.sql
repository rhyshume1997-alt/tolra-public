-- =====================================================================================================
-- 082: ISO 9001 traceability (8.5.2), records kept (7.5.3) and a simple supplier status (8.4) (Rhys, ISO 9001 plan, PR B; scope cut by
-- Rhys, agreed by Grok and ChatGPT, Tue 20 Oct: no review date, no reminders, no override). Applies after 081. Needs 034
-- (job_inspections; cert and heat/cast numbers on jobs since 022) and the stock and RFQ tables (000).
--
-- WHAT CHANGES.
-- 1. 8.5.2 traceability. jobs.traceable (default FALSE) and customers.traceable_default (default FALSE: low risk is the default).
--    A new job takes its customer's default (by the customer's name, ignoring case and surrounding spaces, or the sales order's
--    customer); afterwards admin or office set the flag on the job. On a traceable job an inspection PASS needs the job's
--    material cert no. and heat/cast no. (the worksheet's existing fields: nothing is typed twice). Enforced by a trigger on
--    job_inspections, so every pass path (record_job_inspection, 081's, an offline replay) is checked by the server. A concession
--    and a fail are not affected.
-- 2. 7.5.3 records kept. A supplier that is on a purchase order, a job's material supplier or a stock item's preferred supplier,
--    or a customer on any quote, RFQ, sales order, job, delivery note, invoice or credit note, is not deleted and not renamed
--    (records name it by its name; decided Tue 20 Oct) with a plain message (hint supplier_in_use / customer_in_use). A change of
--    case or surrounding spaces only is allowed. Suppliers and customers have no archive (later); a supplier that should get no
--    more orders is set to Blocked. Only browser sessions (anon, authenticated) are refused: the service role, a migration, and
--    076's undo of an import it made are not.
-- 3. 8.4 supplier status, a simple flag: suppliers.supplier_status approved / conditional / blocked (existing suppliers: approved).
--    Decided Tue 20 Oct: only an admin changes it (hint supplier_status_admin_only); a new purchase order names a supplier on the
--    Suppliers list (hint supplier_not_listed; an existing order keeps its name); an order is raised when it is issued from draft,
--    and an order to a blocked supplier is refused then (hint supplier_blocked); a conditional supplier is a warning in the app at
--    issue. 076's import is not checked. The supplier rows are locked FOR SHARE while an order is checked, so deleting or renaming
--    the supplier, or changing its status, waits for that order.
-- Every change is in the activity trail (the existing row audit triggers on suppliers, customers, jobs and purchase_orders: who and
-- when, old and new values). Row rules, grants and two-step sign-in are unchanged: no policy is added or changed; every new
-- function is internal (no PUBLIC, anon or authenticated EXECUTE).
--
-- GUARD (section 1): what it needs exists. SELF-CHECK (section 6): the same checks as supabase/verify/traceability_082.sql.
-- Rollback: supabase/release/082_traceability_records_suppliers.rollback.sql (drops what this adds; only with Rhys's approval: the
-- statuses and flags go, their history stays in the activity trail).
-- =====================================================================================================

-- 1. The guard.
DO $$
BEGIN
  IF to_regclass('public.job_inspections') IS NULL OR to_regclass('public.suppliers') IS NULL OR to_regclass('public.customers') IS NULL
     OR to_regclass('public.purchase_orders') IS NULL OR to_regclass('public.stock') IS NULL OR to_regclass('public.rfqs') IS NULL
     OR to_regclass('public.credit_notes') IS NULL OR to_regclass('public.delivery_notes') IS NULL THEN
    RAISE EXCEPTION '082: a table it needs is missing (job_inspections, suppliers, customers, purchase_orders, stock, rfqs, credit_notes, delivery_notes)';
  END IF;
  IF to_regprocedure('public.has_org_role(text[])') IS NULL THEN
    RAISE EXCEPTION '082: public.has_org_role(text[]) is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'heat_cast_no')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'material_cert_no') THEN
    RAISE EXCEPTION '082: jobs.material_cert_no or jobs.heat_cast_no is missing';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The new columns. Existing suppliers become approved (the column default); no existing job or customer is traceable.
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS supplier_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS traceable_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS traceable BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.suppliers'::regclass AND conname = 'suppliers_supplier_status_check') THEN
    ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_supplier_status_check CHECK (supplier_status IN ('approved', 'conditional', 'blocked'));
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 3. 8.5.2: a job's traceable flag and the pass check.
-- A new job takes its customer's default; afterwards only admin and office change the flag (row audit records who and when).
CREATE OR REPLACE FUNCTION public.jobs_traceability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.traceable := coalesce(NEW.traceable, FALSE) OR EXISTS (
      SELECT 1 FROM public.customers c
      WHERE c.organization_id = NEW.organization_id AND c.traceable_default
        AND (lower(btrim(c.name)) = lower(btrim(coalesce(NEW.customer, '')))
             OR c.id = (SELECT s.customer_id FROM public.sales_orders s
                        WHERE s.id = NEW.converted_from_sales_order_id AND s.organization_id = NEW.organization_id)));
    RETURN NEW;
  END IF;
  IF NEW.traceable IS DISTINCT FROM OLD.traceable
     AND coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IN ('anon', 'authenticated')
     AND NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Job %: only admin and office staff change whether it is traceable.', OLD.job_no USING ERRCODE = '42501';
  END IF;
  NEW.traceable := coalesce(NEW.traceable, FALSE);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.jobs_traceability() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS jobs_traceability ON public.jobs;
CREATE TRIGGER jobs_traceability BEFORE INSERT OR UPDATE OF traceable ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_traceability();

-- A pass on a traceable job needs the material cert no. and heat/cast no. on the job (every pass path inserts here).
CREATE OR REPLACE FUNCTION public.job_inspections_traceability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job RECORD;
  v_missing TEXT[];
BEGIN
  IF NEW.result IS DISTINCT FROM 'pass' THEN
    RETURN NEW;
  END IF;
  SELECT j.job_no, j.traceable, j.material_cert_no, j.heat_cast_no INTO v_job
  FROM public.jobs j WHERE j.id = NEW.job_id AND j.organization_id = NEW.organization_id;
  IF FOUND AND v_job.traceable THEN
    IF coalesce(btrim(v_job.material_cert_no), '') = '' THEN v_missing := array_append(v_missing, 'material cert no.'); END IF;
    IF coalesce(btrim(v_job.heat_cast_no), '') = '' THEN v_missing := array_append(v_missing, 'heat/cast no.'); END IF;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION '% is traceable: enter its % on the worksheet before it can pass.', v_job.job_no, array_to_string(v_missing, ' and ')
        USING ERRCODE = '22023', HINT = 'traceability_missing';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.job_inspections_traceability() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS job_inspections_traceability ON public.job_inspections;
CREATE TRIGGER job_inspections_traceability BEFORE INSERT ON public.job_inspections
  FOR EACH ROW EXECUTE FUNCTION public.job_inspections_traceability();

-- -----------------------------------------------------------------------------------------------------
-- 4. 8.4 (decided Tue 20 Oct): a new purchase order names a supplier on the Suppliers list (created, or a draft's supplier changed;
-- an existing order keeps the name it has). A purchase order is raised when it is issued from draft: an order to a blocked supplier
-- is refused then (a draft to it can still be made and edited). Conditional: a warning in the app at issue, nothing refused.
CREATE OR REPLACE FUNCTION public.purchase_orders_supplier_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_name    TEXT := lower(btrim(coalesce(NEW.supplier, '')));
  v_listed  BOOLEAN := TRUE;
  v_issuing BOOLEAN := coalesce(NEW.status, 'draft') NOT IN ('draft', 'cancelled');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_listed := NEW.supplier IS DISTINCT FROM OLD.supplier;
    v_issuing := v_issuing AND coalesce(OLD.status, 'draft') = 'draft';
  END IF;
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated')
     OR current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT OR NOT (v_listed OR v_issuing) THEN
    RETURN NEW;
  END IF;
  -- Held to the end of this transaction: deleting or renaming the supplier, or changing its status, waits for this order (and an
  -- order that waited for one of those sees the supplier as it now is: a supplier deleted or renamed meanwhile is not on the list).
  PERFORM 1 FROM public.suppliers s WHERE s.organization_id = NEW.organization_id AND lower(btrim(s.name)) = v_name FOR SHARE;
  IF v_listed AND NOT FOUND THEN
    RAISE EXCEPTION '%', CASE WHEN v_name = '' THEN 'Choose the supplier from the Suppliers list.'
                              ELSE format('Choose the supplier from the Suppliers list: %s isn''t on it. Add it on the Suppliers page first.', btrim(NEW.supplier)) END
      USING ERRCODE = '22023', HINT = 'supplier_not_listed';
  END IF;
  IF v_issuing AND EXISTS (SELECT 1 FROM public.suppliers s WHERE s.organization_id = NEW.organization_id AND lower(btrim(s.name)) = v_name AND s.supplier_status = 'blocked') THEN
    RAISE EXCEPTION '% is a blocked supplier, so this purchase order can''t be issued. An admin can change its status on the Suppliers page.', btrim(NEW.supplier)
      USING ERRCODE = '22023', HINT = 'supplier_blocked';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.purchase_orders_supplier_status() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS purchase_orders_supplier_status ON public.purchase_orders;
CREATE TRIGGER purchase_orders_supplier_status BEFORE INSERT OR UPDATE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.purchase_orders_supplier_status();

-- Only an admin changes a supplier's status (decided Tue 20 Oct). A new supplier starts approved unless an admin sets another status.
CREATE OR REPLACE FUNCTION public.suppliers_status_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) IN ('anon', 'authenticated')
     AND current_setting('quoteflow.data_import', TRUE) IS DISTINCT FROM NEW.organization_id::TEXT
     AND ((TG_OP = 'INSERT' AND NEW.supplier_status IS DISTINCT FROM 'approved')
          OR (TG_OP = 'UPDATE' AND NEW.supplier_status IS DISTINCT FROM OLD.supplier_status))
     AND NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can change a supplier''s status.' USING ERRCODE = '42501', HINT = 'supplier_status_admin_only';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.suppliers_status_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS suppliers_status_guard ON public.suppliers;
CREATE TRIGGER suppliers_status_guard BEFORE INSERT OR UPDATE OF supplier_status ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.suppliers_status_guard();

-- 5. 7.5.3: a supplier or customer that records use is never deleted or renamed (records name it by its name: a rename would leave
-- them pointing at nothing). A change of case or surrounding spaces only is not a rename (the match ignores both). Counted past the
-- row rules (a person without the purchase orders page must not be able to delete a supplier those orders use).
CREATE OR REPLACE FUNCTION public.suppliers_in_use_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_name  TEXT := lower(btrim(OLD.name));
  v_pos   INTEGER;
  v_jobs  INTEGER;
  v_stock INTEGER;
  v_uses  TEXT[];
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT)
     OR (TG_OP = 'UPDATE' AND lower(btrim(NEW.name)) IS NOT DISTINCT FROM v_name) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT count(*) INTO v_pos FROM public.purchase_orders p WHERE p.organization_id = OLD.organization_id AND lower(btrim(p.supplier)) = v_name;
  SELECT count(*) INTO v_jobs FROM public.jobs j WHERE j.organization_id = OLD.organization_id AND lower(btrim(j.material_supplier)) = v_name;
  SELECT count(*) INTO v_stock FROM public.stock s WHERE s.organization_id = OLD.organization_id AND lower(btrim(s.preferred_supplier)) = v_name;
  IF v_pos > 0 THEN v_uses := array_append(v_uses, v_pos || CASE WHEN v_pos = 1 THEN ' purchase order' ELSE ' purchase orders' END); END IF;
  IF v_jobs > 0 THEN v_uses := array_append(v_uses, v_jobs || CASE WHEN v_jobs = 1 THEN ' job' ELSE ' jobs' END); END IF;
  IF v_stock > 0 THEN v_uses := array_append(v_uses, v_stock || CASE WHEN v_stock = 1 THEN ' stock item' ELSE ' stock items' END); END IF;
  IF v_uses IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '% is on % and can''t be deleted: those records keep it. To stop new orders, an admin can set it to Blocked.',
        btrim(OLD.name), array_to_string(v_uses, ', ') USING ERRCODE = '22023', HINT = 'supplier_in_use';
    END IF;
    RAISE EXCEPTION '% is on % and can''t be renamed: those records keep its name. Add the new name as another supplier instead.',
      btrim(OLD.name), array_to_string(v_uses, ', ') USING ERRCODE = '22023', HINT = 'supplier_in_use';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.suppliers_in_use_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS suppliers_in_use_guard ON public.suppliers;
CREATE TRIGGER suppliers_in_use_guard BEFORE UPDATE OF name OR DELETE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.suppliers_in_use_guard();

CREATE OR REPLACE FUNCTION public.customers_in_use_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org  UUID := OLD.organization_id;
  v_name TEXT := lower(btrim(OLD.name));
  v_n    INTEGER;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated')
     OR (TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT)
     OR (TG_OP = 'UPDATE' AND lower(btrim(NEW.name)) IS NOT DISTINCT FROM v_name) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT (SELECT count(*) FROM public.quotes x WHERE x.organization_id = v_org AND lower(btrim(x.customer)) = v_name)
       + (SELECT count(*) FROM public.rfqs x WHERE x.organization_id = v_org AND lower(btrim(x.customer)) = v_name)
       + (SELECT count(*) FROM public.sales_orders x WHERE x.organization_id = v_org AND (x.customer_id = OLD.id OR lower(btrim(x.customer)) = v_name))
       + (SELECT count(*) FROM public.jobs x WHERE x.organization_id = v_org AND lower(btrim(x.customer)) = v_name)
       + (SELECT count(*) FROM public.delivery_notes x WHERE x.organization_id = v_org AND (x.customer_id = OLD.id OR lower(btrim(x.customer)) = v_name))
       + (SELECT count(*) FROM public.invoices x WHERE x.organization_id = v_org AND lower(btrim(x.customer)) = v_name)
       + (SELECT count(*) FROM public.credit_notes x WHERE x.organization_id = v_org AND lower(btrim(x.customer)) = v_name)
    INTO v_n;
  IF v_n > 0 THEN
    RAISE EXCEPTION '% is on % (quotes, RFQs, orders, jobs, delivery notes, invoices or credit notes) and can''t be %: those records keep its name.',
      btrim(OLD.name), v_n || CASE WHEN v_n = 1 THEN ' document' ELSE ' documents' END, CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE 'renamed' END
      USING ERRCODE = '22023', HINT = 'customer_in_use';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.customers_in_use_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS customers_in_use_guard ON public.customers;
CREATE TRIGGER customers_in_use_guard BEFORE UPDATE OF name OR DELETE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.customers_in_use_guard();

-- -----------------------------------------------------------------------------------------------------
-- 6. Self-check before COMMIT (the same checks as supabase/verify/traceability_082.sql).
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.jobs_traceability()', 'public.job_inspections_traceability()', 'public.purchase_orders_supplier_status()',
                              'public.suppliers_status_guard()', 'public.suppliers_in_use_guard()', 'public.customers_in_use_guard()'] LOOP
    IF to_regprocedure(v_fn) IS NULL
       OR has_function_privilege('anon', to_regprocedure(v_fn), 'EXECUTE') OR has_function_privilege('authenticated', to_regprocedure(v_fn), 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = to_regprocedure(v_fn) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '082: % is missing or callable from the API', v_fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled = 'O' AND (t.tgrelid, t.tgname) IN (
        ('public.jobs'::regclass, 'jobs_traceability'), ('public.job_inspections'::regclass, 'job_inspections_traceability'),
        ('public.purchase_orders'::regclass, 'purchase_orders_supplier_status'), ('public.suppliers'::regclass, 'suppliers_status_guard'),
        ('public.suppliers'::regclass, 'suppliers_in_use_guard'), ('public.customers'::regclass, 'customers_in_use_guard'))) <> 6 THEN
    RAISE EXCEPTION '082: a trigger is missing or not enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.suppliers WHERE supplier_status IS NULL OR supplier_status NOT IN ('approved', 'conditional', 'blocked')) THEN
    RAISE EXCEPTION '082: a supplier has no valid status';
  END IF;
END
$$;

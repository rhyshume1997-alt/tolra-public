-- =====================================================================================================
-- 088: a converted sales order's value and VAT are its job's (Rhys, Thu 22 Oct: "converted SO guard (UI plus DB check)"). Applies
-- after 085 and 084 (in either order); independent of 086 and 087. Needs only 000 / 010 / 018 (sales_orders, its VAT columns, the
-- order <-> job link).
--
-- WHY. convert_sales_order (018, last replaced by 080) copies the order's total_value to the job it makes (job_values.value), and
-- ensure_sales_order_lines (034, 068) builds the order's lines, which delivery notes and invoices are made against, from total_value,
-- vat_pct and vat_exempt while nothing has been despatched. Before 088 nothing in the database stopped admin or office from changing a
-- converted order's value or VAT ("sales_orders rbac update" allows every column; the Edit dialog and a plain API PATCH both did it):
-- the job kept the old value, the order showed the new one, and lines made later followed the new one.
--
-- WHAT CHANGES. One BEFORE UPDATE OF total_value, vat_enabled, vat_pct, vat_exempt trigger on public.sales_orders. For a signed-in
-- session (the API roles anon and authenticated, including inside their SECURITY DEFINER calls), a change of any of the four is refused
-- (42501, hint sales_order_converted, "Converted to J-0042: change the job, not the order.") once the order is converted: its
-- converted_to_job_id is set, or a job of the company names it in jobs.converted_from_sales_order_id (convert_sales_order treats
-- either side of the link as converted; checking both means clearing the order's own link first does not reopen its money).
-- Writing the same value again (the Edit dialog sends all four) is not a change and passes.
-- And one BEFORE UPDATE OF converted_from_sales_order_id trigger on public.jobs: for a signed-in session, clearing or changing a job's
-- converted_from_sales_order_id is refused (42501, hint sales_order_converted, "J-0042 was made from SO-0007: the link stays.") while
-- the order it names still exists in the company. Without it, clearing both sides of the link (the order's, then the job's: jobs'
-- update policy allows admin, office and workshop) and then editing would get round the first trigger in three steps. Setting the
-- link from empty (the conversion) passes.
-- NOT FROZEN (deliberately minimal): customer, customer_id, customer_po, delivery and order dates, notes, status and the order's
-- own converted_to_job_id.
-- The job copies customer, PO and dates once at conversion and keeps its own copies (jobs.customer, customer_po, due_date,
-- date_required); set_sales_order_customer_po (058) updates an unfinished job's PO on purpose; status moves on after conversion
-- (despatched, closed). The order's converted_to_job_id stays writable (the import's undo clears it); the job's side is what holds.
-- The app hides Edit on a converted order (one rule, lib/sales-order-convert.ts editBlockedReason) and has no unlink action.
-- UNCHANGED PATHS (none writes a converted order's money): the conversion itself (status, converted_to_job_id, converted_at only),
-- accept_quote (an INSERT), set_sales_order_customer_po, Despatch (status), archive (028's record_archive rows), the data import and
-- its undo (076 / 079 / 085: INSERTs, the order's link set or cleared, DELETEs; none UPDATEs a job's link), a job's deletion (ON DELETE
-- SET NULL of the order's link), an order's deletion (ON DELETE SET NULL of the job's link: the order is gone by then, so it passes).
-- The database owner and the service role are exempt, as 082's and 083's guards are (maintenance, the SQL editor, the server's own jobs).
-- GUARD (section 1): each function, if present, must be 088's (md5 with every whitespace character removed). Safe to run again.
-- Rollback: supabase/release/088_converted_sales_order_guard.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 088 builds on is there, and its own functions, if present, are 088's.
DO $$
BEGIN
  IF to_regclass('public.sales_orders') IS NULL OR to_regclass('public.jobs') IS NULL THEN
    RAISE EXCEPTION '088: sales_orders or jobs (000) is missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales_orders'
        AND column_name IN ('total_value', 'vat_enabled', 'vat_pct', 'vat_exempt', 'converted_to_job_id')) <> 5
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name = 'converted_from_sales_order_id') THEN
    RAISE EXCEPTION '088: a sales order money / VAT column (000, 010) or the order <-> job link (000, 018) is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.sales_orders_converted_money_guard()')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '6ef7d52b93dee149a290afec414ada86') THEN
    RAISE EXCEPTION '088: public.sales_orders_converted_money_guard() already exists with another body; stop and compare it first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.jobs_converted_order_link_guard()')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'b81e2cea3f3051325c67bf065858b437') THEN
    RAISE EXCEPTION '088: public.jobs_converted_order_link_guard() already exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The check. SECURITY DEFINER so the job is found whatever the caller's sections allow (jobs' RLS); it reads only the job that the
-- order's own link names, in the order's company. Not callable from the API (a trigger function).
CREATE OR REPLACE FUNCTION public.sales_orders_converted_money_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job_no TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated')
     OR (NEW.total_value IS NOT DISTINCT FROM OLD.total_value AND NEW.vat_enabled IS NOT DISTINCT FROM OLD.vat_enabled
         AND NEW.vat_pct IS NOT DISTINCT FROM OLD.vat_pct AND NEW.vat_exempt IS NOT DISTINCT FROM OLD.vat_exempt) THEN
    RETURN NEW;
  END IF;
  SELECT j.job_no INTO v_job_no
  FROM public.jobs j
  WHERE j.organization_id = OLD.organization_id AND (j.id = OLD.converted_to_job_id OR j.converted_from_sales_order_id = OLD.id)
  ORDER BY (j.id = OLD.converted_to_job_id) DESC NULLS LAST, j.created_at
  LIMIT 1;
  IF FOUND OR OLD.converted_to_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'Converted to %: change the job, not the order.', coalesce(nullif(btrim(v_job_no), ''), 'a job')
      USING ERRCODE = '42501', HINT = 'sales_order_converted';
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2b. Internal only, and the trigger. Named zz_ so it runs after the same-org, stamp and audit triggers of sales_orders, as 082's
-- and 083's guards do. (Its own section so the upgrade rehearsal's mid-file failure point, the middle "-- -----" break, falls after
-- the function is created: the rehearsal needs an object above that point to prove the rollback with.)
REVOKE ALL ON FUNCTION public.sales_orders_converted_money_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_converted_order_money ON public.sales_orders;
CREATE TRIGGER zz_converted_order_money BEFORE UPDATE OF total_value, vat_enabled, vat_pct, vat_exempt ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.sales_orders_converted_money_guard();

-- -----------------------------------------------------------------------------------------------------
-- 2c. The job's side of the link. Without it a signed-in user could clear the order's converted_to_job_id, then the job's
-- converted_from_sales_order_id (jobs' update policy allows admin, office and workshop), and then change the order's money: section 2
-- would find no link. For a signed-in session, clearing or changing a job's converted_from_sales_order_id is refused while the order it
-- names still exists in the job's company. Setting it from empty (the conversion; the import's INSERTs never fire it) passes. The order's
-- deletion passes: its ON DELETE SET NULL runs after the order row is gone. SECURITY DEFINER so the order is found whatever the caller's
-- RLS shows; it reads only the order the job's own link names. Not callable from the API (a trigger function).
CREATE OR REPLACE FUNCTION public.jobs_converted_order_link_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_so_number TEXT;
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated')
     OR OLD.converted_from_sales_order_id IS NULL
     OR NEW.converted_from_sales_order_id IS NOT DISTINCT FROM OLD.converted_from_sales_order_id THEN
    RETURN NEW;
  END IF;
  SELECT s.so_number INTO v_so_number
  FROM public.sales_orders s
  WHERE s.id = OLD.converted_from_sales_order_id AND s.organization_id = OLD.organization_id;
  IF FOUND THEN
    RAISE EXCEPTION '% was made from %: the link stays.', coalesce(nullif(btrim(OLD.job_no), ''), 'This job'),
      coalesce(nullif(btrim(v_so_number), ''), 'a sales order')
      USING ERRCODE = '42501', HINT = 'sales_order_converted';
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2d. Internal only, and the trigger on jobs (zz_, after jobs' own stamp and same-company triggers).
REVOKE ALL ON FUNCTION public.jobs_converted_order_link_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_converted_order_link ON public.jobs;
CREATE TRIGGER zz_converted_order_link BEFORE UPDATE OF converted_from_sales_order_id ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_converted_order_link_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check before COMMIT: both bodies are 088's, neither is callable from the API, and the triggers are on sales_orders and jobs.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.sales_orders_converted_money_guard()')) IS DISTINCT FROM '6ef7d52b93dee149a290afec414ada86'
     OR NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.sales_orders_converted_money_guard()')) THEN
    RAISE EXCEPTION '088: sales_orders_converted_money_guard is not 088''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.sales_orders_converted_money_guard()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sales_orders_converted_money_guard()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '088: sales_orders_converted_money_guard is callable from the API';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'zz_converted_order_money' AND t.tgrelid = 'public.sales_orders'::regclass
                   AND t.tgfoid = 'public.sales_orders_converted_money_guard()'::regprocedure AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '088: the converted order trigger is missing';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.jobs_converted_order_link_guard()')) IS DISTINCT FROM 'b81e2cea3f3051325c67bf065858b437'
     OR NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.jobs_converted_order_link_guard()')) THEN
    RAISE EXCEPTION '088: jobs_converted_order_link_guard is not 088''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.jobs_converted_order_link_guard()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.jobs_converted_order_link_guard()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '088: jobs_converted_order_link_guard is callable from the API';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'zz_converted_order_link' AND t.tgrelid = 'public.jobs'::regclass
                   AND t.tgfoid = 'public.jobs_converted_order_link_guard()'::regprocedure AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '088: the converted job link trigger is missing';
  END IF;
END
$$;

-- =====================================================================================================
-- 018: sales order -> job conversion in one transaction, exactly once (audit B2: D3, D4, D15, A3).
--
-- Before: the browser inserted the job, then its value, then linked the order: three separate writes, with
-- best-effort clean-up. A retry, a double click, two people at once, or converting a despatched order (despatch
-- replaced the "converted" status but kept the link) could create a second job or leave half a conversion.
--
-- public.convert_sales_order(order id) now does it all in one transaction:
--   * locks the order row, so concurrent calls for one order run one after the other;
--   * returns the job it is already linked to (from either side of the link), whatever the order's status:
--     created = false, nothing new is written;
--   * otherwise allocates the job number (the quote's number QUO-1393 -> J-1393 when free, else next J number),
--     creates the job, its value (net order value, in job_values which the workshop can't read) and the link;
--   * gives the workshop the quote's line descriptions and quantities in the specification (no prices) and the
--     quantity when the quote has a single whole-number line; links the job to the quote;
--   * no longer invents a drawing file name ("<order>-order.pdf" never existed in storage).
-- Runs with the caller's rights (RLS applies): sales orders are admin-only.
--
-- A unique index makes "one job per order" a database rule. It is only created when no order already has
-- more than one job; otherwise a NOTICE says so and supabase/verify/duplicate_conversions.sql lists them for a
-- person to resolve (nothing is deleted). The row lock above prevents new duplicates either way.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

CREATE OR REPLACE FUNCTION public.convert_sales_order(p_order UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_order   public.sales_orders%ROWTYPE;
  v_job     public.jobs%ROWTYPE;
  v_quote   TEXT;
  v_job_no  TEXT;
  v_num     TEXT;
  v_lines   TEXT;
  v_count   INT;
  v_qty     NUMERIC;
  v_spec    TEXT;
  v_now     TIMESTAMPTZ := now();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can convert sales orders' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;

  -- Already converted (either side of the link): hand back that job, change nothing.
  SELECT j.* INTO v_job FROM public.jobs j
  WHERE j.organization_id = v_org AND (j.id = v_order.converted_to_job_id OR j.converted_from_sales_order_id = p_order)
  ORDER BY (j.id = v_order.converted_to_job_id) DESC NULLS LAST, j.created_at
  LIMIT 1;
  IF FOUND THEN
    IF v_order.converted_to_job_id IS DISTINCT FROM v_job.id THEN
      UPDATE public.sales_orders SET converted_to_job_id = v_job.id, converted_at = coalesce(converted_at, v_now) WHERE id = p_order;
    END IF;
    RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', FALSE);
  END IF;

  -- Job number: the quote's number when free, otherwise the next J number.
  v_quote := v_order.quote_ref;
  IF coalesce(v_quote, '') = '' AND v_order.quote_id IS NOT NULL THEN
    SELECT q.quote_ref INTO v_quote FROM public.quotes q WHERE q.id = v_order.quote_id AND q.organization_id = v_org;
  END IF;
  v_num := substring(coalesce(v_quote, '') FROM '^\s*[Qq][Uu][Oo][-\s]?(\d+)\s*$');
  IF v_num IS NOT NULL THEN
    v_job_no := 'J-' || CASE WHEN length(ltrim(v_num, '0')) < 4 THEN lpad(coalesce(nullif(ltrim(v_num, '0'), ''), '0'), 4, '0') ELSE ltrim(v_num, '0') END;
    IF EXISTS (SELECT 1 FROM public.jobs WHERE organization_id = v_org AND job_no = v_job_no) THEN
      v_job_no := NULL;
    END IF;
  END IF;
  IF v_job_no IS NULL THEN
    v_job_no := public.next_doc_number('J');
  END IF;

  -- What the workshop needs from the quote: descriptions and quantities, never prices.
  IF v_order.quote_id IS NOT NULL THEN
    SELECT string_agg('- ' || btrim(l.description) || ' x ' || trim_scale(l.quantity)::TEXT, E'\n' ORDER BY l.position, l.id),
           count(*), max(l.quantity)
      INTO v_lines, v_count, v_qty
    FROM public.quote_line_items l
    WHERE l.quote_id = v_order.quote_id AND l.organization_id = v_org;
  END IF;
  v_spec := 'Sales order ' || v_order.so_number
    || CASE WHEN v_order.delivery_date IS NOT NULL THEN '; customer delivery required ' || to_char(v_order.delivery_date, 'DD/MM/YYYY') ELSE '' END
    || '.'
    || CASE WHEN v_lines IS NOT NULL THEN E'\n' || coalesce(v_quote, 'Quote') || E':\n' || v_lines ELSE '' END;

  INSERT INTO public.jobs (
    organization_id, job_no, quote_id, customer, description, stage, due_date, status, specification, drawings,
    customer_po, quote_ref, date_received, date_required, quantity_required, converted_from_sales_order_id, converted_at)
  VALUES (
    v_org, v_job_no, v_order.quote_id, v_order.customer, 'Converted from ' || v_order.so_number, 'material',
    v_order.delivery_date, 'on_track', v_spec, '[]'::JSONB,
    v_order.so_number, nullif(v_quote, ''), v_order.order_date, v_order.delivery_date,
    CASE WHEN v_count = 1 AND v_qty >= 1 AND v_qty = trunc(v_qty) THEN v_qty::INT END,
    p_order, v_now)
  RETURNING * INTO v_job;

  INSERT INTO public.job_values (job_id, organization_id, value) VALUES (v_job.id, v_org, coalesce(v_order.total_value, 0));

  UPDATE public.sales_orders SET status = 'converted', converted_to_job_id = v_job.id, converted_at = v_now WHERE id = p_order;

  RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', TRUE);
END
$$;

REVOKE ALL ON FUNCTION public.convert_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_sales_order(UUID) TO authenticated;

-- One job per sales order, when the existing data allows it.
DO $$
DECLARE
  dupes BIGINT;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT converted_from_sales_order_id FROM public.jobs
    WHERE converted_from_sales_order_id IS NOT NULL
    GROUP BY converted_from_sales_order_id HAVING count(*) > 1) d;
  IF dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_per_sales_order
      ON public.jobs (converted_from_sales_order_id) WHERE converted_from_sales_order_id IS NOT NULL;
  ELSE
    RAISE NOTICE '018: % sales order(s) already have more than one job; unique index not created (see supabase/verify/duplicate_conversions.sql)', dupes;
  END IF;
END
$$;

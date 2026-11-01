-- WIP (not finished, not proved): 123 so_number always SO-####; customer_po its own column. Paused 1 Nov on coordinator request.
-- Missing: guard, grants section, self-check, release/rollback/verify, preflight marker, catalogue.

CREATE OR REPLACE FUNCTION public.create_sales_order_from_quote(p_quote UUID, p_customer_po TEXT, p_delivery_date DATE)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_quote      public.quotes%ROWTYPE;
  v_po         TEXT := nullif(btrim(coalesce(p_customer_po, '')), '');
  v_by_hand    CONSTANT TEXT := 'Choose "No linked quote" and enter the order by hand.';
  v_lines      INTEGER;
  v_declined   INTEGER;
  v_value      NUMERIC;  -- the order's net value: the sum of each ordered line's net, each rounded to the penny
  v_vat_on     BOOLEAN;
  v_choice     TEXT;     -- '20' | '5' | '0' | 'exempt'
  v_kinds      INTEGER;
  v_only       TEXT;
  v_first_pct  NUMERIC;
  v_first_ex   BOOLEAN;
  v_quote_vat  NUMERIC;
  v_quote_net  NUMERIC;
  v_quote_gross NUMERIC;
  v_order_pct  NUMERIC;
  v_order_ex   BOOLEAN;
  v_order_vat  NUMERIC;
  v_order_gross NUMERIC;
  v_so_number  TEXT;
  v_so         public.sales_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;

  -- An order this quote already has (any path): that one, never a second.
  SELECT * INTO v_so FROM public.sales_orders s WHERE s.organization_id = v_org AND s.quote_id = p_quote;
  IF FOUND THEN
    RETURN jsonb_build_object('so_id', v_so.id, 'so_number', v_so.so_number, 'created', FALSE, 'provisional', v_so.customer_po IS NULL, 'reason', NULL, 'needs', NULL);
  END IF;

  -- ---- lib/order-from-quote.ts proposedTerms (ordered lines) ----
  SELECT count(*) FILTER (WHERE NOT l.declined), count(*) FILTER (WHERE l.declined),
         sum(round(coalesce(l.quantity, 0) * coalesce(l.unit_price, 0), 2)) FILTER (WHERE NOT l.declined),
         count(DISTINCT CASE WHEN l.vat_exempt THEN 'exempt' ELSE trim_scale(coalesce(l.vat_pct, 20))::TEXT END) FILTER (WHERE NOT l.declined),
         min(CASE WHEN l.vat_exempt THEN 'exempt' ELSE trim_scale(coalesce(l.vat_pct, 20))::TEXT END) FILTER (WHERE NOT l.declined)
    INTO v_lines, v_declined, v_value, v_kinds, v_only
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org;
  IF v_lines = 0 THEN
    RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand', 'reason', 'That quote has no lines to copy. ' || v_by_hand);
  END IF;
  v_vat_on := public.org_vat_registered(v_org) AND v_quote.vat_enabled IS DISTINCT FROM FALSE;
  IF NOT v_vat_on THEN
    -- VAT off: the first line's treatment is kept on the order (as toVatChoice does: 20, 5, 0 or exempt, anything else 20).
    SELECT l.vat_pct, l.vat_exempt INTO v_first_pct, v_first_ex
    FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org AND NOT l.declined ORDER BY l.position, l.id LIMIT 1;
    v_choice := CASE WHEN v_first_ex THEN 'exempt'
                     WHEN trim_scale(coalesce(v_first_pct, 20))::TEXT IN ('20', '5', '0') THEN trim_scale(coalesce(v_first_pct, 20))::TEXT
                     ELSE '20' END;
  ELSE
    IF v_kinds <> 1 THEN
      RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
        'reason', 'That quote has lines at different VAT rates. A sales order holds one VAT rate, so it can''t be linked without changing the VAT. ' || v_by_hand);
    END IF;
    IF v_only NOT IN ('20', '5', '0', 'exempt') THEN
      RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
        'reason', 'That quote uses a VAT rate (' || v_only || '%) a sales order can''t hold. ' || v_by_hand);
    END IF;
    v_choice := v_only;
  END IF;

  -- ---- lib/order-from-quote.ts orderTermsFromQuote: the order's single rounding against the quote's per-line rounding ----
  -- The quote: VAT per line (its own "Add VAT" switch; rate 20 when none is stored), rounded half away from zero, then summed.
  SELECT sum(round(coalesce(l.quantity, 0) * coalesce(l.unit_price, 0), 2)),
         CASE WHEN v_quote.vat_enabled IS DISTINCT FROM FALSE
              THEN sum(CASE WHEN l.vat_exempt THEN 0 ELSE round(round(coalesce(l.quantity, 0) * coalesce(l.unit_price, 0), 2) * coalesce(l.vat_pct, 20) / 100, 2) END)
              ELSE 0 END
    INTO v_quote_net, v_quote_vat
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org AND NOT l.declined;
  v_quote_gross := CASE WHEN v_declined = 0 THEN coalesce(v_quote.total_value, v_quote_net + v_quote_vat) ELSE v_quote_net + v_quote_vat END;
  v_order_ex  := v_choice = 'exempt';
  v_order_pct := CASE WHEN v_order_ex THEN 0 ELSE v_choice::NUMERIC END;
  v_order_vat := CASE WHEN v_vat_on AND NOT v_order_ex THEN round(v_value * v_order_pct / 100, 2) ELSE 0 END;
  v_order_gross := v_value + v_order_vat;
  IF v_order_vat <> v_quote_vat OR v_order_gross <> round(v_quote_gross, 2) THEN
    RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
      'reason', 'As one sales order this quote would come to ' || public.gbp_text(v_order_gross) || ' (VAT ' || public.gbp_text(v_order_vat)
        || '), but the accepted quote is ' || public.gbp_text(v_quote_gross) || ' (VAT ' || public.gbp_text(v_quote_vat)
        || '), because the quote rounds VAT on each line. ' || v_by_hand);
  END IF;

  IF v_po IS NOT NULL AND length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;
  -- 123: the order's reference is always the next SO-#### number; the customer's PO (when given) is kept in customer_po only.
  v_so_number := public.next_doc_number('SO');

  INSERT INTO public.sales_orders (organization_id, so_number, customer, customer_po, quote_id, quote_ref, status, order_date, delivery_date,
                                   total_value, vat_enabled, vat_pct, vat_exempt)
  VALUES (v_org, v_so_number, v_quote.customer, v_po, p_quote, nullif(v_quote.quote_ref, ''), 'open', CURRENT_DATE, p_delivery_date,
          v_value, v_vat_on, v_order_pct, v_order_ex)
  ON CONFLICT (organization_id, quote_id) WHERE quote_id IS NOT NULL DO NOTHING
  RETURNING * INTO v_so;
  IF NOT FOUND THEN
    -- Made meanwhile by another path (the index above): hand that one back.
    SELECT * INTO v_so FROM public.sales_orders s WHERE s.organization_id = v_org AND s.quote_id = p_quote;
    RETURN jsonb_build_object('so_id', v_so.id, 'so_number', v_so.so_number, 'created', FALSE, 'provisional', v_so.customer_po IS NULL, 'reason', NULL, 'needs', NULL);
  END IF;
  RETURN jsonb_build_object('so_id', v_so.id, 'so_number', v_so.so_number, 'created', TRUE, 'provisional', v_po IS NULL, 'reason', NULL, 'needs', NULL);
END
$$;

CREATE OR REPLACE FUNCTION public.set_sales_order_customer_po(p_order UUID, p_customer_po TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_po       TEXT := nullif(btrim(coalesce(p_customer_po, '')), '');
  v_order    public.sales_orders%ROWTYPE;
  v_number   TEXT;
  v_job      public.jobs%ROWTYPE;
  v_job_set  BOOLEAN := FALSE;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('sales-orders') THEN
    RAISE EXCEPTION 'Only admin or office staff can change a sales order''s customer PO' USING ERRCODE = '42501';
  END IF;
  IF v_po IS NULL THEN
    RAISE EXCEPTION 'Enter the customer''s order number' USING ERRCODE = '22023';
  END IF;
  IF length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.sales_orders s WHERE s.id = p_order AND s.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  -- 123: the order's reference (so_number) never changes here; only its customer PO is set or replaced.
  v_number := v_order.so_number;
  IF v_order.customer_po IS NOT DISTINCT FROM v_po THEN
    RETURN jsonb_build_object('so_id', p_order, 'so_number', v_order.so_number, 'customer_po', v_po, 'changed', FALSE, 'job_updated', FALSE);
  END IF;
  UPDATE public.sales_orders SET customer_po = v_po WHERE id = p_order;

  -- Its job, while unfinished: the same customer PO on the worksheet. A finished job keeps the PO it was made with.
  SELECT j.* INTO v_job FROM public.jobs j
  WHERE j.organization_id = v_org AND (j.id = v_order.converted_to_job_id OR j.converted_from_sales_order_id = p_order)
  ORDER BY (j.id = v_order.converted_to_job_id) DESC NULLS LAST, j.created_at
  LIMIT 1
  FOR UPDATE;
  IF FOUND AND v_job.finished_at IS NULL AND v_job.customer_po IS DISTINCT FROM v_po THEN
    UPDATE public.jobs SET customer_po = v_po WHERE id = v_job.id;
    v_job_set := TRUE;
  END IF;

  PERFORM security_audit.log_named_event(v_org, 'SET_CUSTOMER_PO', 'sales_orders', p_order::TEXT, jsonb_build_object(
    'previous_customer_po', v_order.customer_po, 'previous_so_number', v_order.so_number, 'customer_po', v_po, 'so_number', v_number,
    'job_id', v_job.id, 'job_no', v_job.job_no, 'job_updated', v_job_set));
  RETURN jsonb_build_object('so_id', p_order, 'so_number', v_number, 'customer_po', v_po, 'changed', TRUE, 'job_id', v_job.id, 'job_no', v_job.job_no, 'job_updated', v_job_set);
END
$$;

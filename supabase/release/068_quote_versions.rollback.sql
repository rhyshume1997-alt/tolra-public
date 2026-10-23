-- 068 rollback (only with approval). Run as ONE transaction, then `notify pgrst, 'reload schema';` and the release preflight
-- (marker '068 quote versions' reads not applied). Put the previous app build back first: this build calls revise_quote and
-- accept_quote with p_lines.
--
-- It STOPS (nothing changed) when a quote has been revised or partly accepted since 068: those records need the 068 rules (a
-- superseded version must stay undecidable; an order made from part of a quote must not be rebuilt from all of it). Then forward-fix
-- instead. Part / drawing / revision text typed on quote and order lines since 068 is dropped with its columns: export it first with
--   SELECT q.quote_ref, l.position, l.part_number, l.drawing_number, l.drawing_revision FROM public.quote_line_items l
--   JOIN public.quotes q ON q.id = l.quote_id WHERE coalesce(l.part_number, l.drawing_number, l.drawing_revision) IS NOT NULL;
BEGIN;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.quotes WHERE version > 1 OR previous_version_id IS NOT NULL OR status = 'superseded')
     OR EXISTS (SELECT 1 FROM public.quote_line_items WHERE declined) THEN
    RAISE EXCEPTION '068 rollback stopped: quotes have been revised or partly accepted since 068. Nothing was changed; forward-fix instead.';
  END IF;
END
$do$;

DROP TRIGGER IF EXISTS quote_revision_withdrawn ON public.quotes;
DROP TRIGGER IF EXISTS quote_version_guard ON public.quotes;
DROP TRIGGER IF EXISTS zz_same_org_previous_version_id ON public.quotes;
DROP TRIGGER IF EXISTS quote_line_part_clean ON public.quote_line_items;
DROP FUNCTION IF EXISTS public.quote_line_part_clean();
DROP FUNCTION IF EXISTS public.revise_quote(UUID);
DROP FUNCTION IF EXISTS public.quote_revision_withdrawn();
DROP FUNCTION IF EXISTS public.quote_version_guard();
DROP FUNCTION IF EXISTS public.accept_quote(UUID, TEXT, DATE, UUID[]);

-- public.quote_lifecycle_guard(): the 020 body, exactly as before 068.
CREATE OR REPLACE FUNCTION public.quote_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'accepted_at', 'rejected_at', 'internal_notes', 'updated_at', 'updated_by'];
  v_from TEXT;
  v_to   TEXT;
BEGIN
  IF NOT public.is_api_role() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_from := coalesce(OLD.status, 'draft');
  IF TG_OP = 'DELETE' THEN
    IF v_from <> 'draft' THEN
      RAISE EXCEPTION 'Quote % has been issued, so it can''t be deleted.', OLD.quote_ref USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  v_to := coalesce(NEW.status, 'draft');
  IF v_to IS DISTINCT FROM v_from AND NOT (
       (v_from = 'draft' AND v_to IN ('sent', 'accepted', 'rejected'))
    OR (v_from = 'sent'  AND v_to IN ('accepted', 'rejected'))) THEN
    RAISE EXCEPTION 'Quote % can''t go from % to %.', OLD.quote_ref, v_from, v_to USING ERRCODE = '42501';
  END IF;
  IF v_from <> 'draft' AND (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Quote % has been issued: correct a draft or copy it instead.', OLD.quote_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

-- public.quote_lines_issue_lock(): the 020 body, exactly as before 068.
CREATE OR REPLACE FUNCTION public.quote_lines_issue_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_ref TEXT;
BEGIN
  IF public.is_api_role() THEN
    SELECT q.quote_ref INTO v_ref FROM public.quotes q
    WHERE q.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.quote_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.quote_id END)
      AND coalesce(q.status, 'draft') <> 'draft'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Quote % has been issued, so its lines can''t be changed.', v_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

-- public.replace_draft_quote(uuid, timestamp with time zone, jsonb, jsonb): the 021 body, exactly as before 068.
CREATE OR REPLACE FUNCTION public.replace_draft_quote(p_quote uuid, p_expected_updated_at timestamp with time zone, p_header jsonb, p_lines jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_quote   public.quotes%ROWTYPE;
  v_line    JSONB;
  v_idx     INT := 0;
  v_now     TIMESTAMPTZ := clock_timestamp();
  v_allowed CONSTANT TEXT[] := ARRAY['customer', 'description', 'customer_notes', 'internal_notes', 'terms', 'valid_until', 'vat_enabled', 'total_value'];
  v_key     TEXT;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_quote FROM public.quotes WHERE id = p_quote AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_quote.status, 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'Quote % has been issued: copy it to make changes.', v_quote.quote_ref USING ERRCODE = '42501';
  END IF;
  IF v_quote.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Quote % was changed by someone else since you opened it. Reload it and make your changes again.', v_quote.quote_ref
      USING ERRCODE = 'PT409';
  END IF;
  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'header must be an object and lines an array' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_header) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'field "%" can''t be changed here', v_key USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one line item' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'too many lines (max 500)' USING ERRCODE = '22023';
  END IF;

  UPDATE public.quotes q SET
    customer       = CASE WHEN p_header ? 'customer' THEN p_header ->> 'customer' ELSE q.customer END,
    description    = CASE WHEN p_header ? 'description' THEN p_header ->> 'description' ELSE q.description END,
    customer_notes = CASE WHEN p_header ? 'customer_notes' THEN p_header ->> 'customer_notes' ELSE q.customer_notes END,
    internal_notes = CASE WHEN p_header ? 'internal_notes' THEN p_header ->> 'internal_notes' ELSE q.internal_notes END,
    terms          = CASE WHEN p_header ? 'terms' THEN p_header ->> 'terms' ELSE q.terms END,
    valid_until    = CASE WHEN p_header ? 'valid_until' THEN nullif(p_header ->> 'valid_until', '')::DATE ELSE q.valid_until END,
    vat_enabled    = CASE WHEN p_header ? 'vat_enabled' THEN (p_header ->> 'vat_enabled')::BOOLEAN ELSE q.vat_enabled END,
    total_value    = CASE WHEN p_header ? 'total_value' THEN (p_header ->> 'total_value')::NUMERIC ELSE q.total_value END,
    updated_at     = v_now,
    updated_by     = auth.uid()
  WHERE q.id = p_quote;

  DELETE FROM public.quote_line_items WHERE quote_id = p_quote;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    PERFORM public.check_priced_line(v_line);
    INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct, vat_exempt, source)
    VALUES (v_org, p_quote, v_idx, btrim(v_line ->> 'description'), (v_line ->> 'quantity')::NUMERIC, (v_line ->> 'unit_price')::NUMERIC,
            coalesce((v_line ->> 'vat_pct')::NUMERIC, 20), coalesce((v_line ->> 'vat_exempt')::BOOLEAN, FALSE), coalesce(v_line ->> 'source', 'manual'));
    v_idx := v_idx + 1;
  END LOOP;

  PERFORM public.check_document_totals('quotes', p_quote, v_org);
  UPDATE public.quotes SET issuer_snapshot = public.issuer_snapshot(v_org),
                           customer_snapshot = public.customer_snapshot(v_org, customer)
  WHERE id = p_quote;
  RETURN v_now;
END
$function$;

-- public.create_sales_order_from_quote(uuid, text, date): the 058 body, exactly as before 068.
CREATE OR REPLACE FUNCTION public.create_sales_order_from_quote(p_quote uuid, p_customer_po text, p_delivery_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_quote      public.quotes%ROWTYPE;
  v_po         TEXT := nullif(btrim(coalesce(p_customer_po, '')), '');
  v_by_hand    CONSTANT TEXT := 'Choose "No linked quote" and enter the order by hand.';
  v_lines      INTEGER;
  v_value      NUMERIC;  -- the order's net value: the sum of each line's net, each rounded to the penny
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

  -- ---- lib/order-from-quote.ts proposedTerms ----
  SELECT count(*), sum(round(coalesce(l.quantity, 0) * coalesce(l.unit_price, 0), 2)),
         count(DISTINCT CASE WHEN l.vat_exempt THEN 'exempt' ELSE trim_scale(coalesce(l.vat_pct, 20))::TEXT END),
         min(CASE WHEN l.vat_exempt THEN 'exempt' ELSE trim_scale(coalesce(l.vat_pct, 20))::TEXT END)
    INTO v_lines, v_value, v_kinds, v_only
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org;
  IF v_lines = 0 THEN
    RETURN jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand', 'reason', 'That quote has no lines to copy. ' || v_by_hand);
  END IF;
  v_vat_on := public.org_vat_registered(v_org) AND v_quote.vat_enabled IS DISTINCT FROM FALSE;
  IF NOT v_vat_on THEN
    -- VAT off: the first line's treatment is kept on the order (as toVatChoice does: 20, 5, 0 or exempt, anything else 20).
    SELECT l.vat_pct, l.vat_exempt INTO v_first_pct, v_first_ex
    FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org ORDER BY l.position, l.id LIMIT 1;
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
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org;
  v_quote_gross := coalesce(v_quote.total_value, v_quote_net + v_quote_vat);
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
  -- The customer's PO is the order's reference (as the Sales Orders page does); with none yet, a provisional SO-#### number.
  v_so_number := coalesce(v_po, public.next_doc_number('SO'));

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
$function$;

-- public.accept_quote(uuid, text, date): the 058 body, exactly as before 068.
CREATE OR REPLACE FUNCTION public.accept_quote(p_quote uuid, p_customer_po text DEFAULT NULL::text, p_delivery_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_org        UUID := public.current_user_organization_id();
  v_quote      public.quotes%ROWTYPE;
  v_accepted   BOOLEAN := FALSE;
  v_auto       BOOLEAN;
  v_so         JSONB;
  v_so_id      UUID;
  v_order      public.sales_orders%ROWTYPE;
  v_job        JSONB;
  v_job_id     UUID;
  v_job_no     TEXT;
  v_job_new    BOOLEAN := FALSE;
  v_job_reason TEXT;
  v_po         TEXT := nullif(btrim(coalesce(p_customer_po, '')), '');
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('quotes') THEN
    RAISE EXCEPTION 'Only admin or office staff can record a customer''s decision on a quote' USING ERRCODE = '42501';
  END IF;
  IF v_po IS NOT NULL AND length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_quote.status = 'rejected' THEN
    RAISE EXCEPTION '% was marked as rejected; a decision can''t be changed.', v_quote.quote_ref USING ERRCODE = '22023', HINT = 'quote_decided';
  ELSIF coalesce(v_quote.status, 'draft') IN ('draft', 'sent') THEN
    UPDATE public.quotes SET status = 'accepted', accepted_at = now() WHERE id = p_quote;
    v_accepted := TRUE;
  ELSIF v_quote.status <> 'accepted' THEN
    RAISE EXCEPTION '% is %; only a draft or sent quote can be accepted.', v_quote.quote_ref, v_quote.status USING ERRCODE = '22023';
  END IF;

  v_auto := coalesce((SELECT s.auto_convert_sales_orders FROM public.organization_settings s WHERE s.organization_id = v_org), TRUE);

  -- The order: only for someone who may see sales orders (036's section gate, as the table's own rules apply it).
  IF NOT public.section_allowed('sales-orders') THEN
    v_so := jsonb_build_object('so_id', NULL, 'created', FALSE, 'needs', 'sales_order_by_hand',
      'reason', 'Sales orders are hidden for you, so no order was made: someone with the Sales Orders section makes it from this quote.');
  ELSE
    v_so := public.create_sales_order_from_quote(p_quote, v_po, p_delivery_date);
  END IF;
  v_so_id := (v_so ->> 'so_id')::UUID;

  IF v_so_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.sales_orders s WHERE s.id = v_so_id;
    IF (v_so ->> 'created')::BOOLEAN AND v_auto THEN
      -- The job, not started, exactly as Convert to Job makes it. A failure here leaves the order open for Convert to Job by hand.
      BEGIN
        v_job := public.convert_sales_order(v_so_id);
        v_job_id := (v_job ->> 'job_id')::UUID;
        v_job_no := v_job ->> 'job_no';
        v_job_new := coalesce((v_job ->> 'created')::BOOLEAN, FALSE);
      EXCEPTION WHEN OTHERS THEN
        v_job_reason := 'The sales order was made but its job wasn''t (' || SQLERRM || '). Use Convert to Job on the order.';
      END;
    ELSIF v_order.converted_to_job_id IS NOT NULL THEN
      SELECT j.id, j.job_no INTO v_job_id, v_job_no FROM public.jobs j WHERE j.id = v_order.converted_to_job_id AND j.organization_id = v_org;
    END IF;
  END IF;

  IF v_accepted THEN
    PERFORM security_audit.log_named_event(v_org, 'ACCEPT', 'quotes', p_quote::TEXT, jsonb_build_object(
      'quote_ref', v_quote.quote_ref, 'so_id', v_so_id, 'so_number', v_so ->> 'so_number', 'so_created', coalesce((v_so ->> 'created')::BOOLEAN, FALSE),
      'provisional', v_so -> 'provisional', 'job_id', v_job_id, 'job_no', v_job_no, 'job_created', v_job_new, 'auto_convert', v_auto,
      'reason', v_so ->> 'reason', 'job_reason', v_job_reason));
  END IF;

  RETURN jsonb_build_object(
    'quote_id', p_quote, 'quote_ref', v_quote.quote_ref, 'accepted', v_accepted, 'created', v_accepted,
    'so_id', v_so_id, 'so_number', v_so ->> 'so_number', 'so_created', coalesce((v_so ->> 'created')::BOOLEAN, FALSE),
    'provisional', coalesce((v_so ->> 'provisional')::BOOLEAN, FALSE),
    'job_id', v_job_id, 'job_no', v_job_no, 'job_created', v_job_new, 'auto_convert', v_auto,
    'needs', v_so ->> 'needs', 'reason', v_so ->> 'reason', 'job_reason', v_job_reason);
END
$function$;

-- public.convert_sales_order(uuid): the 058 body, exactly as before 068.
CREATE OR REPLACE FUNCTION public.convert_sales_order(p_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can convert sales orders' USING ERRCODE = '42501';
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

  -- Job number: the quote's number when free, otherwise the next J number. The row lock above only serialises calls for
  -- ONE order; two orders for the same quote would both find J-1393 free. One lock per company, held to the end of this
  -- transaction, makes the "is it free" check and the insert a single step.
  PERFORM pg_advisory_xact_lock(hashtextextended('job-no:' || v_org::TEXT, 0));
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
    nullif(btrim(coalesce(v_order.customer_po, '')), ''), nullif(v_quote, ''), v_order.order_date, v_order.delivery_date,
    CASE WHEN v_count = 1 AND v_qty >= 1 AND v_qty = trunc(v_qty) THEN v_qty::INT END,
    p_order, v_now)
  RETURNING * INTO v_job;

  INSERT INTO public.job_values (job_id, organization_id, value) VALUES (v_job.id, v_org, coalesce(v_order.total_value, 0));

  -- The quote's drawings travel with the job: a reference to each file attached to the quote (same company folder; nothing is
  -- copied), so the worksheet lists them and the shop floor can open them (job_files, section 3 below).
  IF coalesce(v_quote, '') <> '' THEN
    INSERT INTO public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, source_attachment_id, created_by)
    SELECT v_org, v_job.id, 'drawing', left(coalesce(nullif(btrim(regexp_replace(a.file_name, '\.[^.]*$', '')), ''), 'Drawing'), 200),
           left(coalesce(nullif(btrim(a.file_name), ''), 'Drawing'), 255), 'quote-attachments', a.file_path, a.id, auth.uid()
    FROM public.quote_attachments a
    WHERE a.organization_id = v_org AND a.quote_ref = v_quote AND split_part(a.file_path, '/', 1) = v_org::TEXT
    ORDER BY a.created_at, a.id
    ON CONFLICT (job_id, storage_bucket, storage_path) DO NOTHING;
  END IF;

  UPDATE public.sales_orders SET status = 'converted', converted_to_job_id = v_job.id, converted_at = v_now WHERE id = p_order;

  -- The machines and hours planned on the order's lines, summed per machine on the job (043). No booking: "Book on schedule" on the job.
  PERFORM public.carry_so_machines(p_order, v_job.id);

  RETURN jsonb_build_object('job_id', v_job.id, 'job_no', v_job.job_no, 'created', TRUE);
END
$function$;

-- public.ensure_sales_order_lines(uuid): the 034 body, exactly as before 068.
CREATE OR REPLACE FUNCTION public.ensure_sales_order_lines(p_order uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_order public.sales_orders%ROWTYPE;
  v_have  NUMERIC;
  v_quote NUMERIC;
  v_n     INT;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office', 'workshop']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*), coalesce(sum(round(quantity * unit_price, 2)), 0) INTO v_n, v_have FROM public.sales_order_lines WHERE sales_order_id = p_order;
  IF v_n > 0 THEN
    IF v_have = coalesce(v_order.total_value, 0) OR EXISTS (
         SELECT 1 FROM public.delivery_note_items i JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id WHERE l.sales_order_id = p_order) THEN
      RETURN p_order;
    END IF;
    DELETE FROM public.sales_order_lines WHERE sales_order_id = p_order;
  END IF;
  IF v_order.quote_id IS NOT NULL THEN
    SELECT coalesce(sum(round(quantity * unit_price, 2)), 0) INTO v_quote FROM public.quote_line_items WHERE quote_id = v_order.quote_id AND organization_id = v_org;
    IF v_quote = coalesce(v_order.total_value, 0) AND v_quote > 0 THEN
      INSERT INTO public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price, vat_pct, vat_exempt, source_quote_line_id)
      SELECT v_org, p_order, row_number() OVER (ORDER BY q.position, q.id) - 1, left(btrim(q.description), 500), q.quantity, q.unit_price, q.vat_pct, q.vat_exempt, q.id
      FROM public.quote_line_items q WHERE q.quote_id = v_order.quote_id AND q.organization_id = v_org AND btrim(q.description) <> '' AND q.quantity > 0;
      RETURN p_order;
    END IF;
  END IF;
  INSERT INTO public.sales_order_lines (organization_id, sales_order_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
  VALUES (v_org, p_order, 0, left('Customer order ' || coalesce(nullif(btrim(v_order.customer_po), ''), v_order.so_number), 500), 1, coalesce(v_order.total_value, 0), v_order.vat_pct, v_order.vat_exempt);
  RETURN p_order;
END
$function$;

-- public.quote_attachments_customer_po_to_jobs(): the 067 body, exactly as before 068.
CREATE OR REPLACE FUNCTION public.quote_attachments_customer_po_to_jobs()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.kind = 'customer_po' AND split_part(NEW.file_path, '/', 1) = NEW.organization_id::TEXT AND btrim(coalesce(NEW.quote_ref, '')) <> '' THEN
    INSERT INTO public.job_files (organization_id, job_id, kind, ref, file_name, storage_bucket, storage_path, source_attachment_id, created_by)
    SELECT NEW.organization_id, j.id, 'customer_po', 'Customer PO', left(coalesce(nullif(btrim(NEW.file_name), ''), 'Customer PO'), 255),
           'quote-attachments', NEW.file_path, NEW.id, auth.uid()
    FROM public.jobs j
    WHERE j.organization_id = NEW.organization_id AND j.quote_ref = NEW.quote_ref
    ORDER BY j.created_at, j.id
    ON CONFLICT (job_id, storage_bucket, storage_path) DO NOTHING;
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public.accept_quote(UUID, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_quote(UUID, TEXT, DATE) TO authenticated;

DROP FUNCTION IF EXISTS public.quote_line_reference(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.quote_base_ref(TEXT, INTEGER);
DROP INDEX IF EXISTS public.quotes_one_revision_each;
ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_version_chain;
ALTER TABLE public.quotes DROP COLUMN IF EXISTS previous_version_id, DROP COLUMN IF EXISTS version;
ALTER TABLE public.quote_line_items DROP CONSTRAINT IF EXISTS quote_line_items_part_details;
ALTER TABLE public.quote_line_items DROP COLUMN IF EXISTS declined, DROP COLUMN IF EXISTS part_number, DROP COLUMN IF EXISTS drawing_number, DROP COLUMN IF EXISTS drawing_revision;
ALTER TABLE public.sales_order_lines DROP CONSTRAINT IF EXISTS sales_order_lines_part_details;
ALTER TABLE public.sales_order_lines DROP COLUMN IF EXISTS part_number, DROP COLUMN IF EXISTS drawing_number, DROP COLUMN IF EXISTS drawing_revision;

COMMIT;

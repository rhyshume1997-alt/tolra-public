-- =====================================================================================================
-- 058: Quote accepted -> sales order -> job, automatic. Rhys's decisions: accepting a quote creates its sales order; the sales order
-- creates its job (NOT STARTED) when the company says so (default: automatic), else the order waits for Convert to Job as today.
-- Human judgement stays only where it is needed: a quote whose terms one sales order can't hold exactly is still accepted, and its
-- order is entered by hand (the existing path).
--
-- 1. One sales order per quote, in the table: unique partial index sales_orders_one_per_quote (organization_id, quote_id) WHERE
--    quote_id IS NOT NULL. Before it is built, a pre-flight check STOPS the release with a clear message if any quote already has two
--    orders (resolve them first; supabase/verify/quote_to_job.sql lists them). Nothing is merged or deleted here.
-- 2. organization_settings.auto_convert_sales_orders BOOLEAN NOT NULL DEFAULT TRUE: "make the job automatically". Admin only:
--    organization_settings_guard_nav (the 006 body) also refuses anyone else changing it, and set_auto_convert_sales_orders(p_on) is
--    the app's write (admin, second step, audited).
-- 3. next_doc_number (the 034 body) also hands out SO-#### numbers (admin, office), skipping numbers already used as an so_number.
--    An order made from a quote with no customer PO yet takes one as its provisional so_number (customer_po stays NULL).
-- 4. create_sales_order_from_quote(p_quote, p_customer_po, p_delivery_date): INTERNAL (no API role may call it). The database port of
--    lib/order-from-quote.ts orderTermsFromQuote, refusal for refusal and penny for penny: no lines; VAT on with lines at different
--    rates; a rate an order can't hold (20, 5, 0 or exempt only); the order's single VAT rounding differing from the quote's per-line
--    rounding by any penny (VAT or gross). The net value and VAT setting are carried exactly as the Sales Orders page carries them.
--    The order: customer name from the quote (quotes hold no customer_id), quote link and number, order date today, the delivery date
--    given, status open. ON CONFLICT on the index above: an order made meanwhile by any other path is returned, never a second one.
--    Returns {so_id, so_number, created, provisional} or {so_id NULL, reason, needs 'sales_order_by_hand'}.
-- 5. accept_quote(p_quote, p_customer_po DEFAULT NULL, p_delivery_date DEFAULT NULL): SECURITY DEFINER, pinned search_path, the
--    caller's company (current_user_organization_id), admin or office with the Quotes section, assert_privileged_aal() first like its
--    peers. Locks the quote (FOR UPDATE), so two accepts of one quote run one after the other:
--      * draft or sent: accepted (accepted_at now; 020's lifecycle guard and 035's actor stamp apply as for the app's own update), the
--        order created (if the caller has the Sales orders section), and when the company setting is automatic, the job created through
--        convert_sales_order (not started: stage material, no start time). ONE audit event ACCEPT (entity: the quote id) carries the
--        order and job made, or the reason none was.
--      * already accepted: no change and no audit event. Its order (and job) is returned with created = false. An accepted quote with no
--        order yet (accepted by an earlier build, or its order deleted) gets one now, as above; one whose terms refuse is refused again.
--      * rejected: refused.
--    A terms refusal never fails the accept: so_id NULL and the reason ("needs a sales order by hand"). A job that can't be made (any
--    error in convert_sales_order) never fails the accept either: the order stays open with job_reason, for Convert to Job by hand.
-- 6. convert_sales_order (the 043 body): the job's customer_po now comes from sales_orders.customer_po, never from so_number (a
--    provisional SO-#### is not the customer's PO). Orders entered by hand store the same text in both, so their jobs are unchanged.
-- 7. set_sales_order_customer_po(p_order, p_customer_po): admin or office with the Sales orders section, second step. Sets or replaces
--    the order's customer PO; the so_number follows it when it was provisional (no PO yet) or was the old PO (orders entered by hand),
--    so the two stay consistent; an unfinished job made from the order gets the same customer_po (a worksheet field: its worksheet
--    version moves, as for any worksheet edit). A finished job keeps the PO it was made with (job_updated false). Audited.
--
-- Unchanged: RLS and grants on quotes, sales_orders, jobs and organization_settings; the plain status update of an earlier build still
-- accepts a quote (no order is made then, as before; accept_quote makes it later); a sales order entered by hand (no quote) is a plain
-- insert as before. Forward only, safe to run more than once.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. One sales order per quote ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_dupes INTEGER;
  v_list  TEXT;
BEGIN
  SELECT count(*), string_agg(d.organization_id::TEXT || ' quote ' || coalesce(d.quote_ref, d.quote_id::TEXT) || ' (' || d.n || ' orders: ' || d.orders || ')', '; ')
    INTO v_dupes, v_list
  FROM (
    SELECT s.organization_id, s.quote_id, max(q.quote_ref) AS quote_ref, count(*) AS n, string_agg(s.so_number, ', ' ORDER BY s.created_at, s.id) AS orders
    FROM public.sales_orders s LEFT JOIN public.quotes q ON q.id = s.quote_id
    WHERE s.quote_id IS NOT NULL
    GROUP BY s.organization_id, s.quote_id
    HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION '058 stopped: % quote(s) already have more than one sales order, so "one sales order per quote" can''t be added. Nothing was changed. Resolve them first (unlink or close the extra orders; supabase/verify/quote_to_job.sql row 2 lists them): %', v_dupes, v_list
      USING ERRCODE = '23505';
  END IF;
END
$do$;
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_one_per_quote ON public.sales_orders (organization_id, quote_id) WHERE quote_id IS NOT NULL;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. The company setting: make the job automatically ---------------------------------------------------------
ALTER TABLE public.organization_settings ADD COLUMN IF NOT EXISTS auto_convert_sales_orders BOOLEAN NOT NULL DEFAULT TRUE;

-- The 006 body, plus: only an admin changes auto_convert_sales_orders (office may still write the column choices on this row).
CREATE OR REPLACE FUNCTION public.organization_settings_guard_nav()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NEW.hidden_nav IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.hidden_nav ELSE '{}'::TEXT[] END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change hidden menu items';
    END IF;
    IF NEW.company_profile IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.company_profile ELSE '{}'::JSONB END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change the company profile';
    END IF;
    IF NEW.auto_convert_sales_orders IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.auto_convert_sales_orders ELSE TRUE END)
       AND NOT public.has_org_role(ARRAY['admin']) THEN
      RAISE EXCEPTION 'Only admins can change whether sales orders become jobs automatically' USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_auto_convert_sales_orders(p_on BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_before BOOLEAN;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only an admin can change whether sales orders become jobs automatically' USING ERRCODE = '42501';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'Choose on or off.' USING ERRCODE = '22023';
  END IF;
  SELECT s.auto_convert_sales_orders INTO v_before FROM public.organization_settings s WHERE s.organization_id = v_org FOR UPDATE;
  INSERT INTO public.organization_settings AS s (organization_id, auto_convert_sales_orders) VALUES (v_org, p_on)
  ON CONFLICT (organization_id) DO UPDATE SET auto_convert_sales_orders = EXCLUDED.auto_convert_sales_orders;
  IF v_before IS DISTINCT FROM p_on THEN
    PERFORM security_audit.log_named_event(v_org, 'UPDATE', 'organization_settings', v_org::TEXT,
      jsonb_build_object('section', 'sales_orders', 'auto_convert_sales_orders', p_on, 'previous', coalesce(v_before, TRUE)));
  END IF;
  RETURN p_on;
END
$$;
REVOKE ALL ON FUNCTION public.set_auto_convert_sales_orders(BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_auto_convert_sales_orders(BOOLEAN) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. SO-#### numbers ------------------------------------------------------------------------------------
-- The 034 body, plus 'SO' (admin, office; a number already used as an so_number is skipped).
CREATE OR REPLACE FUNCTION public.next_doc_number(p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  org      UUID := public.current_user_organization_id();
  n        INT;
  result   TEXT;
  taken    BOOLEAN;
  attempts INT := 0;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_prefix IS NULL OR p_prefix NOT IN ('QUO', 'INV', 'J', 'PO', 'RFQ', 'DLN', 'CN', 'SO') THEN
    RAISE EXCEPTION 'invalid document prefix' USING ERRCODE = '22023';
  END IF;

  -- You can only take numbers for documents you are allowed to create (a viewer cannot burn numbers).
  IF NOT public.has_org_role(CASE p_prefix
        WHEN 'INV' THEN ARRAY['admin', 'office']
        WHEN 'J'   THEN ARRAY['admin', 'office', 'workshop']
        WHEN 'DLN' THEN ARRAY['admin', 'office', 'workshop']
        ELSE            ARRAY['admin', 'office']
      END) THEN
    RAISE EXCEPTION 'not authorised for % numbers', p_prefix USING ERRCODE = '42501';
  END IF;

  LOOP
    INSERT INTO public.doc_counters AS c (organization_id, prefix, last)
    VALUES (org, p_prefix, 1)
    ON CONFLICT (organization_id, prefix) DO UPDATE SET last = c.last + 1
    RETURNING c.last INTO n;

    -- lpad() would truncate numbers above 9999, so only pad short numbers.
    result := p_prefix || '-' || CASE WHEN n < 10000 THEN lpad(n::TEXT, 4, '0') ELSE n::TEXT END;

    -- Skip numbers that already exist (rows imported or seeded after the counters were seeded, or jobs that
    -- took a quote's number). Counters only move forward, so a skipped number is simply never reused.
    taken := CASE p_prefix
      WHEN 'QUO' THEN EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = result)
      WHEN 'INV' THEN EXISTS (SELECT 1 FROM public.invoices WHERE organization_id = org AND invoice_ref = result)
      WHEN 'J'   THEN EXISTS (SELECT 1 FROM public.jobs     WHERE organization_id = org AND job_no = result)
                   OR EXISTS (SELECT 1 FROM public.quotes   WHERE organization_id = org AND quote_ref = 'QUO' || substr(result, 2))
      WHEN 'DLN' THEN EXISTS (SELECT 1 FROM public.delivery_notes WHERE organization_id = org AND dn_number = result)
      WHEN 'CN'  THEN EXISTS (SELECT 1 FROM public.credit_notes WHERE organization_id = org AND credit_ref = result)
      WHEN 'SO'  THEN EXISTS (SELECT 1 FROM public.sales_orders WHERE organization_id = org AND so_number = result)
      ELSE FALSE
    END;
    EXIT WHEN NOT taken;

    attempts := attempts + 1;
    IF attempts > 10000 THEN
      RAISE EXCEPTION 'could not allocate a free % number', p_prefix;
    END IF;
  END LOOP;

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.next_doc_number(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_doc_number(TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. A quote's sales order (internal) ------------------------------------------------------------------------
-- £1,234.56 as lib/money.ts gbp() writes it (amounts here are never negative).
CREATE OR REPLACE FUNCTION public.gbp_text(p_amount NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_amount < 0 THEN '-' ELSE '' END || '£' || to_char(abs(round(p_amount, 2)), 'FM999,999,999,999,990.00')
$$;
REVOKE ALL ON FUNCTION public.gbp_text(NUMERIC) FROM PUBLIC, anon, authenticated;

-- The caller has been checked by accept_quote (role, section, second step, company). Locks: the quote is already locked by the caller.
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
$$;
REVOKE ALL ON FUNCTION public.create_sales_order_from_quote(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. Accepting a quote ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_quote(p_quote UUID, p_customer_po TEXT DEFAULT NULL, p_delivery_date DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
$$;
REVOKE ALL ON FUNCTION public.accept_quote(UUID, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_quote(UUID, TEXT, DATE) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. Converting an order: the job's customer PO is the order's customer PO -------------------------------------
-- The 043 body (034, 033 job-number lock; admin or office; carries the order's machines), except the job's customer_po: the order's
-- customer_po, never its so_number. Result unchanged ({job_id, job_no, created}).
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
$$;
REVOKE ALL ON FUNCTION public.convert_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_sales_order(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 7. The customer's PO, later ------------------------------------------------------------------------------
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
  -- The order's reference follows its PO when it was provisional (no PO yet) or was the PO itself (orders entered by hand).
  v_number := CASE WHEN v_order.customer_po IS NULL OR v_order.so_number = v_order.customer_po THEN v_po ELSE v_order.so_number END;
  IF v_order.customer_po IS NOT DISTINCT FROM v_po AND v_order.so_number = v_number THEN
    RETURN jsonb_build_object('so_id', p_order, 'so_number', v_order.so_number, 'customer_po', v_po, 'changed', FALSE, 'job_updated', FALSE);
  END IF;
  UPDATE public.sales_orders SET customer_po = v_po, so_number = v_number WHERE id = p_order;

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
REVOKE ALL ON FUNCTION public.set_sales_order_customer_po(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sales_order_customer_po(UUID, TEXT) TO authenticated;

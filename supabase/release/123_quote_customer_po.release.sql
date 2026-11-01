-- 123_quote_customer_po.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 123: the customer's PO on the QUOTE (Rhys and John, decision 16, 1 Nov). John writes the quote with the customer's PO beside its number;
-- accepting it carries that PO to the (hidden) sales order, the job and the draft invoice; a PO that arrives later is added on the quote
-- and reaches the same places. Needs 058, 068 and 076 (the newest bodies of the functions replaced here). Touches no other objects.
--
-- WHAT CHANGES.
--   a. public.quotes.customer_po TEXT (new, nullable). CHECK quotes_customer_po_check: empty is NULL, no leading or trailing space,
--      at most 100 characters (the rules every sales-order PO path applies: trimmed, '' = none, 'Order number is too long' over 100).
--   b. public.quote_lifecycle_guard (the 076 body, the newest): an issued quote is still frozen, except that set_quote_customer_po (and
--      only it: a transaction-local setting no API role can set) may change customer_po on a SENT or ACCEPTED quote, without a status
--      change. Every other field of a sent or accepted quote is refused exactly as before; draft quotes are unchanged (any field).
--   c. public.create_sales_order_from_quote (the 068 body, internal: no API role may call it): with no PO given (the accept dialog
--      left empty) it takes the quote's customer_po. The so_number rule is NOT changed (058/068): the PO when there is one, else the
--      next SO-####. accept_quote is not changed: it passes the dialog's PO through to this function.
--   d. public.revise_quote (the 068 body): the new version keeps the customer_po.
--   e. public.set_quote_customer_po(p_quote, p_customer_po) (new): SECURITY DEFINER, pinned search_path, the caller's company, second
--      step first (assert_privileged_aal), admin or office with the Quotes section (accept_quote's checks). Draft, sent or accepted
--      quotes only. Sets the quote's customer PO; when the quote has its sales order, the order's customer_po too (its so_number
--      follows as in set_sales_order_customer_po, 058: when it was provisional or was the PO), its unfinished job's customer_po (a
--      finished job keeps the PO it was made with), and its DRAFT invoices' customer_po (the job's, and one made from this order's
--      delivery notes alone). An issued invoice is never changed. Clearing the PO is refused once the quote has an order. One audit
--      event SET_CUSTOMER_PO (entity: the quote). Signed-in only, as accept_quote.
-- EXISTING ROWS ARE NOT CHANGED: every quote starts with customer_po NULL; no order, job or invoice is touched by this file.
-- Every replaced function keeps its name, signature, security, volatility, search_path, owner and grants.
-- GUARD (section 1): each replaced body must be its source's (or already this file's), md5 with every whitespace character removed.
-- Safe to run again. SELF-CHECK (section 8). Verify: supabase/verify/quote_customer_po_123.sql (every row TRUE).
-- Rollback: supabase/release/123_quote_customer_po.rollback.sql (puts back 076's guard and 068's two functions, drops
-- set_quote_customer_po and the column; refuses while any quote has a customer PO; only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: 058, 068 and 076 are applied, and each body this file replaces is its source's (or already this file's).
DO $$
DECLARE
  v_md5 TEXT;
  v_fn  RECORD;
BEGIN
  IF to_regclass('public.quotes') IS NULL OR to_regclass('public.sales_orders') IS NULL OR to_regprocedure('public.accept_quote(uuid, text, date, uuid[])') IS NULL THEN
    RAISE EXCEPTION '123: 058 and 068 (accept_quote with p_lines) are missing; apply them first';
  END IF;
  FOR v_fn IN SELECT * FROM (VALUES
      -- source body, this file's body
      ('public.quote_lifecycle_guard()', '7aa38f2a95943427d522712998d84050', '3c01d528076221cdac11c72f7327ab02'),
      ('public.create_sales_order_from_quote(uuid, text, date)', 'ded57529317279dae221103631fe149a', 'a5371d31fde32e60ed7b2a23f40f1935'),
      ('public.revise_quote(uuid)', 'd8e9f57c47c98731e57d66b699f7273c', 'dd78b559c44bf1effdc7e61109e1500c')) AS f(sig, src, mine)
  LOOP
    SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn.sig) INTO v_md5;
    IF v_md5 IS NULL OR v_md5 NOT IN (v_fn.src, v_fn.mine) THEN
      RAISE EXCEPTION '123: % is not its source''s (md5 without whitespace %); stop and compare it first', v_fn.sig, coalesce(v_md5, 'missing');
    END IF;
  END LOOP;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_quote_customer_po(uuid, text)') INTO v_md5;
  IF v_md5 IS NOT NULL AND v_md5 <> '00f8488bd689f3e473209d520218d402' THEN
    RAISE EXCEPTION '123: public.set_quote_customer_po exists with another body (md5 %); stop and compare it first', v_md5;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The quote's customer PO: nullable, trimmed, at most 100 characters. Every existing quote starts with none.
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS customer_po TEXT;
ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_customer_po_check;
ALTER TABLE public.quotes ADD CONSTRAINT quotes_customer_po_check CHECK (customer_po IS NULL OR (char_length(customer_po) BETWEEN 1 AND 100 AND customer_po = btrim(customer_po)));

-- -----------------------------------------------------------------------------------------------------
-- 3. quote_lifecycle_guard: the 076 body; set_quote_customer_po alone may change customer_po on a sent or accepted quote.
CREATE OR REPLACE FUNCTION public.quote_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_open    CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'accepted_at', 'rejected_at', 'internal_notes', 'updated_at', 'updated_by'];
  v_from    TEXT;
  v_to      TEXT;
  v_revised BOOLEAN;
  v_skip    TEXT[];
BEGIN
  -- 076: undo of a large import deletes only rows that import created, for the company it holds the undo for (set by it alone, cleared after).
  IF TG_OP = 'DELETE' AND current_setting('quoteflow.data_import_undo', TRUE) = OLD.organization_id::TEXT THEN
    RETURN OLD;
  END IF;
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
  IF v_to IS DISTINCT FROM v_from THEN
    v_revised := EXISTS (SELECT 1 FROM public.quotes q WHERE q.previous_version_id = OLD.id);
    IF v_revised AND v_to <> 'superseded' THEN
      RAISE EXCEPTION 'Quote % v% has been revised as a newer version: record the decision on the latest version.', OLD.quote_ref, OLD.version
        USING ERRCODE = '42501', HINT = 'quote_superseded';
    END IF;
    IF NOT (
         (v_from = 'draft' AND v_to IN ('sent', 'accepted', 'rejected'))
      OR (v_from = 'sent'  AND v_to IN ('accepted', 'rejected'))
      OR (v_from = 'sent'  AND v_to = 'superseded' AND v_revised)
      OR (v_from = 'superseded' AND v_to = 'sent' AND NOT v_revised)) THEN
      RAISE EXCEPTION 'Quote % can''t go from % to %.', OLD.quote_ref, v_from, v_to USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_from = 'superseded' AND v_to = 'superseded' AND NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    RAISE EXCEPTION 'Quote % v% has been replaced by a newer version: send the latest version.', OLD.quote_ref, OLD.version USING ERRCODE = '42501';
  END IF;
  -- 123: set_quote_customer_po (and only it: the setting is transaction-local and no API role can set it) may change the customer PO of
  -- a sent or accepted quote, without a status change. Every other field of an issued quote is still refused.
  v_skip := CASE WHEN v_from IN ('sent', 'accepted') AND v_to = v_from
                      AND current_setting('quoteflow.set_quote_customer_po', TRUE) = OLD.id::TEXT
                 THEN v_open || ARRAY['customer_po'] ELSE v_open END;
  IF v_from <> 'draft' AND (to_jsonb(NEW) - v_skip) IS DISTINCT FROM (to_jsonb(OLD) - v_skip) THEN
    RAISE EXCEPTION 'Quote % has been issued: correct a draft or copy it instead.', OLD.quote_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

-- -----------------------------------------------------------------------------------------------------
-- 4. create_sales_order_from_quote: the 068 body; with no PO given, the quote's own.
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
  -- 123: with no PO given (the accept dialog left empty), the quote's own customer PO, if it has one.
  v_po := coalesce(v_po, nullif(btrim(coalesce(v_quote.customer_po, '')), ''));

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

-- -----------------------------------------------------------------------------------------------------
-- 5. revise_quote: the 068 body; the new version keeps the customer PO.
CREATE OR REPLACE FUNCTION public.revise_quote(p_quote UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_old   public.quotes%ROWTYPE;
  v_next  public.quotes%ROWTYPE;
  v_new   UUID := gen_random_uuid();
  v_ref   TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('quotes') THEN
    RAISE EXCEPTION 'Only admin or office staff can revise a quote' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_old FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_next FROM public.quotes q WHERE q.previous_version_id = p_quote AND q.organization_id = v_org;
  IF FOUND THEN
    RAISE EXCEPTION '% v% has already been revised as v%: revise the latest version.', v_old.quote_ref, v_old.version, v_next.version
      USING ERRCODE = '22023', HINT = 'quote_superseded';
  END IF;
  IF coalesce(v_old.status, 'draft') <> 'sent' THEN
    RAISE EXCEPTION '% is %: only a sent quote is revised as a new version (edit a draft; a decided quote is final).', v_old.quote_ref,
      coalesce(v_old.status, 'draft') USING ERRCODE = '22023';
  END IF;

  -- The quote's number, then " v2", " v3", ...
  v_ref := public.quote_base_ref(v_old.quote_ref, v_old.version) || ' v' || (v_old.version + 1)::TEXT;
  IF EXISTS (SELECT 1 FROM public.quotes q WHERE q.organization_id = v_org AND q.quote_ref = v_ref) THEN
    RAISE EXCEPTION 'Another quote is already numbered %, so % can''t be revised as that version.', v_ref, v_old.quote_ref USING ERRCODE = '23505';
  END IF;

  PERFORM set_config('quoteflow.revise_quote', p_quote::TEXT, TRUE);
  -- 123: the new version keeps the customer PO.
  INSERT INTO public.quotes (id, organization_id, quote_ref, rfq_id, customer, description, total_value, status, valid_until, internal_notes,
                             customer_notes, terms, vat_enabled, version, previous_version_id, issuer_snapshot, customer_snapshot, customer_po)
  VALUES (v_new, v_org, v_ref, v_old.rfq_id, v_old.customer, v_old.description, v_old.total_value, 'draft',
          CASE WHEN v_old.valid_until >= CURRENT_DATE THEN v_old.valid_until END,  -- a date already past is dropped: Send gives a new one
          v_old.internal_notes, v_old.customer_notes, v_old.terms, v_old.vat_enabled, v_old.version + 1, p_quote,
          public.issuer_snapshot(v_org), public.customer_snapshot(v_org, v_old.customer), v_old.customer_po);
  PERFORM set_config('quoteflow.revise_quote', '', TRUE);
  INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct, vat_exempt, source,
                                       part_number, drawing_number, drawing_revision)
  SELECT v_org, v_new, l.position, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt, l.source,
         l.part_number, l.drawing_number, l.drawing_revision
  FROM public.quote_line_items l WHERE l.quote_id = p_quote AND l.organization_id = v_org ORDER BY l.position, l.id;
  UPDATE public.quotes SET status = 'superseded' WHERE id = p_quote;

  PERFORM security_audit.log_named_event(v_org, 'REVISE', 'quotes', v_new::TEXT, jsonb_build_object(
    'quote_ref', v_ref, 'version', v_old.version + 1, 'previous_version_id', p_quote, 'previous_quote_ref', v_old.quote_ref));
  RETURN jsonb_build_object('quote_id', v_new, 'quote_ref', v_ref, 'version', v_old.version + 1,
    'previous_quote_id', p_quote, 'previous_quote_ref', v_old.quote_ref);
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 6. set_quote_customer_po: the PO added or changed on the quote, and carried to its order, unfinished job and draft invoices.
CREATE OR REPLACE FUNCTION public.set_quote_customer_po(p_quote UUID, p_customer_po TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      UUID := public.current_user_organization_id();
  v_po       TEXT := nullif(btrim(coalesce(p_customer_po, '')), '');
  v_quote    public.quotes%ROWTYPE;
  v_order    public.sales_orders%ROWTYPE;
  v_number   TEXT;
  v_job      public.jobs%ROWTYPE;
  v_job_set  BOOLEAN := FALSE;
  v_drafts   UUID[] := ARRAY[]::UUID[];
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('quotes') THEN
    RAISE EXCEPTION 'Only admin or office staff can change a quote''s customer PO' USING ERRCODE = '42501';
  END IF;
  IF v_po IS NOT NULL AND length(v_po) > 100 THEN
    RAISE EXCEPTION 'Order number is too long' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_quote FROM public.quotes q WHERE q.id = p_quote AND q.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_quote.status, 'draft') NOT IN ('draft', 'sent', 'accepted') THEN
    RAISE EXCEPTION 'Quote % is %: its customer PO can''t be changed.', v_quote.quote_ref, v_quote.status USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_order FROM public.sales_orders s WHERE s.organization_id = v_org AND s.quote_id = p_quote FOR UPDATE;
  IF v_po IS NULL AND v_order.id IS NOT NULL THEN
    RAISE EXCEPTION 'Enter the customer''s order number' USING ERRCODE = '22023';
  END IF;
  IF v_quote.customer_po IS NOT DISTINCT FROM v_po AND (v_order.id IS NULL OR v_order.customer_po IS NOT DISTINCT FROM v_po) THEN
    RETURN jsonb_build_object('quote_id', p_quote, 'quote_ref', v_quote.quote_ref, 'customer_po', v_po, 'changed', FALSE,
      'so_id', v_order.id, 'job_updated', FALSE, 'draft_invoices', 0);
  END IF;

  -- The quote (quote_lifecycle_guard lets this one change through on a sent or accepted quote, 123).
  PERFORM set_config('quoteflow.set_quote_customer_po', p_quote::TEXT, TRUE);
  UPDATE public.quotes SET customer_po = v_po WHERE id = p_quote;
  PERFORM set_config('quoteflow.set_quote_customer_po', '', TRUE);

  IF v_order.id IS NOT NULL THEN
    -- Its order, as set_sales_order_customer_po (058) does: the reference follows the PO when it was provisional (no PO yet) or was the
    -- PO itself; otherwise it stays.
    v_number := CASE WHEN v_order.customer_po IS NULL OR v_order.so_number = v_order.customer_po THEN v_po ELSE v_order.so_number END;
    UPDATE public.sales_orders SET customer_po = v_po, so_number = v_number WHERE id = v_order.id;

    -- Its job, while unfinished: the same customer PO on the worksheet. A finished job keeps the PO it was made with.
    SELECT j.* INTO v_job FROM public.jobs j
    WHERE j.organization_id = v_org AND (j.id = v_order.converted_to_job_id OR j.converted_from_sales_order_id = v_order.id)
    ORDER BY (j.id = v_order.converted_to_job_id) DESC NULLS LAST, j.created_at
    LIMIT 1
    FOR UPDATE;
    IF FOUND AND v_job.finished_at IS NULL AND v_job.customer_po IS DISTINCT FROM v_po THEN
      UPDATE public.jobs SET customer_po = v_po WHERE id = v_job.id;
      v_job_set := TRUE;
    END IF;

    -- DRAFT invoices only (an issued invoice is never changed): the job's, and one made from this order's delivery notes alone.
    WITH changed AS (
      UPDATE public.invoices i SET customer_po = v_po
      WHERE i.organization_id = v_org AND i.status = 'draft' AND i.customer_po IS DISTINCT FROM v_po
        AND ((v_job.id IS NOT NULL AND i.job_id = v_job.id)
          OR (EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.invoice_id = i.id AND d.organization_id = v_org AND d.sales_order_id = v_order.id)
              AND NOT EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.invoice_id = i.id AND d.sales_order_id IS DISTINCT FROM v_order.id)))
      RETURNING i.id
    )
    SELECT coalesce(array_agg(id ORDER BY id), ARRAY[]::UUID[]) INTO v_drafts FROM changed;
  END IF;

  PERFORM security_audit.log_named_event(v_org, 'SET_CUSTOMER_PO', 'quotes', p_quote::TEXT, jsonb_build_object(
    'quote_ref', v_quote.quote_ref, 'previous_customer_po', v_quote.customer_po, 'customer_po', v_po,
    'so_id', v_order.id, 'so_number', v_number, 'job_id', v_job.id, 'job_no', v_job.job_no, 'job_updated', v_job_set,
    'draft_invoice_ids', to_jsonb(v_drafts)));
  RETURN jsonb_build_object('quote_id', p_quote, 'quote_ref', v_quote.quote_ref, 'customer_po', v_po, 'changed', TRUE,
    'so_id', v_order.id, 'so_number', v_number, 'job_id', v_job.id, 'job_no', v_job.job_no, 'job_updated', v_job_set,
    'draft_invoices', cardinality(v_drafts));
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 7. The grants exactly as before (CREATE OR REPLACE keeps them; restated so a re-run cannot drift). The new function: signed-in only.
REVOKE ALL ON FUNCTION public.create_sales_order_from_quote(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revise_quote(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revise_quote(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.set_quote_customer_po(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_quote_customer_po(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 8. Self-check before COMMIT (the same checks as supabase/verify/quote_customer_po_123.sql).
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE (p.oid, md5(regexp_replace(p.prosrc, '\s', '', 'g'))) IN (
        (to_regprocedure('public.quote_lifecycle_guard()'), '3c01d528076221cdac11c72f7327ab02'),
        (to_regprocedure('public.create_sales_order_from_quote(uuid, text, date)'), 'a5371d31fde32e60ed7b2a23f40f1935'),
        (to_regprocedure('public.revise_quote(uuid)'), 'dd78b559c44bf1effdc7e61109e1500c'),
        (to_regprocedure('public.set_quote_customer_po(uuid, text)'), '00f8488bd689f3e473209d520218d402'))) <> 4 THEN
    RAISE EXCEPTION '123: a function body is not 123''s after the replace';
  END IF;
  IF (SELECT NOT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.quote_lifecycle_guard()')) IS NOT TRUE THEN
    RAISE EXCEPTION '123: quote_lifecycle_guard must stay SECURITY INVOKER';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.create_sales_order_from_quote(uuid, text, date)'),
               to_regprocedure('public.revise_quote(uuid)'), to_regprocedure('public.set_quote_customer_po(uuid, text)'))
             AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] OR has_function_privilege('anon', p.oid, 'EXECUTE')
                  OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')))
     OR has_function_privilege('authenticated', 'public.create_sales_order_from_quote(uuid, text, date)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.revise_quote(uuid)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_quote_customer_po(uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '123: a function is not definer, pinned and granted as before';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.quotes'::regclass AND c.conname = 'quotes_customer_po_check' AND c.contype = 'c')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quote_lifecycle_guard' AND tgenabled = 'O') THEN
    RAISE EXCEPTION '123: quotes.customer_po check or quote_lifecycle_guard trigger missing';
  END IF;
END
$$;

COMMIT;

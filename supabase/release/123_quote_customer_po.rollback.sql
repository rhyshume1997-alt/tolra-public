-- 123 rollback: ONLY with Rhys's approval. Puts back, byte for byte (same signatures, security, search_path and grants), 076's
-- public.quote_lifecycle_guard(), 068's public.create_sales_order_from_quote(uuid, text, date) and 068's public.revise_quote(uuid); drops
-- public.set_quote_customer_po(uuid, text), the check quotes_customer_po_check and the column quotes.customer_po. Orders, jobs and
-- invoices keep every customer PO they were given (none is changed here). STOPS (nothing changed) while any quote holds a customer PO:
-- the column would take it with it; Rhys decides first (copy them elsewhere, or clear them). Run the whole text as one transaction,
-- then the release preflight (marker 123 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_md5 TEXT;
  v_fn  RECORD;
  v_n   BIGINT;
BEGIN
  FOR v_fn IN SELECT * FROM (VALUES
      -- 123's body, the source's (a second run of this rollback)
      ('public.quote_lifecycle_guard()', '3c01d528076221cdac11c72f7327ab02', '7aa38f2a95943427d522712998d84050'),
      ('public.create_sales_order_from_quote(uuid, text, date)', 'a5371d31fde32e60ed7b2a23f40f1935', 'ded57529317279dae221103631fe149a'),
      ('public.revise_quote(uuid)', 'dd78b559c44bf1effdc7e61109e1500c', 'd8e9f57c47c98731e57d66b699f7273c')) AS f(sig, mine, src)
  LOOP
    SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn.sig) INTO v_md5;
    IF v_md5 IS NULL OR v_md5 NOT IN (v_fn.mine, v_fn.src) THEN
      RAISE EXCEPTION '123 rollback: % (md5 %) is neither 123''s nor its source''s; stop and compare', v_fn.sig, coalesce(v_md5, 'missing');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quotes' AND column_name = 'customer_po') THEN
    EXECUTE 'SELECT count(*) FROM public.quotes WHERE customer_po IS NOT NULL' INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION '123 rollback stopped: % quote(s) hold a customer PO; nothing was changed. Rhys decides what happens to them first.', v_n;
    END IF;
  END IF;
END
$$;

-- 068's revise_quote and create_sales_order_from_quote, 076's quote_lifecycle_guard, verbatim.
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
  INSERT INTO public.quotes (id, organization_id, quote_ref, rfq_id, customer, description, total_value, status, valid_until, internal_notes,
                             customer_notes, terms, vat_enabled, version, previous_version_id, issuer_snapshot, customer_snapshot)
  VALUES (v_new, v_org, v_ref, v_old.rfq_id, v_old.customer, v_old.description, v_old.total_value, 'draft',
          CASE WHEN v_old.valid_until >= CURRENT_DATE THEN v_old.valid_until END,  -- a date already past is dropped: Send gives a new one
          v_old.internal_notes, v_old.customer_notes, v_old.terms, v_old.vat_enabled, v_old.version + 1, p_quote,
          public.issuer_snapshot(v_org), public.customer_snapshot(v_org, v_old.customer));
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
REVOKE ALL ON FUNCTION public.revise_quote(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revise_quote(UUID) TO authenticated;

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
  IF v_from <> 'draft' AND (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Quote % has been issued: correct a draft or copy it instead.', OLD.quote_ref USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

DROP FUNCTION IF EXISTS public.set_quote_customer_po(UUID, TEXT);
ALTER TABLE public.quotes DROP CONSTRAINT IF EXISTS quotes_customer_po_check;
ALTER TABLE public.quotes DROP COLUMN IF EXISTS customer_po;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE (p.oid, md5(regexp_replace(p.prosrc, '\s', '', 'g'))) IN (
        (to_regprocedure('public.quote_lifecycle_guard()'), '7aa38f2a95943427d522712998d84050'),
        (to_regprocedure('public.create_sales_order_from_quote(uuid, text, date)'), 'ded57529317279dae221103631fe149a'),
        (to_regprocedure('public.revise_quote(uuid)'), 'd8e9f57c47c98731e57d66b699f7273c'))) <> 3
     OR to_regprocedure('public.set_quote_customer_po(uuid, text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quotes' AND column_name = 'customer_po') THEN
    RAISE EXCEPTION '123 rollback: 068''s and 076''s bodies are not back, or set_quote_customer_po / quotes.customer_po is still there';
  END IF;
END
$$;
COMMIT;

-- =====================================================================================================
-- 021: correct a draft quote in one step (audit B4b: D2 minimum).
--
-- public.replace_draft_quote(quote, expected_updated_at, header, lines) replaces a DRAFT quote's header fields
-- and all its lines in one transaction, with the same line and total checks as creation, and refreshes its
-- snapshots. It refuses a quote that is no longer a draft, and refuses when someone else saved the quote since it
-- was opened (updated_at differs: "changed by someone else", HTTP 409), so one person's correction can't silently overwrite
-- another's. Nothing is changed when any check fails.
--
-- The line check, the totals check and the snapshots move into shared functions used by both create_with_lines
-- and replace_draft_quote, so the two paths can't drift apart. create_with_lines behaves exactly as before.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

-- A priced line as sent: description, quantity above zero with at most 3 decimals, price >= 0 in pounds and pence.
CREATE OR REPLACE FUNCTION public.check_priced_line(p_line JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_qty   NUMERIC;
  v_price NUMERIC;
BEGIN
  IF btrim(coalesce(p_line ->> 'description', '')) = '' THEN
    RAISE EXCEPTION 'Every line needs a description' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_qty := (p_line ->> 'quantity')::NUMERIC;
    v_price := (p_line ->> 'unit_price')::NUMERIC;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Quantity and price must be numbers' USING ERRCODE = '22023';
  END;
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RAISE EXCEPTION 'Quantity must be more than 0' USING ERRCODE = '22023';
  END IF;
  IF scale(trim_scale(v_qty)) > 3 THEN
    RAISE EXCEPTION 'Quantities can have at most 3 decimal places' USING ERRCODE = '22023';
  END IF;
  IF v_price IS NULL OR v_price < 0 THEN
    RAISE EXCEPTION 'Price can''t be negative' USING ERRCODE = '22023';
  END IF;
  IF scale(trim_scale(v_price)) > 2 THEN
    RAISE EXCEPTION 'Prices are in pounds and pence (at most 2 decimal places)' USING ERRCODE = '22023';
  END IF;
END
$$;

-- The organisation's standard VAT rate (company profile defaultVatRate, 0..100, else 20).
CREATE OR REPLACE FUNCTION public.org_standard_vat_rate(p_org UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce((
    SELECT CASE WHEN jsonb_typeof(s.company_profile -> 'defaultVatRate') = 'number'
                 AND (s.company_profile ->> 'defaultVatRate')::NUMERIC BETWEEN 0 AND 100
                THEN (s.company_profile ->> 'defaultVatRate')::NUMERIC ELSE 20 END
    FROM public.organization_settings s WHERE s.organization_id = p_org), 20)
$$;

-- Header totals must equal what the stored lines add up to (same policy as lib/money.ts).
CREATE OR REPLACE FUNCTION public.check_document_totals(p_parent TEXT, p_id UUID, p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_std   NUMERIC := public.org_standard_vat_rate(p_org);
  v_net   NUMERIC;
  v_vat   NUMERIC;
  v_doc   RECORD;
  v_total NUMERIC;
  v_child TEXT := CASE p_parent WHEN 'invoices' THEN 'invoice_line_items' WHEN 'quotes' THEN 'quote_line_items' END;
  v_fk    TEXT := CASE p_parent WHEN 'invoices' THEN 'invoice_id' WHEN 'quotes' THEN 'quote_id' END;
BEGIN
  IF v_child IS NULL THEN
    RAISE EXCEPTION 'check_document_totals: unsupported document' USING ERRCODE = '22023';
  END IF;
  EXECUTE format(
    'SELECT coalesce(sum(round(quantity * unit_price, 2)), 0),
            coalesce(sum(CASE WHEN vat_exempt THEN 0 ELSE round(round(quantity * unit_price, 2) * vat_pct / 100, 2) END), 0)
     FROM public.%I WHERE %I = $1', v_child, v_fk)
    INTO v_net, v_vat USING p_id;

  IF p_parent = 'invoices' THEN
    SELECT i.vat_enabled, coalesce(i.carriage, 0) AS carriage, i.carriage_vat, i.subtotal, i.vat, i.total
      INTO v_doc FROM public.invoices i WHERE i.id = p_id;
    v_vat := CASE WHEN v_doc.vat_enabled
                  THEN v_vat + CASE WHEN v_doc.carriage_vat THEN round(v_doc.carriage * v_std / 100, 2) ELSE 0 END
                  ELSE 0 END;
    v_total := v_net + v_doc.carriage + v_vat;
    IF v_doc.subtotal IS DISTINCT FROM v_net OR v_doc.vat IS DISTINCT FROM v_vat OR v_doc.total IS DISTINCT FROM v_total THEN
      RAISE EXCEPTION 'The invoice totals don''t match its lines (expected subtotal %, VAT %, total %)', v_net, v_vat, v_total
        USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT q.vat_enabled, q.total_value INTO v_doc FROM public.quotes q WHERE q.id = p_id;
    v_total := v_net + CASE WHEN v_doc.vat_enabled THEN v_vat ELSE 0 END;
    IF v_doc.total_value IS DISTINCT FROM v_total THEN
      RAISE EXCEPTION 'The quote total doesn''t match its lines (expected %)', v_total USING ERRCODE = '22023';
    END IF;
  END IF;
END
$$;

-- Snapshot of the issuing company (019).
CREATE OR REPLACE FUNCTION public.issuer_snapshot(p_org UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
      'name', s.company_profile -> 'name', 'documentName', s.company_profile -> 'documentName',
      'addressLines', s.company_profile -> 'addressLines', 'phone', s.company_profile -> 'phone',
      'fax', s.company_profile -> 'fax', 'email', s.company_profile -> 'email', 'website', s.company_profile -> 'website',
      'vatNumber', s.company_profile -> 'vatNumber', 'vatRegistered', s.company_profile -> 'vatRegistered',
      'defaultVatRate', to_jsonb(public.org_standard_vat_rate(p_org)), 'defaultInvoiceTerms', s.company_profile -> 'defaultInvoiceTerms',
      'defaultQuoteTerms', s.company_profile -> 'defaultQuoteTerms',
      'defaultCustomerMessage', s.company_profile -> 'defaultCustomerMessage', 'capturedAt', to_jsonb(now())))
  FROM public.organization_settings s WHERE s.organization_id = p_org
$$;

-- Snapshot of the customer record matching a document's customer name (019).
CREATE OR REPLACE FUNCTION public.customer_snapshot(p_org UUID, p_name TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('name', coalesce(c.name, p_name), 'address', c.address, 'found', c.id IS NOT NULL)
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (
    SELECT cu.id, cu.name, cu.address FROM public.customers cu
    WHERE cu.organization_id = p_org AND lower(btrim(cu.name)) = lower(btrim(p_name))
    ORDER BY cu.created_at LIMIT 1) c ON TRUE
$$;

CREATE OR REPLACE FUNCTION public.create_with_lines(p_parent text, p_header jsonb, p_child text, p_fk text, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_uid     UUID := auth.uid();
  v_hdr     JSONB;
  v_line    JSONB;
  v_id      UUID;
  v_idx     INT := 0;
  v_pcols   TEXT[];
  v_ccols   TEXT[];
  v_key     TEXT;
  v_cols    TEXT;
  v_sel     TEXT;
  v_priced  BOOLEAN := p_child IN ('quote_line_items', 'invoice_line_items');
  v_status  TEXT;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  IF NOT ((p_parent, p_child, p_fk) IN (
        VALUES ('quotes', 'quote_line_items', 'quote_id'),
               ('invoices', 'invoice_line_items', 'invoice_id'),
               ('delivery_notes', 'delivery_note_items', 'delivery_note_id')
      )) THEN
    RAISE EXCEPTION 'create_with_lines: table combination not allowed' USING ERRCODE = '42501';
  END IF;

  IF p_header IS NULL OR jsonb_typeof(p_header) <> 'object' THEN
    RAISE EXCEPTION 'p_header must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'p_lines must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(coalesce(p_lines, '[]'::JSONB)) > 500 THEN
    RAISE EXCEPTION 'too many lines (max 500)' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(attname::TEXT) INTO v_pcols
  FROM pg_attribute
  WHERE attrelid = format('public.%I', p_parent)::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
  SELECT array_agg(attname::TEXT) INTO v_ccols
  FROM pg_attribute
  WHERE attrelid = format('public.%I', p_child)::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';

  -- ---- header --------------------------------------------------------------------------------------
  -- Snapshots are taken here, never accepted from the caller.
  v_hdr := p_header - 'id' - 'organization_id' - 'created_by' - 'updated_by' - 'issuer_snapshot' - 'customer_snapshot';
  -- Quotes and invoices are written as drafts first, so their lines can be added, then issued below (019).
  IF v_priced THEN
    v_status := v_hdr ->> 'status';
    v_hdr := v_hdr || jsonb_build_object('status', 'draft');
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_hdr) LOOP
    IF v_key !~ '^[a-z_][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'invalid column name in header: %', v_key USING ERRCODE = '22023';
    END IF;
    IF NOT (v_key = ANY (v_pcols)) THEN
      RAISE EXCEPTION 'unknown column "%" for %', v_key, p_parent USING ERRCODE = '42703';
    END IF;
  END LOOP;
  v_hdr := v_hdr || jsonb_build_object('organization_id', v_org);
  IF 'created_by' = ANY (v_pcols) THEN v_hdr := v_hdr || jsonb_build_object('created_by', v_uid); END IF;
  IF 'updated_by' = ANY (v_pcols) THEN v_hdr := v_hdr || jsonb_build_object('updated_by', v_uid); END IF;

  SELECT string_agg(quote_ident(k), ', '), string_agg('r.' || quote_ident(k), ', ')
  INTO v_cols, v_sel
  FROM jsonb_object_keys(v_hdr) AS k;

  EXECUTE format(
    'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) AS r RETURNING id',
    p_parent, v_cols, v_sel, p_parent)
  INTO v_id USING v_hdr;

  -- ---- lines ---------------------------------------------------------------------------------------
  FOR v_line IN SELECT value FROM jsonb_array_elements(coalesce(p_lines, '[]'::JSONB)) LOOP
    IF jsonb_typeof(v_line) <> 'object' THEN
      RAISE EXCEPTION 'every line must be a JSON object' USING ERRCODE = '22023';
    END IF;
    v_line := v_line - 'id' - 'organization_id' - 'created_by' - 'updated_by' - p_fk;
    FOR v_key IN SELECT jsonb_object_keys(v_line) LOOP
      IF v_key !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'invalid column name in line: %', v_key USING ERRCODE = '22023';
      END IF;
      IF NOT (v_key = ANY (v_ccols)) THEN
        RAISE EXCEPTION 'unknown column "%" for %', v_key, p_child USING ERRCODE = '42703';
      END IF;
    END LOOP;
    -- Priced document lines: description, quantity and price as sent (public.check_priced_line, 021).
    IF v_priced THEN
      PERFORM public.check_priced_line(v_line);
    END IF;

    v_line := v_line || jsonb_build_object(p_fk, v_id, 'organization_id', v_org);
    IF 'position' = ANY (v_ccols) AND NOT (v_line ? 'position') THEN
      v_line := v_line || jsonb_build_object('position', v_idx);
    END IF;

    SELECT string_agg(quote_ident(k), ', '), string_agg('r.' || quote_ident(k), ', ')
    INTO v_cols, v_sel
    FROM jsonb_object_keys(v_line) AS k;

    EXECUTE format(
      'INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) AS r',
      p_child, v_cols, v_sel, p_child)
    USING v_line;

    v_idx := v_idx + 1;
  END LOOP;

  -- ---- totals: the header must equal what its stored lines add up to (public.check_document_totals, 021) ----
  IF v_priced THEN
    IF v_idx = 0 THEN
      RAISE EXCEPTION 'Add at least one line item' USING ERRCODE = '22023';
    END IF;
    PERFORM public.check_document_totals(p_parent, v_id, v_org);
  END IF;

  -- ---- issue: snapshot who issued it and to whom, then set the requested status ---------------------
  IF v_priced THEN
    EXECUTE format(
      'UPDATE public.%I d SET status = coalesce($2, d.status), issuer_snapshot = $3, customer_snapshot = $4 WHERE d.id = $1', p_parent)
    USING v_id, v_status, public.issuer_snapshot(v_org), public.customer_snapshot(v_org, v_hdr ->> 'customer');
  END IF;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.replace_draft_quote(p_quote UUID, p_expected_updated_at TIMESTAMPTZ, p_header JSONB, p_lines JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.replace_draft_quote(UUID, TIMESTAMPTZ, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_draft_quote(UUID, TIMESTAMPTZ, JSONB, JSONB) TO authenticated;

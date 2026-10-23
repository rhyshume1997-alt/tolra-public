-- =====================================================================================================
-- 019: issued invoices keep their economics; documents remember who issued them and to whom (audit B4a: D8, D9,
-- A8, issue side of D17).
--
-- 1. Snapshot at issue. New columns issuer_snapshot / customer_snapshot on quotes and invoices, written by
--    create_with_lines from the company profile and the customer record as they are at that moment (never taken
--    from the caller). PDFs print from them, so a later change of address, VAT registration, standard rate or
--    terms doesn't change a document already sent. Existing documents keep NULL (their history wasn't recorded
--    and is not reconstructed from today's data).
-- 2. Draft -> lines -> issue. create_with_lines inserts a quote or invoice as a draft, adds and checks its lines,
--    then sets the requested status, all in one transaction.
-- 3. Issue lock for invoices. Once an invoice is no longer a draft, API users (anon, authenticated, service role)
--    can't change its amounts, customer, dates, terms, references, VAT settings, snapshots or lines, can't move it
--    back to draft, and can't delete it. Receipts and lifecycle stay possible: status, amount_paid, paid_at,
--    sent_date, job_id. The database owner (imports, SQL editor maintenance) is not restricted.
--
-- Forward only, safe to run more than once.
-- =====================================================================================================

ALTER TABLE public.quotes   ADD COLUMN IF NOT EXISTS issuer_snapshot JSONB, ADD COLUMN IF NOT EXISTS customer_snapshot JSONB;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS issuer_snapshot JSONB, ADD COLUMN IF NOT EXISTS customer_snapshot JSONB;

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
  v_qty     NUMERIC;
  v_price   NUMERIC;
  v_rate    NUMERIC;
  v_std     NUMERIC;
  v_net     NUMERIC;
  v_vat     NUMERIC;
  v_doc     RECORD;
  v_total   NUMERIC;
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
    -- Priced document lines (audit B3: D11, D12, D13, A14): a description, a quantity above zero with at most 3
    -- decimal places and a price of zero or more in pounds and pence. Checked on the values as sent, before the
    -- column types could round them silently.
    IF v_priced THEN
      IF btrim(coalesce(v_line ->> 'description', '')) = '' THEN
        RAISE EXCEPTION 'Every line needs a description' USING ERRCODE = '22023';
      END IF;
      BEGIN
        v_qty := (v_line ->> 'quantity')::NUMERIC;
        v_price := (v_line ->> 'unit_price')::NUMERIC;
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

  -- ---- totals: the header must equal what its stored lines add up to --------------------------------
  -- Same policy as lib/money.ts: each line's net rounded to the penny, VAT per line at its rate (exempt lines
  -- none), carriage VAT at the company's standard rate when switched on, everything half away from zero.
  -- A mismatch raises, which rolls back the header and every line.
  IF v_priced THEN
    IF v_idx = 0 THEN
      RAISE EXCEPTION 'Add at least one line item' USING ERRCODE = '22023';
    END IF;

    SELECT CASE WHEN jsonb_typeof(s.company_profile -> 'defaultVatRate') = 'number'
                 AND (s.company_profile ->> 'defaultVatRate')::NUMERIC BETWEEN 0 AND 100
                THEN (s.company_profile ->> 'defaultVatRate')::NUMERIC ELSE 20 END
      INTO v_std
    FROM public.organization_settings s WHERE s.organization_id = v_org;
    v_std := coalesce(v_std, 20);

    EXECUTE format(
      'SELECT coalesce(sum(round(quantity * unit_price, 2)), 0),
              coalesce(sum(CASE WHEN vat_exempt THEN 0 ELSE round(round(quantity * unit_price, 2) * vat_pct / 100, 2) END), 0)
       FROM public.%I WHERE %I = $1', p_child, p_fk)
      INTO v_net, v_vat USING v_id;

    IF p_parent = 'invoices' THEN
      SELECT i.vat_enabled, coalesce(i.carriage, 0) AS carriage, i.carriage_vat, i.subtotal, i.vat, i.total
        INTO v_doc FROM public.invoices i WHERE i.id = v_id;
      v_vat := CASE WHEN v_doc.vat_enabled
                    THEN v_vat + CASE WHEN v_doc.carriage_vat THEN round(v_doc.carriage * v_std / 100, 2) ELSE 0 END
                    ELSE 0 END;
      v_total := v_net + v_doc.carriage + v_vat;
      IF v_doc.subtotal IS DISTINCT FROM v_net OR v_doc.vat IS DISTINCT FROM v_vat OR v_doc.total IS DISTINCT FROM v_total THEN
        RAISE EXCEPTION 'The invoice totals don''t match its lines (expected subtotal %, VAT %, total %)', v_net, v_vat, v_total
          USING ERRCODE = '22023';
      END IF;
    ELSE
      SELECT q.vat_enabled, q.total_value INTO v_doc FROM public.quotes q WHERE q.id = v_id;
      v_total := v_net + CASE WHEN v_doc.vat_enabled THEN v_vat ELSE 0 END;
      IF v_doc.total_value IS DISTINCT FROM v_total THEN
        RAISE EXCEPTION 'The quote total doesn''t match its lines (expected %)', v_total USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;

  -- ---- issue: snapshot who issued it and to whom, then set the requested status ---------------------
  IF v_priced THEN
    EXECUTE format(
      'UPDATE public.%I d SET status = coalesce($2, d.status), issuer_snapshot = $3, customer_snapshot = $4 WHERE d.id = $1', p_parent)
    USING v_id, v_status,
      (SELECT jsonb_strip_nulls(jsonb_build_object(
          'name', s.company_profile -> 'name', 'documentName', s.company_profile -> 'documentName',
          'addressLines', s.company_profile -> 'addressLines', 'phone', s.company_profile -> 'phone',
          'fax', s.company_profile -> 'fax', 'email', s.company_profile -> 'email', 'website', s.company_profile -> 'website',
          'vatNumber', s.company_profile -> 'vatNumber', 'vatRegistered', s.company_profile -> 'vatRegistered',
          'defaultVatRate', to_jsonb(v_std), 'defaultInvoiceTerms', s.company_profile -> 'defaultInvoiceTerms',
          'defaultQuoteTerms', s.company_profile -> 'defaultQuoteTerms',
          'defaultCustomerMessage', s.company_profile -> 'defaultCustomerMessage', 'capturedAt', to_jsonb(now())))
       FROM public.organization_settings s WHERE s.organization_id = v_org),
      (SELECT jsonb_build_object('name', coalesce(c.name, v_hdr ->> 'customer'), 'address', c.address, 'found', c.id IS NOT NULL)
       FROM (SELECT 1) one
       LEFT JOIN LATERAL (
         SELECT cu.id, cu.name, cu.address FROM public.customers cu
         WHERE cu.organization_id = v_org AND lower(btrim(cu.name)) = lower(btrim(v_hdr ->> 'customer'))
         ORDER BY cu.created_at LIMIT 1) c ON TRUE);
  END IF;

  RETURN v_id;
END;
$function$;

-- ---- invoice issue lock -------------------------------------------------------------------------------
-- True for requests through the API roles; false for the owner (imports, maintenance). Reads the role the request
-- runs as (PostgREST's SET ROLE), which a SECURITY DEFINER function doesn't change, unlike current_user.
CREATE OR REPLACE FUNCTION public.is_api_role()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(nullif(current_setting('role', true), 'none'), session_user::TEXT) IN ('anon', 'authenticated', 'service_role')
$$;

CREATE OR REPLACE FUNCTION public.invoice_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Fields that may still change after issue: receipts and lifecycle.
  v_open CONSTANT TEXT[] := ARRAY['status', 'amount_paid', 'paid_at', 'sent_date', 'job_id', 'updated_at', 'updated_by'];
BEGIN
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t be deleted.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t go back to draft.', OLD.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Invoice % has been issued: its amounts, customer and details can''t be changed (only payment and status).', OLD.invoice_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS invoice_issue_lock ON public.invoices;
CREATE TRIGGER invoice_issue_lock BEFORE UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoice_issue_lock();

CREATE OR REPLACE FUNCTION public.invoice_lines_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ref TEXT;
BEGIN
  IF public.is_api_role() THEN
    SELECT i.invoice_ref INTO v_ref FROM public.invoices i
    WHERE i.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.invoice_id END, CASE WHEN TG_OP <> 'DELETE' THEN NEW.invoice_id END)
      AND coalesce(i.status, 'draft') <> 'draft'
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Invoice % has been issued, so its lines can''t be changed.', v_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION public.invoice_lines_issue_lock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoice_lines_issue_lock ON public.invoice_line_items;
CREATE TRIGGER invoice_lines_issue_lock BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION public.invoice_lines_issue_lock();

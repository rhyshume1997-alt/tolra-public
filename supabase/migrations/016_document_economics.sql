-- =====================================================================================================
-- 016: trusted economics for new quotes and invoices (audit B3: D11, D12, D13, A8, A14).
--
-- create_with_lines is the only path the app uses to create a quote or invoice with its lines (one transaction).
-- It now refuses, before anything is stored:
--   * a priced line without a description, with a quantity of zero or less or more than 3 decimal places, or a
--     negative price or one with more than 2 decimal places (no silent rounding by the column types);
--   * a quote or invoice with no lines;
--   * header totals that differ from what the stored lines add up to (net per line rounded to the penny, VAT per
--     line, carriage VAT at the company's standard rate, half away from zero: the same policy as lib/money.ts).
-- Delivery notes are unchanged. Existing documents are not touched or recalculated; see
-- supabase/verify/document_totals.sql for a read-only list of historical differences.
--
-- Forward only: same signature and grants as 006. Safe to run more than once.
-- =====================================================================================================

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
  v_hdr := p_header - 'id' - 'organization_id' - 'created_by' - 'updated_by';
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

  RETURN v_id;
END;
$function$;

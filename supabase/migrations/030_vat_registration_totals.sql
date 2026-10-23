-- =====================================================================================================
-- 030: totals follow VAT registration.
--
-- A company that isn't VAT registered prints no VAT on any document (lib/vat.ts companyVat, BaseDocumentPDF), and the
-- app saves its documents with VAT off. The server's totals check (public.check_document_totals, 021) only looked at
-- each document's vat_enabled flag, so an invoice or quote drafted with VAT could still be issued or sent after the
-- company turned VAT registration off: the stored totals would include VAT the document can never print. The check
-- now applies VAT only when the document has VAT on AND the organisation is VAT registered (company profile
-- vatRegistered, registered unless explicitly false, the same rule as the app). Nothing changes for registered
-- organisations. Forward only, safe to run more than once.
-- =====================================================================================================

-- Whether the organisation is VAT registered (company profile vatRegistered; anything but false counts as registered).
CREATE OR REPLACE FUNCTION public.org_vat_registered(p_org UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce((
    SELECT NOT (s.company_profile -> 'vatRegistered' IS NOT DISTINCT FROM 'false'::jsonb)
    FROM public.organization_settings s WHERE s.organization_id = p_org), true)
$$;

-- -----------------------------------------------------------------------------------------------------

-- Header totals must equal what the stored lines add up to (same policy as lib/money.ts). As 021, except VAT counts
-- only when the organisation is VAT registered.
CREATE OR REPLACE FUNCTION public.check_document_totals(p_parent TEXT, p_id UUID, p_org UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_std   NUMERIC := public.org_standard_vat_rate(p_org);
  v_reg   BOOLEAN := public.org_vat_registered(p_org);
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
    v_vat := CASE WHEN v_doc.vat_enabled AND v_reg
                  THEN v_vat + CASE WHEN v_doc.carriage_vat THEN round(v_doc.carriage * v_std / 100, 2) ELSE 0 END
                  ELSE 0 END;
    v_total := v_net + v_doc.carriage + v_vat;
    IF v_doc.subtotal IS DISTINCT FROM v_net OR v_doc.vat IS DISTINCT FROM v_vat OR v_doc.total IS DISTINCT FROM v_total THEN
      RAISE EXCEPTION 'The invoice totals don''t match its lines (expected subtotal %, VAT %, total %)', v_net, v_vat, v_total
        USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT q.vat_enabled, q.total_value INTO v_doc FROM public.quotes q WHERE q.id = p_id;
    v_total := v_net + CASE WHEN v_doc.vat_enabled AND v_reg THEN v_vat ELSE 0 END;
    IF v_doc.total_value IS DISTINCT FROM v_total THEN
      RAISE EXCEPTION 'The quote total doesn''t match its lines (expected %)', v_total USING ERRCODE = '22023';
    END IF;
  END IF;
END
$$;

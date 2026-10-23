-- =====================================================================================================
-- 073: invoice screen go-live essentials. Voiding an invoice through one server step (with a reason, an audit row and the checks),
-- a DB guard that closes the direct-update route to 'void', £0 text-only invoice lines, a one-line invoice note, a delivery address
-- on the invoice and a mobile number on the customer.
--
-- 1. void_invoice(p_invoice_id, p_reason) (SECURITY DEFINER, like 034's credit and payment steps): the second step (033) first;
--    admin or office of the caller's company with the invoices section shown (as allocate_credit_note, record_invoice_payment). The
--    invoice is locked (FOR UPDATE, the same lock every payment and credit step takes first, so they run one after the other) and
--    refused, in plain English (22023, with a hint naming the rule), when it is:
--      * a draft (no number: delete it instead) or already void ('void' or 'cancelled');
--      * paid or part paid (status 'paid' or 'partial', amount_paid not 0, or its payments not adding up to 0), or its imported
--        payments not yet confirmed (payment_unverified);
--      * credited (status 'credited', credited_amount or refunded_amount not 0);
--      * the invoice of any credit note (draft or issued), of any credit allocation, or on either side of a customer-credit ledger
--        row (refund from it, or credit moved to or from it);
--      * written off;
--      * in any status other than exactly 'issued' or 'sent' (an older row with a status outside the allowlist below is refused,
--        never guessed at). Every status comparison is exact: no trimming or case folding.
--    The reason is required, trimmed, at most 500 characters. The status becomes 'void' and an audit row VOID_INVOICE (reason, the
--    status it had, its number) is written in the same transaction; the row-change audit records the status change as well.
--    Another company's invoice reads as "not found". Delivery notes on it are freed exactly as before (034/059 treat a void invoice
--    as no invoice).
-- 2. invoices.status allowlist (invoices_status_allowlist, BEFORE INSERT OR UPDATE OF status, the API roles anon, authenticated and
--    service_role; the database owner, which runs the migrations and the psql importers, is not held to it): from 073 on a status
--    is only ever WRITTEN as exactly one of draft, issued, sent, partial, paid, credited, void, cancelled, written_off (23514, hint
--    invoice_status_not_allowed). Rows keep whatever status they already have: the rule runs only when the status changes. This is
--    the root fix for the review finding that 'void' with a line break, a tab, a trailing space or a no-break space (or 'VOID')
--    passed a guard that only trimmed spaces, read as void in the app, and still took payments (034's payment steps compare
--    lower(status) without trimming). The other spellings the app and 034 read as void ('voided', 'canceled') are not written.
--    invoices_void_guard (BEFORE UPDATE on invoices, browser roles anon/authenticated only; the importer and the service role write
--    finished records, as 033's documents_start_as_drafts): a change of status INTO 'void' or 'cancelled' (exact; the allowlist has
--    already refused any other spelling) is refused unless
--    void_invoice is making it (transaction-local flag quoteflow.invoice_void = that invoice's id, the pattern 034 uses for
--    quoteflow.invoice_payment). Before 073 an admin or office user could set 'void' with a direct API update even when a credit had
--    been applied (034's lock covers only paid/part-paid/credited). A void invoice also stays void: its status can't be changed back
--    by the browser roles (its delivery notes may already be on a new invoice); an OLD status counts as void when its letters alone
--    spell void, voided, cancelled or canceled (older rows may hold any spelling). 034's invoice_issue_lock is unchanged.
-- 3. £0 text-only invoice lines: a line with quantity 0 AND unit price 0 and a description (for a note such as "Collected by
--    customer" among the priced lines). It adds nothing to the subtotal or VAT (check_document_totals sums quantity x price, so it is
--    0 by construction). For invoice lines only:
--      * invoice_line_items_quantity_positive keeps its name (006's loop adds it again if the name is missing) and becomes
--        quantity > 0 OR (quantity = 0 AND unit_price = 0). It stays NOT VALID if it was (006 added it NOT VALID so old rows could
--        not block a release); if it had been validated, the new one is validated too (every row that met the old rule meets this).
--      * check_invoice_line(line): a text line as above, otherwise exactly check_priced_line (021). create_with_lines (021) and
--        replace_draft_invoice (067) use it for invoice lines; quotes, sales orders and delivery notes still use check_priced_line
--        and their own constraints, unchanged (a quote never has a 0 line, so converting a quote is unaffected). A credit note can't
--        credit a text line (034's per-line caps: nothing was invoiced on it).
--      * An invoice made only of text lines can't be issued (invoices_issue_needs_priced_line, AFTER UPDATE OF status, API roles:
--        leaving draft with lines that are all text lines is refused, 22023). Invoices with no lines at all are unchanged.
-- 4. invoices.invoice_note: one line (no line breaks), at most 200 characters, NULL when empty. Printed on the invoice.
-- 5. invoices.delivery_address: at most 500 characters, NULL when empty. No existing record holds a delivery address (customers have
--    one address, printed as the invoice address; jobs, orders and delivery notes have none), so new invoices start with it blank.
--    Both are written on a DRAFT through replace_draft_invoice (its header now takes invoice_note and delivery_address) and, like
--    every other detail, are fixed once the invoice is issued (019/034's invoice_issue_lock compares every column not listed open).
-- 6. customers.mobile: at most 40 characters, NULL when empty. Same rules as the customer's other fields (001's row rules).
--
-- Forward only, safe to run more than once. Nothing is backfilled. The previous app build keeps working with 073 applied: it never
-- sends a 0 line, never reads or writes the new columns, and never voids (the invoice screen had no Void before 073).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 4, 5, 6. New columns ---------------------------------------------------------------------------------------
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS invoice_note TEXT;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_invoice_note_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_invoice_note_check CHECK (
  invoice_note IS NULL OR (btrim(invoice_note) <> '' AND length(invoice_note) <= 200 AND invoice_note !~ '[\r\n]'));
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_delivery_address_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_delivery_address_check CHECK (
  delivery_address IS NULL OR (btrim(delivery_address) <> '' AND length(delivery_address) <= 500));
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_mobile_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_mobile_check CHECK (
  mobile IS NULL OR (btrim(mobile) <> '' AND length(mobile) <= 40));

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. £0 text-only invoice lines -------------------------------------------------------------------------------
DO $do$
DECLARE
  v_def   TEXT;
  v_valid BOOLEAN;
BEGIN
  SELECT pg_get_constraintdef(c.oid), c.convalidated INTO v_def, v_valid
  FROM pg_constraint c WHERE c.conrelid = 'public.invoice_line_items'::regclass AND c.conname = 'invoice_line_items_quantity_positive';
  IF v_def IS NOT NULL AND v_def LIKE '%unit_price%' THEN
    RETURN; -- already 073's rule
  END IF;
  ALTER TABLE public.invoice_line_items DROP CONSTRAINT IF EXISTS invoice_line_items_quantity_positive;
  ALTER TABLE public.invoice_line_items ADD CONSTRAINT invoice_line_items_quantity_positive
    CHECK (quantity > 0 OR (quantity = 0 AND unit_price = 0)) NOT VALID;
  IF coalesce(v_valid, FALSE) THEN
    ALTER TABLE public.invoice_line_items VALIDATE CONSTRAINT invoice_line_items_quantity_positive;
  END IF;
END
$do$;

-- An invoice line as sent: a £0 text line (description, quantity 0, price 0), or a priced line exactly as check_priced_line (021).
CREATE OR REPLACE FUNCTION public.check_invoice_line(p_line JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_qty   NUMERIC;
  v_price NUMERIC;
BEGIN
  BEGIN
    v_qty := (p_line ->> 'quantity')::NUMERIC;
    v_price := (p_line ->> 'unit_price')::NUMERIC;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Quantity and price must be numbers' USING ERRCODE = '22023';
  END;
  IF v_qty = 0 AND v_price = 0 THEN
    IF btrim(coalesce(p_line ->> 'description', '')) = '' THEN
      RAISE EXCEPTION 'A text line needs its text (the description)' USING ERRCODE = '22023';
    END IF;
    RETURN;
  END IF;
  PERFORM public.check_priced_line(p_line);
END
$$;
-- Called from create_with_lines and replace_draft_invoice, which run as the signed-in user.
REVOKE ALL ON FUNCTION public.check_invoice_line(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_invoice_line(JSONB) TO authenticated, service_role;

-- An invoice made only of £0 text lines can't be issued: leaving draft needs at least one priced line when it has lines at all
-- (an invoice with no lines is left to the existing rules). API roles, as 027's issue_requires_matching_totals.
CREATE OR REPLACE FUNCTION public.invoices_issue_needs_priced_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.is_api_role() AND coalesce(OLD.status, 'draft') = 'draft' AND coalesce(NEW.status, 'draft') <> 'draft'
     AND EXISTS (SELECT 1 FROM public.invoice_line_items l WHERE l.invoice_id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items l WHERE l.invoice_id = NEW.id AND l.quantity > 0) THEN
    RAISE EXCEPTION 'This invoice has only text lines: add at least one priced line before issuing it.' USING ERRCODE = '22023', HINT = 'invoice_text_lines_only';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.invoices_issue_needs_priced_line() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_issue_needs_priced_line ON public.invoices;
CREATE TRIGGER invoices_issue_needs_priced_line AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_issue_needs_priced_line();

-- create_with_lines (021) with one change: invoice lines are checked by check_invoice_line (above); quote lines still by
-- check_priced_line. Otherwise exactly as 021.
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
    -- Priced document lines: description, quantity and price as sent (public.check_priced_line, 021). An invoice may also have a
    -- £0 text line (public.check_invoice_line, 073).
    IF p_child = 'invoice_line_items' THEN
      PERFORM public.check_invoice_line(v_line);
    ELSIF v_priced THEN
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

-- replace_draft_invoice (067) with two changes: the header also takes invoice_note and delivery_address (blank = none), and lines are
-- checked by check_invoice_line (a £0 text line is allowed). Otherwise exactly as 067.
CREATE OR REPLACE FUNCTION public.replace_draft_invoice(p_invoice UUID, p_expected_updated_at TIMESTAMPTZ, p_header JSONB, p_lines JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_inv     public.invoices%ROWTYPE;
  v_line    JSONB;
  v_idx     INT := 0;
  v_now     TIMESTAMPTZ := clock_timestamp();
  v_allowed CONSTANT TEXT[] := ARRAY['description', 'quantity', 'unit_price', 'subtotal', 'carriage', 'vat', 'total', 'invoice_date',
                                     'due_date', 'tax_point', 'terms', 'customer_po', 'invoice_note', 'delivery_address'];
  v_key     TEXT;
  v_date    DATE;
  v_due     DATE;
  v_carr    NUMERIC;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_inv.status, 'draft') <> 'draft' THEN
    RAISE EXCEPTION 'Invoice % has been issued, so it can''t be changed: correct it with a credit note.', v_inv.invoice_ref USING ERRCODE = '42501';
  END IF;
  IF v_inv.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'This draft invoice was changed by someone else since you opened it. Reload it and make your changes again.' USING ERRCODE = 'PT409';
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
    RAISE EXCEPTION 'Keep at least one line on the invoice (delete the draft if nothing is to be billed).' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_lines) > 500 THEN
    RAISE EXCEPTION 'too many lines (max 500)' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_date := CASE WHEN p_header ? 'invoice_date' THEN (p_header ->> 'invoice_date')::DATE ELSE v_inv.invoice_date END;
    v_due  := CASE WHEN p_header ? 'due_date' THEN (p_header ->> 'due_date')::DATE ELSE v_inv.due_date END;
    v_carr := CASE WHEN p_header ? 'carriage' THEN coalesce((p_header ->> 'carriage')::NUMERIC, 0) ELSE coalesce(v_inv.carriage, 0) END;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Dates must be real dates and carriage a number' USING ERRCODE = '22023';
  END;
  IF v_date IS NULL OR v_due IS NULL OR v_due < v_date THEN
    RAISE EXCEPTION 'Give an invoice date and a due date that is not before it.' USING ERRCODE = '22023';
  END IF;
  IF v_carr < 0 OR scale(trim_scale(v_carr)) > 2 THEN
    RAISE EXCEPTION 'Carriage is in pounds and pence and can''t be negative' USING ERRCODE = '22023';
  END IF;
  IF p_header ? 'invoice_note' AND (length(btrim(coalesce(p_header ->> 'invoice_note', ''))) > 200 OR coalesce(p_header ->> 'invoice_note', '') ~ '[\r\n]') THEN
    RAISE EXCEPTION 'The invoice note is one line of at most 200 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_header ? 'delivery_address' AND length(btrim(coalesce(p_header ->> 'delivery_address', ''))) > 500 THEN
    RAISE EXCEPTION 'The delivery address is at most 500 characters.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.invoices i SET
    description = CASE WHEN p_header ? 'description' THEN p_header ->> 'description' ELSE i.description END,
    quantity    = CASE WHEN p_header ? 'quantity' THEN (p_header ->> 'quantity')::NUMERIC ELSE i.quantity END,
    unit_price  = CASE WHEN p_header ? 'unit_price' THEN (p_header ->> 'unit_price')::NUMERIC ELSE i.unit_price END,
    subtotal    = CASE WHEN p_header ? 'subtotal' THEN (p_header ->> 'subtotal')::NUMERIC ELSE i.subtotal END,
    carriage    = v_carr,
    vat         = CASE WHEN p_header ? 'vat' THEN (p_header ->> 'vat')::NUMERIC ELSE i.vat END,
    total       = CASE WHEN p_header ? 'total' THEN (p_header ->> 'total')::NUMERIC ELSE i.total END,
    invoice_date = v_date,
    due_date    = v_due,
    tax_point   = CASE WHEN p_header ? 'tax_point' THEN nullif(p_header ->> 'tax_point', '')::DATE ELSE i.tax_point END,
    terms       = CASE WHEN p_header ? 'terms' THEN p_header ->> 'terms' ELSE i.terms END,
    customer_po = CASE WHEN p_header ? 'customer_po' THEN nullif(btrim(p_header ->> 'customer_po'), '') ELSE i.customer_po END,
    invoice_note = CASE WHEN p_header ? 'invoice_note' THEN nullif(btrim(p_header ->> 'invoice_note'), '') ELSE i.invoice_note END,
    delivery_address = CASE WHEN p_header ? 'delivery_address' THEN nullif(btrim(p_header ->> 'delivery_address'), '') ELSE i.delivery_address END,
    updated_at  = v_now,
    updated_by  = auth.uid()
  WHERE i.id = p_invoice;

  DELETE FROM public.invoice_line_items WHERE invoice_id = p_invoice;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    PERFORM public.check_invoice_line(v_line);
    INSERT INTO public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
    VALUES (v_org, p_invoice, v_idx, btrim(v_line ->> 'description'), (v_line ->> 'quantity')::NUMERIC, (v_line ->> 'unit_price')::NUMERIC,
            coalesce((v_line ->> 'vat_pct')::NUMERIC, 20), coalesce((v_line ->> 'vat_exempt')::BOOLEAN, FALSE));
    v_idx := v_idx + 1;
  END LOOP;

  -- The stored subtotal, VAT and total must be what the lines, carriage and the invoice's own VAT settings give (027's rule at issue).
  PERFORM public.check_document_totals('invoices', p_invoice, v_org);
  UPDATE public.invoices SET issuer_snapshot = public.issuer_snapshot(v_org), customer_snapshot = public.customer_snapshot(v_org, customer)
  WHERE id = p_invoice;
  RETURN v_now;
END
$$;
REVOKE ALL ON FUNCTION public.replace_draft_invoice(UUID, TIMESTAMPTZ, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_draft_invoice(UUID, TIMESTAMPTZ, JSONB, JSONB) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. Status allowlist; only void_invoice makes an invoice void ----------------------------------------------------
-- The exact statuses an invoice may be written with (API roles). Rows keep whatever they already have.
CREATE OR REPLACE FUNCTION public.invoices_status_allowlist()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.is_api_role() OR (TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status) THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NULL OR NOT (NEW.status = ANY (ARRAY['draft', 'issued', 'sent', 'partial', 'paid', 'credited', 'void', 'cancelled', 'written_off'])) THEN
    RAISE EXCEPTION 'An invoice''s status must be exactly one of: draft, issued, sent, partial, paid, credited, void, cancelled, written_off.'
      USING ERRCODE = '23514', HINT = 'invoice_status_not_allowed';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.invoices_status_allowlist() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_status_allowlist ON public.invoices;
CREATE TRIGGER invoices_status_allowlist BEFORE INSERT OR UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_status_allowlist();

CREATE OR REPLACE FUNCTION public.invoices_void_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_was  BOOLEAN;
  v_is   BOOLEAN;
BEGIN
  -- Only the browser roles are held to this; the importer, the database owner and the service role write finished records.
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated')
     OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  -- An older row may hold any spelling: its letters alone decide whether it is void. A new value is exact (the allowlist).
  v_was := lower(regexp_replace(coalesce(OLD.status, ''), '[^[:alpha:]]', '', 'g')) = ANY (ARRAY['void', 'voided', 'cancelled', 'canceled']);
  v_is  := NEW.status IN ('void', 'cancelled');
  IF v_was THEN
    RAISE EXCEPTION 'Invoice % has been voided, so it stays void: make a new invoice instead.', coalesce(OLD.invoice_ref, '')
      USING ERRCODE = '42501', HINT = 'invoice_void_final';
  END IF;
  IF v_is AND current_setting('quoteflow.invoice_void', TRUE) IS DISTINCT FROM OLD.id::TEXT THEN
    RAISE EXCEPTION 'Invoice %: an invoice is voided with Void invoice, which asks for a reason and checks it has no payments or credits.', coalesce(OLD.invoice_ref, '')
      USING ERRCODE = '42501', HINT = 'invoice_void_direct';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.invoices_void_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_void_guard ON public.invoices;
CREATE TRIGGER invoices_void_guard BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_void_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. void_invoice -----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_invoice(p_invoice_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org    UUID := public.current_user_organization_id();
  v_user   UUID := auth.uid();
  v_reason TEXT := btrim(coalesce(p_reason, ''));
  v_inv    RECORD;
  v_label  TEXT;
  v_status TEXT;
  v_paid   NUMERIC;
  v_email  TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'Give the reason the invoice is being voided.' USING ERRCODE = '22023', HINT = 'void_reason_required';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason can be at most 500 characters.' USING ERRCODE = '22023', HINT = 'void_reason_required';
  END IF;
  SELECT i.id, i.invoice_ref, i.status, i.total, i.amount_paid, i.credited_amount, i.refunded_amount, i.payment_unverified INTO v_inv
  FROM public.invoices i WHERE i.id = p_invoice_id AND i.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  v_label := coalesce(v_inv.invoice_ref, 'This invoice');
  v_status := coalesce(v_inv.status, 'draft'); -- exact: no trimming or case folding

  IF v_status IN ('void', 'cancelled') THEN
    RAISE EXCEPTION '% is already void.', v_label USING ERRCODE = '22023', HINT = 'invoice_already_void';
  END IF;
  IF v_status = 'draft' THEN
    RAISE EXCEPTION 'A draft invoice has no number yet: delete the draft instead of voiding it.' USING ERRCODE = '22023', HINT = 'invoice_draft';
  END IF;
  SELECT coalesce(sum(p.amount), 0) INTO v_paid FROM public.invoice_payments p WHERE p.invoice_id = p_invoice_id;
  IF v_status IN ('paid', 'partial') OR coalesce(v_inv.amount_paid, 0) <> 0 OR v_paid <> 0 THEN
    RAISE EXCEPTION '% has payments recorded against it, so it can''t be voided. Reverse the payments first, or correct it with a credit note.', v_label
      USING ERRCODE = '22023', HINT = 'invoice_paid';
  END IF;
  IF coalesce(v_inv.payment_unverified, FALSE) THEN
    RAISE EXCEPTION '% has imported payments still to be confirmed, so it can''t be voided yet.', v_label USING ERRCODE = '22023', HINT = 'invoice_payments_unconfirmed';
  END IF;
  IF v_status = 'credited' OR coalesce(v_inv.credited_amount, 0) <> 0 OR coalesce(v_inv.refunded_amount, 0) <> 0 THEN
    RAISE EXCEPTION '% has had a credit applied, so it can''t be voided.', v_label USING ERRCODE = '22023', HINT = 'invoice_credited';
  END IF;
  IF EXISTS (SELECT 1 FROM public.credit_notes c WHERE c.invoice_id = p_invoice_id)
     OR EXISTS (SELECT 1 FROM public.invoice_credit_allocations a WHERE a.invoice_id = p_invoice_id)
     OR EXISTS (SELECT 1 FROM public.customer_credit_ledger l WHERE l.invoice_id = p_invoice_id OR l.to_invoice_id = p_invoice_id) THEN
    RAISE EXCEPTION '% has a credit note or a credit against it, so it can''t be voided.', v_label USING ERRCODE = '22023', HINT = 'invoice_has_credit_notes';
  END IF;
  IF v_status = 'written_off' THEN
    RAISE EXCEPTION '% has been written off, so it can''t be voided.', v_label USING ERRCODE = '22023', HINT = 'invoice_written_off';
  END IF;
  -- Only an issued invoice is voided: exactly 'issued' or 'sent'. Anything else (an older row's own spelling) is refused, not guessed.
  IF v_status NOT IN ('issued', 'sent') THEN
    RAISE EXCEPTION '% has the status "%", which can''t be voided here. Ask for the record to be checked.', v_label, v_inv.status
      USING ERRCODE = '22023', HINT = 'invoice_status_not_voidable';
  END IF;

  PERFORM set_config('quoteflow.invoice_void', p_invoice_id::TEXT, TRUE);
  UPDATE public.invoices SET status = 'void' WHERE id = p_invoice_id;
  PERFORM set_config('quoteflow.invoice_void', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'VOID_INVOICE', 'invoices', p_invoice_id::TEXT,
          jsonb_build_object('source', 'write_audit', 'invoice_ref', v_inv.invoice_ref, 'reason', v_reason, 'from_status', v_inv.status));
  RETURN jsonb_build_object('invoice_id', p_invoice_id, 'invoice_ref', v_inv.invoice_ref, 'status', 'void');
END
$$;
REVOKE ALL ON FUNCTION public.void_invoice(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_invoice(UUID, TEXT) TO authenticated;

-- The second step (033) is the first statement of the new privileged function, as 034 checks for its own.
DO $do$
BEGIN
  IF position('assert_privileged_aal' IN pg_get_functiondef('public.void_invoice(uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '073: void_invoice does not start with the second-step check';
  END IF;
END
$do$;

-- 099 rollback: ONLY with Rhys's approval. Puts back 059's public.invoice_from_delivery_notes_draft, 081's job_finish_draft_invoice and
-- delivery_note_try_draft and 073's replace_draft_invoice byte for byte (same signatures, security and grants), and removes everything
-- 099 added: the triggers invoice_lines_within_despatched, invoice_lines_link_kept and zz_same_org_sales_order_line_id, the functions
-- order_line_billing, order_lines_lock, invoice_add_delivery_note, invoice_lines_within_despatched, invoice_lines_link_kept and
-- draft_invoice_balances, the table invoice_job_finish_legacy and the column invoice_line_items.sales_order_line_id (with its index).
-- No invoice, line quantity or delivery note is changed: drafts made under 099 keep the despatched quantities they bill (only their
-- order-line links go). Afterwards Job Finish again drafts the order's full quantities, and draft quantities are not checked against
-- what was despatched. Run the whole text as one transaction, then the release preflight (marker 099 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_dn TEXT;
  v_jf TEXT;
  v_td TEXT;
  v_rd TEXT;
BEGIN
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_dn FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_jf FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_td FROM pg_proc p WHERE p.oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)');
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) INTO v_rd FROM pg_proc p WHERE p.oid = to_regprocedure('public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)');
  -- First of each pair: 099's body; second: the predecessor's (a second run of this rollback).
  IF v_dn IS NULL OR v_dn NOT IN ('135a95ccc2934df3fee8811c3d7047a7', 'cff9113a2490bda9b901764974adfa0a') THEN
    RAISE EXCEPTION '099 rollback: invoice_from_delivery_notes_draft (md5 %) is neither 099''s nor 059''s; stop and compare', coalesce(v_dn, 'missing');
  END IF;
  IF v_jf IS NULL OR v_jf NOT IN ('af2b452bdda21370c6988fa7f363024b', '492fa39d76311ecfc78ce860a5f1160b') THEN
    RAISE EXCEPTION '099 rollback: job_finish_draft_invoice (md5 %) is neither 099''s nor 081''s; stop and compare', coalesce(v_jf, 'missing');
  END IF;
  IF v_td IS NULL OR v_td NOT IN ('86586da39cd1064a47265a1180480d27', '52a9771fec832f0e20e9d780e7561caa') THEN
    RAISE EXCEPTION '099 rollback: delivery_note_try_draft (md5 %) is neither 099''s nor 081''s; stop and compare', coalesce(v_td, 'missing');
  END IF;
  IF v_rd IS NULL OR v_rd NOT IN ('10b805353825ebc49549d103a36eb900', 'bc56dd3aa75000c36f959955b71026ca') THEN
    RAISE EXCEPTION '099 rollback: replace_draft_invoice (md5 %) is neither 099''s nor 073''s; stop and compare', coalesce(v_rd, 'missing');
  END IF;
END
$$;

-- 059's invoice_from_delivery_notes_draft, verbatim (supabase/migrations/059_delivery_note_auto_invoice.sql section 1).
CREATE OR REPLACE FUNCTION public.invoice_from_delivery_notes_draft(p_org UUID, p_notes UUID[], p_invoice_date DATE, p_due_date DATE, p_terms TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     UUID := p_org;
  v_ids     UUID[] := ARRAY(SELECT DISTINCT n FROM unnest(p_notes) AS n WHERE n IS NOT NULL);
  v_found   INT;
  v_dn      RECORD;
  v_cust    TEXT;
  v_reg     BOOLEAN := public.org_vat_registered(p_org);
  v_vat_on  BOOLEAN;
  v_flags   INT;
  v_orders  INT;
  v_jobs    INT;
  v_lines   JSONB;
  v_net     NUMERIC;
  v_vat     NUMERIC;
  v_first   RECORD;
  v_so      RECORD;
  v_invoice UUID;
BEGIN
  -- create_with_lines writes the invoice into the session's company: the company named here must be that one.
  IF v_org IS NULL OR v_org IS DISTINCT FROM public.current_user_organization_id() THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF coalesce(array_length(v_ids, 1), 0) = 0 OR array_length(v_ids, 1) > 50 THEN
    RAISE EXCEPTION 'Choose between one and fifty delivery notes.' USING ERRCODE = '22023';
  END IF;
  IF p_invoice_date IS NULL OR p_due_date IS NULL OR p_due_date < p_invoice_date THEN
    RAISE EXCEPTION 'Give an invoice date and a due date that is not before it.' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.delivery_notes WHERE id = ANY (v_ids) AND organization_id = v_org ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_found FROM public.delivery_notes WHERE id = ANY (v_ids) AND organization_id = v_org;
  IF v_found <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'Delivery note not found' USING ERRCODE = 'P0002';
  END IF;

  FOR v_dn IN SELECT d.id, d.dn_number, d.status, d.customer, d.invoice_id, i.status AS invoice_status, i.invoice_ref
              FROM public.delivery_notes d LEFT JOIN public.invoices i ON i.id = d.invoice_id WHERE d.id = ANY (v_ids) ORDER BY d.dn_number LOOP
    IF v_dn.invoice_id IS NOT NULL AND lower(coalesce(v_dn.invoice_status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled') THEN
      RAISE EXCEPTION '% is already on %: it can''t be invoiced twice.', v_dn.dn_number, coalesce(v_dn.invoice_ref, 'a draft invoice') USING ERRCODE = '22023';
    END IF;
    IF v_dn.status NOT IN ('despatched', 'delivered', 'signed') THEN
      RAISE EXCEPTION '% hasn''t gone out yet: mark it as sent out before invoicing it.', v_dn.dn_number USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.delivery_note_items WHERE delivery_note_id = v_dn.id) THEN
      RAISE EXCEPTION '% has no items.', v_dn.dn_number USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.delivery_note_items WHERE delivery_note_id = v_dn.id AND sales_order_line_id IS NULL) THEN
      RAISE EXCEPTION '% has items that weren''t made from an order, so their prices aren''t known. Invoice it by hand.', v_dn.dn_number USING ERRCODE = '22023';
    END IF;
    IF public.delivery_note_draft_block(v_dn.id) = 'internal-job' THEN
      RAISE EXCEPTION '% is for an internal job, which is never invoiced.', v_dn.dn_number USING ERRCODE = '42501', HINT = 'internal_job';
    END IF;
  END LOOP;

  -- One customer: the same name, ignoring case and repeated spaces (the invoice takes one of the spellings).
  SELECT count(DISTINCT lower(regexp_replace(btrim(coalesce(d.customer, '')), '\s+', ' ', 'g'))), min(d.customer) INTO v_found, v_cust
  FROM public.delivery_notes d WHERE d.id = ANY (v_ids);
  IF v_found > 1 THEN
    RAISE EXCEPTION 'The delivery notes are for different customers: invoice each customer separately.' USING ERRCODE = '22023';
  END IF;

  -- One invoice line per order line: the total despatched on the chosen notes, at the order's price and VAT.
  SELECT count(DISTINCT o.vat_enabled), count(DISTINCT o.id), bool_or(o.vat_enabled) INTO v_flags, v_orders, v_vat_on
  FROM public.delivery_note_items i
  JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id
  JOIN public.sales_orders o ON o.id = l.sales_order_id
  WHERE i.delivery_note_id = ANY (v_ids);
  IF v_flags > 1 THEN
    RAISE EXCEPTION 'The orders disagree on VAT: invoice them separately.' USING ERRCODE = '22023';
  END IF;
  v_vat_on := coalesce(v_vat_on, FALSE) AND v_reg;

  SELECT jsonb_agg(jsonb_build_object('position', g.n - 1, 'description', g.description, 'quantity', g.quantity, 'unit_price', g.unit_price,
                                      'vat_pct', g.vat_pct, 'vat_exempt', g.vat_exempt) ORDER BY g.n),
         coalesce(sum(round(g.quantity * g.unit_price, 2)), 0),
         coalesce(sum(CASE WHEN g.vat_exempt THEN 0 ELSE round(round(g.quantity * g.unit_price, 2) * g.vat_pct / 100, 2) END), 0)
    INTO v_lines, v_net, v_vat
  FROM (
    SELECT row_number() OVER (ORDER BY o.so_number, l.position, l.id) AS n, l.description, sum(i.quantity) AS quantity, l.unit_price, l.vat_pct, l.vat_exempt
    FROM public.delivery_note_items i
    JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id
    JOIN public.sales_orders o ON o.id = l.sales_order_id
    WHERE i.delivery_note_id = ANY (v_ids)
    GROUP BY o.so_number, l.position, l.id
  ) g;
  v_vat := CASE WHEN v_vat_on THEN v_vat ELSE 0 END;

  SELECT l.description, sum(i.quantity) AS quantity, l.unit_price INTO v_first
  FROM public.delivery_note_items i JOIN public.sales_order_lines l ON l.id = i.sales_order_line_id JOIN public.sales_orders o ON o.id = l.sales_order_id
  WHERE i.delivery_note_id = ANY (v_ids) GROUP BY o.so_number, l.position, l.id ORDER BY o.so_number, l.position, l.id LIMIT 1;
  SELECT o.quote_ref, o.customer_po INTO v_so
  FROM public.sales_orders o WHERE o.id = (SELECT d.sales_order_id FROM public.delivery_notes d WHERE d.id = ANY (v_ids) ORDER BY d.dn_number LIMIT 1);
  SELECT count(DISTINCT d.job_id) INTO v_jobs FROM public.delivery_notes d WHERE d.id = ANY (v_ids) AND d.job_id IS NOT NULL;

  v_invoice := public.create_with_lines(
    'invoices',
    jsonb_strip_nulls(jsonb_build_object(
      'customer', v_cust, 'description', v_first.description, 'quantity', v_first.quantity, 'unit_price', v_first.unit_price,
      'subtotal', v_net, 'carriage', 0, 'vat', v_vat, 'total', v_net + v_vat, 'vat_enabled', v_vat_on, 'carriage_vat', v_vat_on,
      'invoice_date', p_invoice_date, 'due_date', p_due_date, 'terms', nullif(btrim(p_terms), ''),
      'quote_ref', CASE WHEN v_orders = 1 THEN v_so.quote_ref END, 'customer_po', CASE WHEN v_orders = 1 THEN v_so.customer_po END,
      'job_id', CASE WHEN v_jobs = 1 THEN (SELECT d.job_id FROM public.delivery_notes d WHERE d.id = ANY (v_ids) AND d.job_id IS NOT NULL LIMIT 1) END,
      'status', 'draft', 'amount_paid', 0)),
    'invoice_line_items', 'invoice_id', v_lines);

  FOR v_dn IN SELECT unnest(v_ids) AS id LOOP
    PERFORM set_config('quoteflow.delivery_note_invoice', v_dn.id::TEXT, TRUE);
    UPDATE public.delivery_notes SET invoice_id = v_invoice WHERE id = v_dn.id;
  END LOOP;
  PERFORM set_config('quoteflow.delivery_note_invoice', '', TRUE);
  RETURN jsonb_build_object('invoice_id', v_invoice, 'subtotal', v_net, 'vat', v_vat, 'total', v_net + v_vat, 'lines', jsonb_array_length(v_lines));
END
$$;
REVOKE ALL ON FUNCTION public.invoice_from_delivery_notes_draft(UUID, UUID[], DATE, DATE, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 081's job_finish_draft_invoice, verbatim (supabase/migrations/081_job_flow_release.sql section 9).
CREATE OR REPLACE FUNCTION public.job_finish_draft_invoice(p_job UUID, p_org UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job     RECORD;
  v_order   UUID;
  v_so      RECORD;
  v_vat_on  BOOLEAN;
  v_lines   JSONB;
  v_net     NUMERIC;
  v_vat     NUMERIC;
  v_first   RECORD;
  v_terms   TEXT;
  v_days    INT;
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_invoice UUID;
  v_state   TEXT;
  v_msg     TEXT;
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM public.current_user_organization_id() THEN
    RETURN 'not_authorised';
  END IF;
  BEGIN
    SELECT j.id, j.job_no, j.is_internal, j.converted_from_sales_order_id INTO v_job FROM public.jobs j WHERE j.id = p_job AND j.organization_id = p_org;
    IF NOT FOUND THEN
      RETURN 'not_found';
    END IF;
    IF v_job.is_internal THEN
      RETURN 'internal-job';
    END IF;
    v_order := v_job.converted_from_sales_order_id;
    IF v_order IS NULL THEN
      SELECT s.id INTO v_order FROM public.sales_orders s WHERE s.converted_to_job_id = p_job AND s.organization_id = p_org ORDER BY s.created_at, s.id LIMIT 1;
    END IF;
    IF v_order IS NULL THEN
      RETURN 'no-order';
    END IF;
    -- One draft per job: the same key as invoices_one_draft_per_job, so two at once wait for each other.
    PERFORM pg_advisory_xact_lock(hashtextextended('job-invoice:' || p_job::TEXT, 0));
    IF EXISTS (SELECT 1 FROM public.invoices i WHERE i.job_id = p_job AND i.organization_id = p_org
                 AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')) THEN
      RETURN 'invoiced';
    END IF;
    -- The order's lines (made when first needed, 034; lines already there are used as they are).
    IF NOT EXISTS (SELECT 1 FROM public.sales_order_lines l WHERE l.sales_order_id = v_order AND l.organization_id = p_org) THEN
      PERFORM public.ensure_sales_order_lines(v_order);
    END IF;
    SELECT s.id, s.customer, s.quote_ref, s.customer_po, s.vat_enabled INTO v_so FROM public.sales_orders s WHERE s.id = v_order AND s.organization_id = p_org;
    v_vat_on := coalesce(v_so.vat_enabled, FALSE) AND public.org_vat_registered(p_org);
    SELECT jsonb_agg(jsonb_build_object('position', g.n - 1, 'description', g.description, 'quantity', g.quantity, 'unit_price', g.unit_price,
                                        'vat_pct', g.vat_pct, 'vat_exempt', g.vat_exempt) ORDER BY g.n),
           coalesce(sum(round(g.quantity * g.unit_price, 2)), 0),
           coalesce(sum(CASE WHEN g.vat_exempt THEN 0 ELSE round(round(g.quantity * g.unit_price, 2) * g.vat_pct / 100, 2) END), 0)
      INTO v_lines, v_net, v_vat
    FROM (SELECT row_number() OVER (ORDER BY l.position, l.id) AS n, l.description, l.quantity, l.unit_price, l.vat_pct, l.vat_exempt
          FROM public.sales_order_lines l WHERE l.sales_order_id = v_order AND l.organization_id = p_org AND l.quantity > 0) g;
    IF v_lines IS NULL THEN
      RETURN 'no-lines';
    END IF;
    v_vat := CASE WHEN v_vat_on THEN v_vat ELSE 0 END;
    SELECT l.description, l.quantity, l.unit_price INTO v_first
    FROM public.sales_order_lines l WHERE l.sales_order_id = v_order AND l.organization_id = p_org AND l.quantity > 0 ORDER BY l.position, l.id LIMIT 1;

    SELECT coalesce(nullif(btrim(s.company_profile ->> 'defaultInvoiceTerms'), ''), '30 days') INTO v_terms
    FROM public.organization_settings s WHERE s.organization_id = p_org;
    v_terms := left(coalesce(v_terms, '30 days'), 200);
    v_days := CASE WHEN v_terms ~* 'receipt' THEN 0 ELSE coalesce(least(substring(v_terms FROM '(\d{1,4})')::INT, 366), 30) END;

    v_invoice := public.create_with_lines(
      'invoices',
      jsonb_strip_nulls(jsonb_build_object(
        'customer', v_so.customer, 'description', v_first.description, 'quantity', v_first.quantity, 'unit_price', v_first.unit_price,
        'subtotal', v_net, 'carriage', 0, 'vat', v_vat, 'total', v_net + v_vat, 'vat_enabled', v_vat_on, 'carriage_vat', v_vat_on,
        'invoice_date', v_today, 'due_date', v_today + v_days, 'terms', v_terms,
        'quote_ref', v_so.quote_ref, 'customer_po', v_so.customer_po, 'job_id', p_job, 'status', 'draft', 'amount_paid', 0)),
      'invoice_line_items', 'invoice_id', v_lines);
    PERFORM security_audit.log_named_event(p_org, 'JOB_DRAFT_INVOICE', 'jobs', p_job::TEXT,
      jsonb_build_object('job_no', v_job.job_no, 'outcome', 'drafted', 'invoice_id', v_invoice, 'sales_order_id', v_order));
    RETURN 'drafted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM security_audit.log_named_event(p_org, 'JOB_DRAFT_INVOICE', 'jobs', p_job::TEXT,
      jsonb_build_object('outcome', 'failed', 'error_code', v_state, 'error_message', left(coalesce(nullif(v_msg, ''), 'unknown error'), 500)));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '081: the draft invoice for job % failed (%: %) and the failure could not be recorded', p_job, v_state, v_msg;
  END;
  RETURN 'failed';
END
$$;
REVOKE ALL ON FUNCTION public.job_finish_draft_invoice(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- 081's delivery_note_try_draft, verbatim (supabase/migrations/081_job_flow_release.sql section 17).
CREATE OR REPLACE FUNCTION public.delivery_note_try_draft(p_note UUID, p_org UUID, p_cause TEXT)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_note   RECORD;
  v_block  TEXT;
  v_terms  TEXT;
  v_days   INT;
  v_today  DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_made   JSONB;
  v_state  TEXT;
  v_msg    TEXT;
  v_job_inv UUID;
BEGIN
  BEGIN
    -- The note's row lock: already held by the note's own update, which called this.
    SELECT d.id, d.status, d.invoice_id, d.invoice_ref, i.status AS invoice_status INTO v_note
    FROM public.delivery_notes d LEFT JOIN public.invoices i ON i.id = d.invoice_id
    WHERE d.id = p_note AND d.organization_id = p_org
    FOR UPDATE OF d;
    IF NOT FOUND THEN
      RETURN 'not_found';
    END IF;
    IF v_note.status NOT IN ('despatched', 'delivered', 'signed') THEN
      RETURN 'not_sent';
    END IF;
    -- Idempotent: a note on a live invoice (a draft included) is left alone.
    IF v_note.invoice_id IS NOT NULL AND lower(coalesce(v_note.invoice_status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled') THEN
      RETURN 'invoiced';
    END IF;
    -- A hand-typed invoice reference (a hand-made note, or an import from the old system) means it was invoiced elsewhere.
    IF v_note.invoice_id IS NULL AND nullif(btrim(v_note.invoice_ref), '') IS NOT NULL THEN
      RETURN 'invoice_ref';
    END IF;
    -- 081: the note's job already has its invoice (the draft made when the job was finished, or any live invoice made for the job):
    -- the note goes on that one, so one job never gets a second draft. A draft first, then the oldest.
    SELECT i.id INTO v_job_inv
    FROM public.delivery_notes d JOIN public.invoices i ON i.job_id = d.job_id AND i.organization_id = d.organization_id
    WHERE d.id = p_note AND d.job_id IS NOT NULL AND lower(coalesce(i.status, 'draft')) NOT IN ('void', 'voided', 'cancelled', 'canceled')
    ORDER BY (lower(coalesce(i.status, 'draft')) = 'draft') DESC, i.created_at, i.id
    LIMIT 1;
    IF v_job_inv IS NOT NULL THEN
      PERFORM set_config('quoteflow.delivery_note_invoice', p_note::TEXT, TRUE);
      UPDATE public.delivery_notes SET invoice_id = v_job_inv WHERE id = p_note;
      PERFORM set_config('quoteflow.delivery_note_invoice', '', TRUE);
      PERFORM security_audit.log_named_event(p_org, 'LINK_JOB_INVOICE', 'delivery_notes', p_note::TEXT,
        jsonb_build_object('invoice_id', v_job_inv, 'cause', p_cause));
      RETURN 'linked';
    END IF;
    v_block := public.delivery_note_draft_block(p_note);
    IF v_block IS NOT NULL THEN
      RETURN v_block;
    END IF;

    SELECT coalesce(nullif(btrim(s.company_profile ->> 'defaultInvoiceTerms'), ''), '30 days') INTO v_terms
    FROM public.organization_settings s WHERE s.organization_id = p_org;
    v_terms := left(coalesce(v_terms, '30 days'), 200);
    -- As the invoices page reads terms: "on receipt" is due today, else the first number in it is days, else 30.
    v_days := CASE WHEN v_terms ~* 'receipt' THEN 0 ELSE coalesce(least(substring(v_terms FROM '(\d{1,4})')::INT, 366), 30) END;

    v_made := public.invoice_from_delivery_notes_draft(p_org, ARRAY[p_note], v_today, v_today + v_days, v_terms);
    INSERT INTO public.invoice_queue_events (organization_id, delivery_note_id, invoice_id, cause, outcome, created_by)
    VALUES (p_org, p_note, (v_made ->> 'invoice_id')::UUID, p_cause, 'drafted', auth.uid());
    RETURN 'drafted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  -- Everything of the attempt is undone; what went wrong is kept, and the caller's change goes on.
  BEGIN
    INSERT INTO public.invoice_queue_events (organization_id, delivery_note_id, cause, outcome, error_code, error_message, created_by)
    VALUES (p_org, p_note, p_cause, 'failed', v_state, left(coalesce(nullif(v_msg, ''), 'unknown error'), 500), auth.uid());
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '059: the draft invoice for delivery note % failed (%: %) and the failure could not be recorded', p_note, v_state, v_msg;
  END;
  RETURN 'failed';
END
$$;
REVOKE ALL ON FUNCTION public.delivery_note_try_draft(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- 073's replace_draft_invoice, verbatim (supabase/migrations/073_invoice_screen.sql section 1).
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

-- What 099 added.
DROP TRIGGER IF EXISTS invoice_lines_within_despatched ON public.invoice_line_items;
DROP TRIGGER IF EXISTS invoice_lines_link_kept ON public.invoice_line_items;
DROP TRIGGER IF EXISTS zz_same_org_sales_order_line_id ON public.invoice_line_items;
DROP FUNCTION IF EXISTS public.draft_invoice_balances(UUID);
DROP FUNCTION IF EXISTS public.invoice_add_delivery_note(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.invoice_lines_within_despatched();
DROP FUNCTION IF EXISTS public.invoice_lines_link_kept();
DROP FUNCTION IF EXISTS public.order_lines_lock(UUID[]);
DROP FUNCTION IF EXISTS public.order_line_billing(UUID, UUID);
DROP TABLE IF EXISTS public.invoice_job_finish_legacy;
DROP INDEX IF EXISTS public.idx_invoice_line_items_order_line;
ALTER TABLE public.invoice_line_items DROP COLUMN IF EXISTS sales_order_line_id;

DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)')) IS DISTINCT FROM 'cff9113a2490bda9b901764974adfa0a'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)')) IS DISTINCT FROM '492fa39d76311ecfc78ce860a5f1160b'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)')) IS DISTINCT FROM '52a9771fec832f0e20e9d780e7561caa'
     OR (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)')) IS DISTINCT FROM 'bc56dd3aa75000c36f959955b71026ca' THEN
    RAISE EXCEPTION '099 rollback: a function is not its predecessor''s afterwards';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoice_line_items' AND column_name = 'sales_order_line_id')
     OR to_regclass('public.invoice_job_finish_legacy') IS NOT NULL OR to_regprocedure('public.order_line_billing(uuid,uuid)') IS NOT NULL
     OR to_regprocedure('public.draft_invoice_balances(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '099 rollback: something 099 added is still there';
  END IF;
  IF has_function_privilege('authenticated', to_regprocedure('public.job_finish_draft_invoice(uuid,uuid)'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('public.delivery_note_try_draft(uuid,uuid,text)'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('public.invoice_from_delivery_notes_draft(uuid,uuid[],date,date,text)'), 'EXECUTE')
     OR NOT has_function_privilege('authenticated', to_regprocedure('public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)'), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure('public.replace_draft_invoice(uuid,timestamp with time zone,jsonb,jsonb)'), 'EXECUTE') THEN
    RAISE EXCEPTION '099 rollback: grants are not as before';
  END IF;
END
$$;
COMMIT;

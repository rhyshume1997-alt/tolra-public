-- =====================================================================================================
-- 059: a delivery note sent out makes a DRAFT invoice; nothing sent out falls through uninvoiced.
--
-- Rhys's decisions (15 Oct 2026): when a delivery note is marked sent out (its status becomes despatched, delivered or signed from a
-- status before that) a DRAFT invoice is made for it automatically. Drafts are never issued automatically: a person issues them
-- (issue_invoice, 027, unchanged, numbers them). Internal jobs (042) are never invoiced. A failure to draft never blocks the despatch.
-- Every sent-out note that is not on a live invoice is listed, with the reason.
--
-- 1. invoice_from_delivery_notes_draft (internal, no API role): the body of 034's create_invoice_from_delivery_notes, unchanged in what
--    it makes (one draft at the order's prices and VAT, job_id when the notes share one job, invoice_ref NULL while a draft, the notes'
--    invoice_id set, the notes locked FOR UPDATE in id order), for a company named by the caller, which must be the session's company.
--    Two changes: the "one customer" rule compares the customers' names ignoring case and repeated spaces (so "ACME  Ltd" and "Acme Ltd"
--    can go on one invoice), and a note whose job is internal is refused by name before 042's guard would refuse the invoice.
-- 2. create_invoice_from_delivery_notes (same signature, same result, same checks: second step, admin or office, one to fifty notes,
--    dates) is now SECURITY DEFINER and calls (1). It now also checks the invoices section is not hidden for the caller, which the
--    invoices table's restrictive policy checked for it while it ran as the caller. A note whose invoice is void or cancelled may be
--    invoiced again, as before (034); a note on a live invoice (draft, issued, part paid, paid) still can't.
-- 3. delivery_note_draft_block (internal, STABLE): why a sent-out note can't be drafted automatically: 'internal-job', 'manual-items'
--    (no order, no items, or an item not made from an order line: prices unknown, invoice it by hand) or 'customer-mismatch' (the note's
--    customer is not its order's customer, ignoring case and spaces); NULL when it can.
-- 4. delivery_note_try_draft (internal): under the note's row lock, if the note is sent out, on no live invoice, has no hand-typed
--    invoice reference and is not blocked by (3), drafts it alone through (1) with the company's default invoice terms (the company
--    profile's defaultInvoiceTerms, "30 days" when unset; its days give the due date) dated today in UK time. The whole attempt is in its
--    own exception block: on ANY error it is undone and a 'failed' row is written to invoice_queue_events (with the error), and the caller's
--    change commits. A draft made writes a 'drafted' row (the invoice and note: the "Auto-drafted from DLN-x" badge).
-- 5. The trigger that calls (4), only for a change made by a signed-in person (the API's 'authenticated' role; a service-role or
--    maintenance change drafts nothing and the note is listed as 'not-drafted'):
--    * delivery_notes_auto_invoice: AFTER UPDATE OF status on delivery_notes, when the status moves INTO despatched/delivered/signed from
--      a status before them. The note's row is already locked by the update; 037's delivery_notes_link_guard has already locked the job
--      row (BEFORE), so no new lock order is introduced. Two updates at once: the second waits for the first's row lock, then sees the note
--      already sent (no transition) and makes nothing. Sending or updating again makes nothing (no transition; the note is on a live draft).
--    Voiding or cancelling an invoice drafts nothing: as in 034, its notes are freed for a person to invoice again from the picker (alone
--    or with other notes, once whatever made them void the first one is put right). Such a note is listed by (6) as 'not-drafted' with
--    the void invoice's number, so it does not fall through. (An earlier draft of 059 re-drafted on void with a trigger
--    invoices_void_redraft; it is dropped here if present.)
-- 6. uninvoiced_delivery_notes() (SECURITY DEFINER, STABLE, admin and office of the caller's company, invoices section not hidden):
--    every sent-out note of the company on no live invoice and with no hand-typed invoice reference, with reason: 'internal-job'
--    (excluded, listed so nothing is silently dropped), 'manual-items', 'customer-mismatch', 'queued-failed' (its last automatic attempt
--    failed; the error is given) or 'not-drafted' (sent out before 059 or by a service or import, its draft deleted, or its invoice
--    voided or cancelled). `invoiceable` says whether the manual "Invoice from delivery notes" can take it.
-- 7. invoice_queue_events: the automatic attempts (drafted / failed), the caller's company only, admin and office, invoices section;
--    no write grant (written by (4) only).
--
-- The previous app build keeps working with 059 applied: its Mark Sent Out is the same plain update (now also drafting), its picker reads
-- the table (notes on a void invoice are still missing from it, as before 059) and calls create_invoice_from_delivery_notes with the
-- same arguments and result; a note already auto-drafted is refused there as "already on a draft invoice", as any invoiced note is.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- ---- 7. The record of automatic attempts --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_queue_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id),
  delivery_note_id UUID NOT NULL REFERENCES public.delivery_notes(id) ON DELETE CASCADE,
  invoice_id       UUID REFERENCES public.invoices(id) ON DELETE SET NULL,
  -- What made the attempt: the note going out (the only automatic cause; a void invoice drafts nothing).
  cause            TEXT NOT NULL CHECK (cause IN ('sent_out')),
  outcome          TEXT NOT NULL CHECK (outcome IN ('drafted', 'failed')),
  error_code       TEXT,
  error_message    TEXT,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_queue_events_shape CHECK ((outcome = 'failed') = (error_message IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_invoice_queue_events_note ON public.invoice_queue_events (delivery_note_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_queue_events_org ON public.invoice_queue_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoice_queue_events_invoice ON public.invoice_queue_events (invoice_id) WHERE invoice_id IS NOT NULL;

ALTER TABLE public.invoice_queue_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_queue_events rbac select" ON public.invoice_queue_events;
CREATE POLICY "invoice_queue_events rbac select" ON public.invoice_queue_events FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin', 'office']));
DROP POLICY IF EXISTS "invoice_queue_events section access" ON public.invoice_queue_events;
CREATE POLICY "invoice_queue_events section access" ON public.invoice_queue_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.section_allowed('invoices'))) WITH CHECK ((SELECT public.section_allowed('invoices')));
REVOKE ALL ON public.invoice_queue_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invoice_queue_events TO authenticated;

DROP TRIGGER IF EXISTS zz_same_org_delivery_note_id ON public.invoice_queue_events;
CREATE TRIGGER zz_same_org_delivery_note_id BEFORE INSERT OR UPDATE ON public.invoice_queue_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('delivery_notes', 'delivery_note_id');
DROP TRIGGER IF EXISTS zz_same_org_invoice_id ON public.invoice_queue_events;
CREATE TRIGGER zz_same_org_invoice_id BEFORE INSERT OR UPDATE ON public.invoice_queue_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_same_org_parent('invoices', 'invoice_id');
DROP TRIGGER IF EXISTS audit_invoice_queue_events_changes ON public.invoice_queue_events;
CREATE TRIGGER audit_invoice_queue_events_changes AFTER INSERT OR UPDATE OR DELETE ON public.invoice_queue_events
  FOR EACH ROW EXECUTE FUNCTION security_audit.log_row_change();
DROP TRIGGER IF EXISTS support_read_only ON public.invoice_queue_events;
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_queue_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.support_readonly_guard();

-- -----------------------------------------------------------------------------------------------------
-- ---- 1. The draft itself (internal) -------------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------------------------------
-- ---- 3. Why a sent-out note can't be drafted automatically (internal) ----------------------------------------------
-- Created after (1) in this file but only called at run time, so the order of the two doesn't matter.
CREATE OR REPLACE FUNCTION public.delivery_note_draft_block(p_note UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    -- The note's job (or, on a hand-made note, the job number typed on it) is internal: never invoiced.
    WHEN EXISTS (SELECT 1 FROM public.jobs j
                 WHERE j.organization_id = d.organization_id AND j.is_internal
                   AND (j.id = d.job_id OR (d.job_id IS NULL AND nullif(btrim(d.job_ref), '') IS NOT NULL AND j.job_no = btrim(d.job_ref))))
      THEN 'internal-job'
    -- No order, no items, or an item not made from an order line: the prices aren't known.
    WHEN d.sales_order_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.delivery_note_items i WHERE i.delivery_note_id = d.id)
      OR EXISTS (SELECT 1 FROM public.delivery_note_items i WHERE i.delivery_note_id = d.id AND i.sales_order_line_id IS NULL)
      THEN 'manual-items'
    -- The note's customer is not its order's customer (ignoring case and repeated spaces): a person decides who is billed.
    WHEN EXISTS (SELECT 1 FROM public.sales_orders o WHERE o.id = d.sales_order_id
                   AND lower(regexp_replace(btrim(coalesce(o.customer, '')), '\s+', ' ', 'g'))
                       <> lower(regexp_replace(btrim(coalesce(d.customer, '')), '\s+', ' ', 'g')))
      THEN 'customer-mismatch'
  END
  FROM public.delivery_notes d WHERE d.id = p_note
$$;
REVOKE ALL ON FUNCTION public.delivery_note_draft_block(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- ---- 2. The manual path: same signature, same result, same checks -------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_invoice_from_delivery_notes(p_notes UUID[], p_invoice_date DATE, p_due_date DATE, p_terms TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN public.invoice_from_delivery_notes_draft(v_org, p_notes, p_invoice_date, p_due_date, p_terms);
END
$$;
REVOKE ALL ON FUNCTION public.create_invoice_from_delivery_notes(UUID[], DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_delivery_notes(UUID[], DATE, DATE, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- 4. One automatic attempt (internal) --------------------------------------------------------------------------
-- Returns what happened: 'drafted', 'failed', or why nothing was tried ('not_found', 'not_sent', 'invoiced', 'invoice_ref', or a block
-- from delivery_note_draft_block). Never raises: everything it does is undone on an error, which is recorded instead.
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

-- -----------------------------------------------------------------------------------------------------
-- ---- 5. The trigger -------------------------------------------------------------------------------------------------
-- A signed-in person's change only (PostgREST's SET ROLE authenticated, which a SECURITY DEFINER function doesn't change).
CREATE OR REPLACE FUNCTION public.delivery_note_auto_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) <> 'authenticated' OR auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.delivery_note_try_draft(NEW.id, NEW.organization_id, 'sent_out');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '059: no draft invoice for delivery note %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.delivery_note_auto_invoice() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS delivery_notes_auto_invoice ON public.delivery_notes;
CREATE TRIGGER delivery_notes_auto_invoice AFTER UPDATE OF status ON public.delivery_notes
  FOR EACH ROW
  WHEN (NEW.status IN ('despatched', 'delivered', 'signed') AND coalesce(OLD.status, '') NOT IN ('despatched', 'delivered', 'signed'))
  EXECUTE FUNCTION public.delivery_note_auto_invoice();

-- A void invoice drafts nothing (034: its notes are freed for a person to invoice again). An earlier draft's re-draft trigger goes.
DROP TRIGGER IF EXISTS invoices_void_redraft ON public.invoices;
DROP FUNCTION IF EXISTS public.invoice_void_redraft();

-- -----------------------------------------------------------------------------------------------------
-- ---- 6. Sent out, not invoiced ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.uninvoiced_delivery_notes()
RETURNS TABLE (
  delivery_note_id UUID, dn_number TEXT, customer TEXT, status TEXT, sent_at TIMESTAMPTZ, delivery_date DATE,
  sales_order_id UUID, job_id UUID, job_no TEXT, reason TEXT, detail TEXT, invoiceable BOOLEAN, voided_invoice_ref TEXT, failed_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_org UUID := public.current_user_organization_id();
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT n.id, n.dn_number, n.customer, n.status, n.despatched_at, n.delivery_date, n.sales_order_id, n.job_id,
         coalesce(j.job_no, nullif(btrim(n.job_ref), '')),
         r.reason,
         CASE r.reason
           WHEN 'internal-job' THEN 'Internal job: never invoiced (listed so it is not missed).'
           WHEN 'manual-items' THEN 'Not made from an order, so the prices aren''t known: invoice it by hand.'
           WHEN 'customer-mismatch' THEN 'The note''s customer is not the order''s customer (' || coalesce(o.customer, 'none') || '): check who to bill, then invoice it from the delivery notes.'
           WHEN 'queued-failed' THEN 'The automatic draft failed: ' || e.error_message
           ELSE CASE WHEN n.invoice_id IS NOT NULL THEN 'Its invoice was voided: invoice it again from the delivery notes.'
                     ELSE 'No draft was made for it (sent out before automatic drafts, by an import, or its draft was deleted): invoice it from the delivery notes.' END
         END,
         r.reason NOT IN ('internal-job', 'manual-items'),
         CASE WHEN n.invoice_id IS NOT NULL THEN n.inv_ref END,
         CASE WHEN r.reason = 'queued-failed' THEN e.created_at END
  FROM (
    SELECT d.*, i.invoice_ref AS inv_ref
    FROM public.delivery_notes d LEFT JOIN public.invoices i ON i.id = d.invoice_id
    WHERE d.organization_id = v_org
      AND d.status IN ('despatched', 'delivered', 'signed')
      AND (d.invoice_id IS NULL OR lower(coalesce(i.status, 'draft')) IN ('void', 'voided', 'cancelled', 'canceled'))
      AND NOT (d.invoice_id IS NULL AND nullif(btrim(d.invoice_ref), '') IS NOT NULL)
  ) n
  LEFT JOIN public.jobs j ON j.id = n.job_id AND j.organization_id = v_org
  LEFT JOIN public.sales_orders o ON o.id = n.sales_order_id AND o.organization_id = v_org
  LEFT JOIN LATERAL (
    SELECT q.outcome, q.error_message, q.created_at FROM public.invoice_queue_events q
    WHERE q.delivery_note_id = n.id AND q.organization_id = v_org ORDER BY q.created_at DESC, q.id DESC LIMIT 1
  ) e ON TRUE
  CROSS JOIN LATERAL (
    SELECT coalesce(public.delivery_note_draft_block(n.id), CASE WHEN e.outcome = 'failed' THEN 'queued-failed' END, 'not-drafted') AS reason
  ) r
  ORDER BY coalesce(n.despatched_at, n.delivery_date::TIMESTAMPTZ, n.created_at) DESC, n.dn_number;
END
$$;
REVOKE ALL ON FUNCTION public.uninvoiced_delivery_notes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.uninvoiced_delivery_notes() TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- ---- The second step (033) on the function this migration replaces ------------------------------------------------
DO $do$
BEGIN
  IF to_regprocedure('public.create_invoice_from_delivery_notes(uuid[],date,date,text)') IS NULL
     OR position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure('public.create_invoice_from_delivery_notes(uuid[],date,date,text)'))) = 0 THEN
    RAISE EXCEPTION '059: create_invoice_from_delivery_notes does not start with the second-step check';
  END IF;
END
$do$;

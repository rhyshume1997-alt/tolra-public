-- =====================================================================================================
-- 032: part payments on invoices (GitHub issue #5).
--
-- Until now an issued invoice could only be marked paid in full (status 'paid', amount_paid = total, paid_at). Payments are
-- now rows of their own: public.invoice_payments keeps each receipt (date, amount, method, reference, who recorded it)
-- and invoices.amount_paid is always their sum. Rows are append-only: a mistaken payment is reversed by a second,
-- negative row that points at it (with the reason), never edited or deleted.
-- Writes happen only through two SECURITY DEFINER functions: admin and office record, only admin reverses:
--   * record_invoice_payment(invoice, amount, paid_on, method, reference, request_id): the request id is made by the
--     screen once per dialog, so a repeated submit (double click, retry) returns the payment already made and adds nothing;
--     amounts with more than two decimal places are refused, never rounded; locks the invoice row, refuses unless the
--     invoice is issued and open, refuses a zero, negative or over-the-balance amount, then inserts the payment and sets
--     amount_paid, status ('partial' while a balance remains, 'paid' when it clears, paid_at = the date of the payment that
--     clears it) and writes a RECORD_PAYMENT entry to the audit trail, all in one transaction.
--   * reverse_invoice_payment(payment, reason): the same, for a reason-carrying negative row, once per payment, REVERSE_PAYMENT.
--   * confirm_invoice_payments(invoice, note), admin: the explicit step that clears payment_unverified (recording a payment never does), CONFIRM_PAYMENTS.
-- The issued-invoice lock (019, 027) no longer lets the API change amount_paid, paid_at, or move an invoice into or out of
-- 'paid' / 'partial' directly, nor clear payment_unverified: those change only inside the functions (which say so to the
-- lock for the one invoice they hold). Recording a payment leaves payment_unverified alone; an admin clears it with
-- confirm_invoice_payments (audited CONFIRM_PAYMENTS). Every other column stays locked after issue exactly as before.
-- Existing data is never guessed: an invoice that already has amount_paid > 0 and is not payment_unverified gets ONE
-- 'legacy' row for exactly that amount (dated from paid_at when it has one). Imported invoices flagged payment_unverified
-- (027) get no row and keep behaving as before. Afterwards amount_paid = sum(payments) for every invoice that is not flagged
-- (supabase/verify/invoice_payments_032.sql checks it).
-- Also: the issuer snapshot (019) now records the company's invoice message (company_profile.defaultInvoiceMessage), so an
-- invoice issued from now on keeps its own wording; snapshots without it (issued before) keep printing as they did.
-- And a fix the payment history needs: security_audit.activity_changes (013) failed with "cannot call jsonb_object_keys on an
-- array" when a column went from NULL to an object (the issuer snapshot a new invoice gets when it is created), which made
-- record_activity fail for every such invoice. It now treats a JSON null as nothing, as it does a missing key.
-- Forward only, safe to run more than once.
-- =====================================================================================================

CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id          UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  -- Positive for a payment, negative for the reversal of one. Never zero.
  amount              NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
  -- Empty only on a legacy row whose invoice had no paid_at.
  paid_on             DATE,
  method              TEXT CHECK (method IS NULL OR method IN ('BACS', 'cheque', 'card', 'cash', 'other')),
  reference           TEXT CHECK (reference IS NULL OR length(reference) <= 100),
  -- 'recorded' by someone in the app; 'legacy' carried over from invoices.amount_paid by this migration.
  source              TEXT NOT NULL DEFAULT 'recorded' CHECK (source IN ('recorded', 'legacy')),
  reverses_payment_id UUID REFERENCES public.invoice_payments(id),
  void_reason         TEXT CHECK (void_reason IS NULL OR (length(btrim(void_reason)) > 0 AND length(void_reason) <= 500)),
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Made by the screen for one attempt to record a payment; a repeat with the same id is the same payment.
  request_id          UUID,
  CHECK (source = 'legacy' OR paid_on IS NOT NULL),
  -- A reversal is negative and carries its reason; a payment is positive and carries none.
  CHECK ((reverses_payment_id IS NULL AND void_reason IS NULL AND amount > 0)
      OR (reverses_payment_id IS NOT NULL AND void_reason IS NOT NULL AND amount < 0)),
  -- A payment is reversed at most once.
  UNIQUE (reverses_payment_id),
  UNIQUE (organization_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON public.invoice_payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_org_paid_on ON public.invoice_payments (organization_id, paid_on);

-- Same company, same people who can see invoices (admin) and not when the invoices page is hidden for them (012). No
-- insert, update or delete grant and no policy for them: rows are written by the functions below only.
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_payments rbac select" ON public.invoice_payments;
CREATE POLICY "invoice_payments rbac select" ON public.invoice_payments FOR SELECT TO authenticated
  USING (organization_id = public.current_user_organization_id() AND public.has_org_role(ARRAY['admin']));
DROP POLICY IF EXISTS "invoice_payments section access" ON public.invoice_payments;
CREATE POLICY "invoice_payments section access" ON public.invoice_payments AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.section_allowed('invoices'))) WITH CHECK ((SELECT public.section_allowed('invoices')));
REVOKE ALL ON public.invoice_payments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invoice_payments TO authenticated;

-- -----------------------------------------------------------------------------------------------------

-- Existing receipts: ONE 'legacy' row per invoice that already has amount_paid > 0 and is not flagged payment_unverified,
-- for exactly that amount and dated from paid_at (empty when it has none). Nothing is inferred: an invoice marked paid with
-- amount_paid = 0 gets no row, and a flagged one keeps its unknown payment. Skips an invoice that already has any row.
INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, source)
SELECT i.organization_id, i.id, i.amount_paid, i.paid_at::DATE, 'legacy'
FROM public.invoices i
WHERE i.amount_paid > 0 AND NOT i.payment_unverified
  AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id);

-- -----------------------------------------------------------------------------------------------------

-- Records one payment against an issued invoice and returns { payment_id, amount_paid, balance_due, status }. Organisation
-- and actor come from the session (admin or office). A second call with the same request id returns the first payment's
-- result without recording anything (the screen sends one id per dialog opening). The invoice row is locked first, so two payments recorded at once are checked one after
-- the other and can never add up to more than the invoice total. Nothing is changed when any check fails.
CREATE OR REPLACE FUNCTION public.record_invoice_payment(p_invoice UUID, p_amount NUMERIC, p_paid_on DATE, p_method TEXT, p_reference TEXT, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_inv     RECORD;
  v_status  TEXT;
  v_label   TEXT;
  v_ref     TEXT := nullif(btrim(p_reference), '');
  v_method  TEXT := nullif(btrim(p_method), '');
  v_sum     NUMERIC(12,2);
  v_balance NUMERIC(12,2);
  v_new_sum NUMERIC(12,2);
  v_new_status TEXT;
  v_paid_at TIMESTAMPTZ;
  v_payment UUID;
  v_email   TEXT;
  v_prior   RECORD;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'A request id is required.' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'The payment must be more than zero.' USING ERRCODE = '22023';
  END IF;
  IF p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'The payment can have at most two decimal places (pence); it is not rounded.' USING ERRCODE = '22023';
  END IF;
  IF p_paid_on IS NULL THEN
    RAISE EXCEPTION 'The date the payment was received is required.' USING ERRCODE = '22023';
  END IF;
  IF p_paid_on > v_today THEN
    RAISE EXCEPTION 'The payment date can''t be in the future.' USING ERRCODE = '22023';
  END IF;
  IF v_method IS NOT NULL AND v_method NOT IN ('BACS', 'cheque', 'card', 'cash', 'other') THEN
    RAISE EXCEPTION 'The payment method must be BACS, cheque, card, cash or other.' USING ERRCODE = '22023';
  END IF;
  IF length(v_ref) > 100 THEN
    RAISE EXCEPTION 'The payment reference can be at most 100 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT id, invoice_ref, status, total, amount_paid INTO v_inv
  FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  -- The same request again (with the invoice locked, so also when two arrive together): the first one stands.
  SELECT id, invoice_id INTO v_prior FROM public.invoice_payments WHERE organization_id = v_org AND request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.invoice_id <> p_invoice THEN
      RAISE EXCEPTION 'That request id was used for another invoice.' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(sum(amount), 0) INTO v_sum FROM public.invoice_payments WHERE invoice_id = p_invoice;
    RETURN jsonb_build_object('payment_id', v_prior.id, 'amount_paid', v_sum, 'balance_due', v_inv.total - v_sum,
                              'status', v_inv.status, 'repeated', TRUE);
  END IF;
  v_status := lower(coalesce(v_inv.status, 'draft'));
  v_label := coalesce(v_inv.invoice_ref, 'This invoice');
  IF v_status = 'draft' THEN
    RAISE EXCEPTION '% is still a draft: issue it before recording a payment.', v_label USING ERRCODE = '22023';
  END IF;
  IF v_status IN ('void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off') THEN
    RAISE EXCEPTION '% is % and can''t take a payment.', v_label, v_status USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_sum FROM public.invoice_payments WHERE invoice_id = p_invoice;
  IF v_sum IS DISTINCT FROM v_inv.amount_paid THEN
    RAISE EXCEPTION '% shows % paid but its payments add up to %: nothing was recorded. Ask for the payments to be checked.',
      v_label, chr(163) || to_char(v_inv.amount_paid, 'FM999999990.00'), chr(163) || to_char(v_sum, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;
  v_balance := v_inv.total - v_sum;
  IF v_balance <= 0 THEN
    RAISE EXCEPTION '% is already paid in full.', v_label USING ERRCODE = '22023';
  END IF;
  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'That is more than the balance due on % (% of %): nothing was recorded.',
      v_label, chr(163) || to_char(v_balance, 'FM999999990.00'), chr(163) || to_char(v_inv.total, 'FM999999990.00') USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, reference, source, created_by, request_id)
  VALUES (v_org, p_invoice, p_amount, p_paid_on, v_method, v_ref, 'recorded', v_user, p_request_id)
  RETURNING id INTO v_payment;

  v_new_sum := v_sum + p_amount;
  v_new_status := CASE WHEN v_new_sum >= v_inv.total THEN 'paid' ELSE 'partial' END;
  -- The date that clears the invoice, held at midday UTC so it reads as the same day in any UK time zone.
  v_paid_at := CASE WHEN v_new_status = 'paid' THEN (p_paid_on + TIME '12:00') AT TIME ZONE 'UTC' END;
  PERFORM set_config('quoteflow.invoice_payment', p_invoice::TEXT, TRUE);
  -- payment_unverified is left as it is: one receipt doesn't prove that earlier payments weren't made. An admin settles that
  -- with confirm_invoice_payments.
  UPDATE public.invoices SET amount_paid = v_new_sum, status = v_new_status, paid_at = v_paid_at
   WHERE id = p_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'RECORD_PAYMENT', 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'payment_id', v_payment, 'invoice_ref', v_inv.invoice_ref, 'amount', p_amount,
                             'paid_on', p_paid_on, 'method', v_method, 'reference', v_ref, 'balance_due', v_inv.total - v_new_sum,
                             'status', v_new_status));
  RETURN jsonb_build_object('payment_id', v_payment, 'amount_paid', v_new_sum, 'balance_due', v_inv.total - v_new_sum, 'status', v_new_status);
END
$$;
REVOKE ALL ON FUNCTION public.record_invoice_payment(UUID, NUMERIC, DATE, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment(UUID, NUMERIC, DATE, TEXT, TEXT, UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------

-- Reverses one recorded payment: adds a negative row that points at it, with the reason, and recalculates amount_paid and
-- the status (paid -> part paid or issued; paid_at is cleared once the invoice is no longer paid). Admin only. Each payment
-- can be reversed once, a reversal can't be reversed (record the payment again), and a 'legacy' row, which stands for an
-- amount recorded before part payments existed, is not reversed here. Returns { reversal_id, amount_paid, balance_due, status }.
CREATE OR REPLACE FUNCTION public.reverse_invoice_payment(p_payment UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_today   DATE := (now() AT TIME ZONE 'Europe/London')::DATE;
  v_reason  TEXT := nullif(btrim(p_reason), '');
  v_invoice UUID;
  v_pay     RECORD;
  v_inv     RECORD;
  v_label   TEXT;
  v_status  TEXT;
  v_new_sum NUMERIC(12,2);
  v_new_status TEXT;
  v_new_paid_at TIMESTAMPTZ;
  v_reversal UUID;
  v_email   TEXT;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reverse a payment.' USING ERRCODE = '22023';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'The reason can be at most 500 characters.' USING ERRCODE = '22023';
  END IF;
  -- Lock the invoice before reading the payment, as record_invoice_payment does, so the two never interleave.
  SELECT invoice_id INTO v_invoice FROM public.invoice_payments WHERE id = p_payment AND organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT id, invoice_ref, status, total, paid_at INTO v_inv FROM public.invoices WHERE id = v_invoice AND organization_id = v_org FOR UPDATE;
  SELECT id, amount, paid_on, method, reference, source, reverses_payment_id INTO v_pay FROM public.invoice_payments WHERE id = p_payment;
  v_label := coalesce(v_inv.invoice_ref, 'This invoice');
  IF v_pay.reverses_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'That is a reversal, which can''t itself be reversed. Record the payment again instead.' USING ERRCODE = '22023';
  END IF;
  IF v_pay.source = 'legacy' THEN
    RAISE EXCEPTION 'That payment was carried over from before part payments were recorded, so it can''t be reversed here.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoice_payments WHERE reverses_payment_id = p_payment) THEN
    RAISE EXCEPTION 'That payment has already been reversed.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, reference, source, reverses_payment_id, void_reason, created_by)
  VALUES (v_org, v_invoice, -v_pay.amount, v_today, v_pay.method, v_pay.reference, 'recorded', p_payment, v_reason, v_user)
  RETURNING id INTO v_reversal;

  SELECT coalesce(sum(amount), 0) INTO v_new_sum FROM public.invoice_payments WHERE invoice_id = v_invoice;
  v_status := lower(coalesce(v_inv.status, 'draft'));
  v_new_status := CASE
    WHEN v_status IN ('void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off') THEN v_inv.status -- the status isn't the payments' to change
    WHEN v_new_sum >= v_inv.total THEN 'paid'
    WHEN v_new_sum > 0 THEN 'partial'
    ELSE 'issued' END;
  v_new_paid_at := CASE WHEN v_new_status = 'paid' THEN v_inv.paid_at END;
  PERFORM set_config('quoteflow.invoice_payment', v_invoice::TEXT, TRUE);
  UPDATE public.invoices SET amount_paid = v_new_sum, status = v_new_status, paid_at = v_new_paid_at WHERE id = v_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'REVERSE_PAYMENT', 'invoices', v_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'payment_id', p_payment, 'reversal_id', v_reversal, 'invoice_ref', v_inv.invoice_ref,
                             'amount', v_pay.amount, 'paid_on', v_pay.paid_on, 'method', v_pay.method, 'reference', v_pay.reference,
                             'reason', v_reason, 'balance_due', v_inv.total - v_new_sum, 'status', v_new_status));
  RETURN jsonb_build_object('reversal_id', v_reversal, 'amount_paid', v_new_sum, 'balance_due', v_inv.total - v_new_sum, 'status', v_new_status);
END
$$;
REVOKE ALL ON FUNCTION public.reverse_invoice_payment(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_invoice_payment(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------

-- An imported invoice flagged payment_unverified (027) stays unknown whatever is recorded on it: a receipt doesn't prove
-- the earlier ones. This is the explicit step that clears the flag: an admin confirms, with a note, that the payments recorded
-- on the invoice (none, or whatever is listed) are all there are. From then on it counts as owed for its balance. Audited
-- as CONFIRM_PAYMENTS. Returns { amount_paid, balance_due, status }.
CREATE OR REPLACE FUNCTION public.confirm_invoice_payments(p_invoice UUID, p_note TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org   UUID := public.current_user_organization_id();
  v_user  UUID := auth.uid();
  v_note  TEXT := nullif(btrim(p_note), '');
  v_inv   RECORD;
  v_email TEXT;
BEGIN
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF v_note IS NULL OR length(v_note) > 500 THEN
    RAISE EXCEPTION 'A note of up to 500 characters is required to confirm the payments.' USING ERRCODE = '22023';
  END IF;
  SELECT id, invoice_ref, status, total, amount_paid, payment_unverified INTO v_inv
  FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_inv.payment_unverified THEN
    RAISE EXCEPTION '% has no payment waiting to be confirmed.', coalesce(v_inv.invoice_ref, 'This invoice') USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('quoteflow.invoice_payment', p_invoice::TEXT, TRUE);
  UPDATE public.invoices SET payment_unverified = FALSE WHERE id = p_invoice;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);
  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'CONFIRM_PAYMENTS', 'invoices', p_invoice::TEXT,
          jsonb_build_object('source', 'write_audit', 'invoice_ref', v_inv.invoice_ref, 'amount_paid', v_inv.amount_paid,
                             'balance_due', v_inv.total - v_inv.amount_paid, 'note', v_note));
  RETURN jsonb_build_object('amount_paid', v_inv.amount_paid, 'balance_due', v_inv.total - v_inv.amount_paid, 'status', v_inv.status);
END
$$;
REVOKE ALL ON FUNCTION public.confirm_invoice_payments(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_invoice_payments(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------

-- Issued invoices: amounts, customer and details are fixed (019, 027). The receipts (amount_paid, paid_at) and the move into
-- or out of 'paid' / 'partial' now change only inside record_invoice_payment / reverse_invoice_payment, which set the
-- transaction-local setting quoteflow.invoice_payment to the invoice's id for their one UPDATE. The rest of what was open
-- stays open: other status changes, the send record, the job link and the payment verification flag.
CREATE OR REPLACE FUNCTION public.invoice_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_date', 'job_id', 'payment_unverified', 'updated_at', 'updated_by'];
  v_receipts CONSTANT TEXT[] := ARRAY['amount_paid', 'paid_at'];
  v_via_payment BOOLEAN;
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
  v_via_payment := current_setting('quoteflow.invoice_payment', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT;
  IF NOT v_via_payment THEN
    IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.paid_at IS DISTINCT FROM OLD.paid_at THEN
      RAISE EXCEPTION 'Invoice %: payments are recorded with Record payment, not by editing the amount paid.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF OLD.payment_unverified AND NOT NEW.payment_unverified THEN
      RAISE EXCEPTION 'Invoice %: payments are confirmed with Confirm payments complete, not by editing the flag.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND (lower(coalesce(NEW.status, '')) IN ('paid', 'partial') OR lower(coalesce(OLD.status, '')) IN ('paid', 'partial')) THEN
      RAISE EXCEPTION 'Invoice %: it becomes part paid or paid only when a payment is recorded.', OLD.invoice_ref USING ERRCODE = '42501';
    END IF;
  END IF;
  IF (to_jsonb(NEW) - v_open - v_receipts) IS DISTINCT FROM (to_jsonb(OLD) - v_open - v_receipts) THEN
    RAISE EXCEPTION 'Invoice % has been issued: its amounts, customer and details can''t be changed (only payment and status).', OLD.invoice_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------------------------------

-- Snapshot of the issuing company (019, 021), now with the invoice message (an empty list when none is set, so a snapshot
-- taken from now on always says so; one taken earlier has no such key and keeps its old wording).
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
      'defaultCustomerMessage', s.company_profile -> 'defaultCustomerMessage',
      'defaultInvoiceMessage', coalesce(s.company_profile -> 'defaultInvoiceMessage', '[]'::JSONB),
      'capturedAt', to_jsonb(now())))
  FROM public.organization_settings s WHERE s.organization_id = p_org
$$;

-- -----------------------------------------------------------------------------------------------------

-- { field: { "from": v, "to": v } } for scalar fields, { "added", "removed" } for arrays, { "changed", "keys" } for objects
-- (013), except that a JSON null counts as no value: an object or array replacing one (NULL -> issuer snapshot) no longer
-- raises, and the history of such an invoice can be read.
CREATE OR REPLACE FUNCTION security_audit.activity_changes(p_old JSONB, p_new JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_object_agg(k, CASE
           WHEN jsonb_typeof(p_new -> k) = 'array' OR jsonb_typeof(p_old -> k) = 'array' THEN jsonb_build_object(
             'added',   coalesce((SELECT jsonb_agg(security_audit.activity_value(e)) FROM jsonb_array_elements(coalesce(nullif(p_new -> k, 'null'::JSONB), '[]')) e
                                  WHERE NOT coalesce(nullif(p_old -> k, 'null'::JSONB), '[]') @> jsonb_build_array(e)), '[]'),
             'removed', coalesce((SELECT jsonb_agg(security_audit.activity_value(e)) FROM jsonb_array_elements(coalesce(nullif(p_old -> k, 'null'::JSONB), '[]')) e
                                  WHERE NOT coalesce(nullif(p_new -> k, 'null'::JSONB), '[]') @> jsonb_build_array(e)), '[]'))
           WHEN jsonb_typeof(p_new -> k) = 'object' OR jsonb_typeof(p_old -> k) = 'object' THEN jsonb_build_object(
             'changed', TRUE,
             'keys', coalesce((SELECT jsonb_agg(kk) FROM (
                        SELECT kk FROM jsonb_object_keys(coalesce(nullif(p_new -> k, 'null'::JSONB), '{}') || coalesce(nullif(p_old -> k, 'null'::JSONB), '{}')) kk
                        WHERE (p_new -> k -> kk) IS DISTINCT FROM (p_old -> k -> kk) LIMIT 20) x), '[]'))
           ELSE jsonb_build_object('from', security_audit.activity_value(p_old -> k), 'to', security_audit.activity_value(p_new -> k))
         END), '{}'::JSONB)
  FROM (
    SELECT k FROM jsonb_object_keys(coalesce(p_new, '{}') || coalesce(p_old, '{}')) k
    WHERE k NOT IN ('id', 'organization_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'position')
      AND (p_new -> k) IS DISTINCT FROM (p_old -> k)
  ) keys
$$;


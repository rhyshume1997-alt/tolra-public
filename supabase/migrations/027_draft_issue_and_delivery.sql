-- =====================================================================================================
-- 027: invoices and purchase orders start as drafts and are issued explicitly; sending is recorded separately;
--      nothing leaves draft unless its lines add up to its stored totals (independent review of 0604bf4).
--
-- Invoices
--   * A draft has no number yet (invoice_ref may be empty only while it is a draft). public.issue_invoice() gives it
--     the next INV number, records who issued it and to whom, and sets status 'issued', in one transaction. Drafts
--     never use up a number, so issued numbers have no gaps. Issuing twice returns the same number.
--   * 'issued' invoices are collectible (lib/receivables: everything but paid/draft/void/... is owed), whether or not
--     they have been e-mailed. Confirming that the e-mail went sets sent_date only (already open after issue, 019).
-- Purchase orders
--   * New status 'issued'; sent_at records the confirmed send. Once issued, supplier, items, value and VAT are fixed
--     for app users (delivery date, notes, receipt and status stay open); issued orders can't be deleted.
-- Imported invoices whose payment wasn't recorded
--   * invoices.payment_unverified: the legacy export has no payment amounts, only a status. An imported invoice that
--     isn't marked paid is NOT assumed unpaid: it is flagged until someone records the payment or confirms it is still
--     owed. Flagged invoices are left out of money owed, aging and chasers (lib/receivables). No receipt is invented.
--     On the first run only, invoices already imported (public.legacy_import_map) and not paid/closed are flagged.
-- Quotes and invoices
--   * Leaving draft (issue, send, accept) runs public.check_document_totals (021): an imported or edited draft whose
--     lines don't add up to its stored total can't be issued until corrected.
-- Existing issued records keep their numbers, statuses and amounts; nothing is rewritten. The SQL editor / import
-- (database owner) is exempt from the app-user locks, as before. Forward only, safe to run more than once.
-- =====================================================================================================

-- ----- invoices: drafts without a number ------------------------------------------------------------------
ALTER TABLE public.invoices ALTER COLUMN invoice_ref DROP NOT NULL;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_issued_have_number;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_issued_have_number
  CHECK (coalesce(status, 'draft') = 'draft' OR invoice_ref IS NOT NULL);

CREATE OR REPLACE FUNCTION public.issue_invoice(p_invoice UUID)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID := public.current_user_organization_id();
  v_inv RECORD;
  v_ref TEXT;
BEGIN
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin']) THEN
    RAISE EXCEPTION 'Only admins can issue invoices' USING ERRCODE = '42501';
  END IF;
  SELECT id, status, invoice_ref, customer INTO v_inv
  FROM public.invoices WHERE id = p_invoice AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  IF coalesce(v_inv.status, 'draft') <> 'draft' THEN
    RETURN v_inv.invoice_ref; -- already issued: same number, nothing changes
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_line_items WHERE invoice_id = p_invoice) THEN
    RAISE EXCEPTION 'Add at least one line item before issuing' USING ERRCODE = '22023';
  END IF;
  PERFORM public.check_document_totals('invoices', p_invoice, v_org);
  v_ref := public.next_doc_number('INV');
  UPDATE public.invoices
     SET status = 'issued', invoice_ref = v_ref,
         issuer_snapshot = public.issuer_snapshot(v_org), customer_snapshot = public.customer_snapshot(v_org, v_inv.customer)
   WHERE id = p_invoice;
  RETURN v_ref;
END
$$;
REVOKE ALL ON FUNCTION public.issue_invoice(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_invoice(UUID) TO authenticated;

-- ----- leaving draft requires matching totals (quotes and invoices) ----------------------------------------
CREATE OR REPLACE FUNCTION public.issue_requires_matching_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.is_api_role() AND coalesce(OLD.status, 'draft') = 'draft' AND coalesce(NEW.status, 'draft') <> 'draft' THEN
    PERFORM public.check_document_totals(TG_TABLE_NAME, NEW.id, NEW.organization_id);
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS quotes_issue_requires_matching_totals ON public.quotes;
CREATE TRIGGER quotes_issue_requires_matching_totals AFTER UPDATE OF status ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.issue_requires_matching_totals();
DROP TRIGGER IF EXISTS invoices_issue_requires_matching_totals ON public.invoices;
CREATE TRIGGER invoices_issue_requires_matching_totals AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.issue_requires_matching_totals();

-- ----- purchase orders: issued status, send confirmation, issue lock --------------------------------------
ALTER TABLE public.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
ALTER TABLE public.purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status = ANY (ARRAY['draft', 'issued', 'sent', 'confirmed', 'partial_received', 'received', 'cancelled']));
ALTER TABLE public.purchase_orders ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.purchase_order_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Still open after issue: progress (status, sent/received times), the supplier's delivery date and notes.
  v_open CONSTANT TEXT[] := ARRAY['status', 'sent_at', 'received_at', 'expected_delivery', 'notes', 'updated_at', 'updated_by'];
BEGIN
  IF NOT public.is_api_role() OR coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Purchase order % has been issued, so it can''t be deleted.', OLD.po_ref USING ERRCODE = '42501';
  END IF;
  IF coalesce(NEW.status, 'draft') = 'draft' THEN
    RAISE EXCEPTION 'Purchase order % has been issued, so it can''t go back to draft.', OLD.po_ref USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - v_open) IS DISTINCT FROM (to_jsonb(OLD) - v_open) THEN
    RAISE EXCEPTION 'Purchase order % has been issued: its supplier, items and value can''t be changed (delivery date, notes and progress can).', OLD.po_ref
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS purchase_order_issue_lock ON public.purchase_orders;
CREATE TRIGGER purchase_order_issue_lock BEFORE UPDATE OR DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.purchase_order_issue_lock();

-- ----- imported invoices: payment not verified ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'payment_unverified') THEN
    ALTER TABLE public.invoices ADD COLUMN payment_unverified BOOLEAN NOT NULL DEFAULT FALSE;
    -- First run only, so a later re-run never re-flags an invoice someone has already checked.
    IF to_regclass('public.legacy_import_map') IS NOT NULL THEN
      UPDATE public.invoices i SET payment_unverified = TRUE
      FROM public.legacy_import_map m
      WHERE m.source = 'invoices' AND m.new_id = i.id
        AND lower(coalesce(i.status, 'draft')) NOT IN ('paid', 'draft', 'void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off')
        AND coalesce(i.amount_paid, 0) = 0;
    END IF;
  END IF;
END
$$;

-- The flag (and receipts) stay changeable after issue; everything else stays fixed (019).
CREATE OR REPLACE FUNCTION public.invoice_issue_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Fields that may still change after issue: receipts, lifecycle, the send record and payment verification.
  v_open CONSTANT TEXT[] := ARRAY['status', 'amount_paid', 'paid_at', 'sent_date', 'job_id', 'payment_unverified', 'updated_at', 'updated_by'];
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


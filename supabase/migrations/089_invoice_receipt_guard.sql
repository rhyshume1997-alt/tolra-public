-- =====================================================================================================
-- 089: an invoice's receipts (amount paid, paid date, credits, refunds, the unverified flag and the paid / part paid / credited status)
-- change only through the payment and credit steps, on a draft as on an issued invoice; and a draft is issued only when what it shows as
-- paid or credited is what its recorded payments and credits add up to. Security review (Astra, HIGH; proved real locally Thu 22 Oct).
-- Applies after 085 and 084 (in either order); independent of 086, 087 and 088. Needs only 000 / 027 / 032 / 034 / 076 (invoices, its
-- receipt columns, invoice_payments, invoice_credit_allocations, customer_credit_ledger).
--
-- WHY. 076's invoice_issue_lock (027's lock, last replaced by 076) refuses a signed-in change of amount_paid, paid_at, credited_amount or
-- refunded_amount, a cleared payment_unverified and a move into or out of paid / partial / credited, but only once the invoice is issued:
-- for a draft it returns at once. 033's documents_start_as_drafts refuses amount_paid and paid_at on a new invoice, not credited_amount,
-- refunded_amount or payment_unverified. "invoices rbac update" lets admin and office update every column, and 034's issue_invoice
-- issues whatever the draft holds. So an office user could PATCH a draft's amount_paid and paid_at (or credited_amount) through the API
-- and then issue it: the issued invoice showed as paid with no payment recorded, Record payment refused it ("shows £120.00 paid but its
-- payments add up to £0.00") and Void refused it (it "has payments"). The same PATCH could also move a draft straight to paid with a
-- number of the user's choosing.
--
-- WHAT CHANGES. One BEFORE INSERT OR UPDATE OF status, amount_paid, paid_at, credited_amount, refunded_amount, payment_unverified
-- trigger on public.invoices (zz_invoice_receipts, function public.invoice_receipts_guard(), SECURITY DEFINER so the issue check reads
-- every payment and credit row whatever RLS shows the caller; not callable from the API). For a signed-in session (anon,
-- authenticated, also inside their SECURITY DEFINER calls):
--   a. a NEW invoice (INSERT) is refused unless credited_amount and refunded_amount are 0 and payment_unverified is false (033 already
--      refuses amount_paid, paid_at and any status but draft; its message still comes first);
--   b. an UPDATE that changes amount_paid, paid_at, credited_amount, refunded_amount or payment_unverified, or moves status into or out
--      of paid / partial / credited, is refused (42501, hint invoice_receipts_direct) whatever the invoice's status, unless it is the
--      payment / credit step's own write (the transaction-local quoteflow.invoice_payment names this invoice, as 076's lock accepts);
--   c. moving an invoice from draft to issued (issue_invoice, or any other write that does it) is refused (22023, hint
--      invoice_receipts_mismatch) unless amount_paid equals its recorded payments, credited_amount its credit-note allocations plus the
--      customer credit moved onto it, refunded_amount the credit refunded or moved from it, and paid_at is empty unless those settle it.
--      A draft takes no payment or credit (every step refuses one), so a draft is issued with 0, 0, 0 and no paid date. This also stops
--      a draft that was already changed before 089 from being issued with its amounts.
-- The same values written again are not a change and pass. For an issued invoice, b repeats 076's refusals; 076's lock runs first, so
-- its messages are unchanged (b adds only the unverified flag being SET by hand: only the import, the owner and the service role set it).
-- UNCHANGED PATHS: record_invoice_payment, reverse_invoice_payment, confirm_invoice_payments (032 / 034 / 035), allocate_credit_note,
-- apply_customer_credit, refund_customer_credit (034): each sets quoteflow.invoice_payment around its own write; void_invoice (073:
-- status issued / sent to void only); issue_invoice (034: number, status issued and snapshots; check c is the only addition);
-- replace_draft_invoice and the draft makers (job finish, delivery notes: amount_paid 0); the data import (076 / 079 / 085: INSERTs while
-- quoteflow.data_import names the company; its undo deletes) and import_legacy_tenant (database owner). The database owner and the
-- service role are exempt, as 082's and 088's guards are (maintenance, the SQL editor, the server's own jobs).
-- No policy, grant, column, existing function or row is changed. GUARD (section 1): the function, if present, must be 089's (md5 with
-- every whitespace character removed). Safe to run again.
-- Rollback: supabase/release/089_invoice_receipt_guard.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 089 builds on is there, and its own function, if present, is 089's.
DO $$
BEGIN
  IF to_regclass('public.invoices') IS NULL OR to_regclass('public.invoice_payments') IS NULL
     OR to_regclass('public.invoice_credit_allocations') IS NULL OR to_regclass('public.customer_credit_ledger') IS NULL THEN
    RAISE EXCEPTION '089: invoices (000), invoice_payments (032), invoice_credit_allocations or customer_credit_ledger (034) is missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices'
        AND column_name IN ('status', 'amount_paid', 'paid_at', 'credited_amount', 'refunded_amount', 'payment_unverified', 'total')) <> 7 THEN
    RAISE EXCEPTION '089: an invoice receipt column (000, 027, 034) is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.invoice_receipts_guard()')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> '18851e08d5d58c3bb648bb13e0fe0e22') THEN
    RAISE EXCEPTION '089: public.invoice_receipts_guard() already exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The check. SECURITY DEFINER so the issue check (c) sums every payment and credit row of the invoice whatever the caller's RLS shows;
-- it reads only rows of this invoice. Not callable from the API (a trigger function).
CREATE OR REPLACE FUNCTION public.invoice_receipts_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_label TEXT;
  v_paid  NUMERIC(12,2);
  v_cred  NUMERIC(12,2);
  v_refd  NUMERIC(12,2);
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF current_setting('quoteflow.data_import', TRUE) = NEW.organization_id::TEXT THEN
      RETURN NEW;
    END IF;
    IF coalesce(NEW.amount_paid, 0) <> 0 OR NEW.paid_at IS NOT NULL OR coalesce(NEW.credited_amount, 0) <> 0
       OR coalesce(NEW.refunded_amount, 0) <> 0 OR coalesce(NEW.payment_unverified, FALSE) THEN
      RAISE EXCEPTION 'A new invoice starts with nothing paid or credited: payments are recorded with Record payment and credits applied with Apply credit, once it is issued.'
        USING ERRCODE = '42501', HINT = 'invoice_receipts_direct';
    END IF;
    RETURN NEW;
  END IF;
  IF current_setting('quoteflow.invoice_payment', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT THEN
    RETURN NEW;
  END IF;
  v_label := coalesce(OLD.invoice_ref, 'This draft');
  IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
     OR NEW.credited_amount IS DISTINCT FROM OLD.credited_amount OR NEW.refunded_amount IS DISTINCT FROM OLD.refunded_amount
     OR NEW.payment_unverified IS DISTINCT FROM OLD.payment_unverified
     OR (NEW.status IS DISTINCT FROM OLD.status
         AND (lower(coalesce(NEW.status, '')) IN ('paid', 'partial', 'credited') OR lower(coalesce(OLD.status, '')) IN ('paid', 'partial', 'credited'))) THEN
    RAISE EXCEPTION '%: what is paid or credited changes only when a payment is recorded (Record payment) or a credit applied (Apply credit), not by editing it.', v_label
      USING ERRCODE = '42501', HINT = 'invoice_receipts_direct';
  END IF;
  IF coalesce(OLD.status, 'draft') = 'draft' AND coalesce(NEW.status, 'draft') <> 'draft' THEN
    SELECT coalesce(sum(p.amount), 0) INTO v_paid FROM public.invoice_payments p WHERE p.invoice_id = OLD.id;
    SELECT coalesce((SELECT sum(a.amount) FROM public.invoice_credit_allocations a WHERE a.invoice_id = OLD.id), 0)
         + coalesce((SELECT sum(l.amount) FROM public.customer_credit_ledger l WHERE l.to_invoice_id = OLD.id), 0) INTO v_cred;
    SELECT coalesce(sum(l.amount), 0) INTO v_refd FROM public.customer_credit_ledger l WHERE l.invoice_id = OLD.id;
    IF NEW.amount_paid IS DISTINCT FROM v_paid OR NEW.credited_amount IS DISTINCT FROM v_cred OR NEW.refunded_amount IS DISTINCT FROM v_refd
       OR (NEW.paid_at IS NOT NULL AND v_paid + v_cred - v_refd < NEW.total) THEN
      RAISE EXCEPTION 'This draft shows % paid and % credited, but its recorded payments and credits come to % and %: it was not issued. Ask for the invoice to be checked.',
        chr(163) || to_char(coalesce(NEW.amount_paid, 0), 'FM999999990.00'), chr(163) || to_char(coalesce(NEW.credited_amount, 0) - coalesce(NEW.refunded_amount, 0), 'FM999999990.00'),
        chr(163) || to_char(v_paid, 'FM999999990.00'), chr(163) || to_char(v_cred - v_refd, 'FM999999990.00')
        USING ERRCODE = '22023', HINT = 'invoice_receipts_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2b. Internal only, and the trigger. Named zz_ so it runs after 076's invoice_issue_lock (an issued invoice's refusals keep their
-- messages) and after 033's invoices_start_as_drafts on an INSERT (likewise).
REVOKE ALL ON FUNCTION public.invoice_receipts_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_invoice_receipts ON public.invoices;
CREATE TRIGGER zz_invoice_receipts BEFORE INSERT OR UPDATE OF status, amount_paid, paid_at, credited_amount, refunded_amount, payment_unverified ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoice_receipts_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check before COMMIT: the body is 089's, not callable from the API, and the trigger is on invoices.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.invoice_receipts_guard()')) IS DISTINCT FROM '18851e08d5d58c3bb648bb13e0fe0e22'
     OR NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public'] FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.invoice_receipts_guard()')) THEN
    RAISE EXCEPTION '089: invoice_receipts_guard is not 089''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.invoice_receipts_guard()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.invoice_receipts_guard()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '089: invoice_receipts_guard is callable from the API';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'zz_invoice_receipts' AND t.tgrelid = 'public.invoices'::regclass
                   AND t.tgfoid = 'public.invoice_receipts_guard()'::regprocedure AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '089: the invoice receipts trigger is missing';
  END IF;
END
$$;

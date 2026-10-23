-- 091_invoice_issue_guard.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 091: a draft invoice is issued only by issue_invoice (its next INV number, snapshots, the issue stamp), never by editing its status or
-- number (Rhys's API audit, Thu 22 Oct: "draft to issued PATCH bypass (follow-up)"; 089 pack case 4c, proved real locally). Applies
-- after 089 (and 085 / 084); independent of 086, 087 and 088. Needs only 000 / 027 / 034 (invoices, invoice_ref, issued_at / issued_by
-- and 034's issue_invoice).
--
-- WHY. "invoices rbac update" lets admin and office update every column of a draft, and invoice_ref, status, issued_at and issued_by are
-- all column-granted to authenticated. 027's invoices_issued_have_number only asks that a non-draft has SOME number, and 076's
-- invoice_issue_lock returns at once for a draft. So an office user could PATCH a draft to status 'issued' (or 'sent' / 'written_off';
-- 'paid' / 'partial' / 'credited' since 089 only with 0 receipts refused) with an invoice_ref of their own choosing in ONE request,
-- bypassing issue_invoice: no next_doc_number (a number out of sequence, a gap or a duplicate of a future one), no issuer or customer
-- snapshot of the moment of issue. The same could be done in two steps (set the draft's invoice_ref, then its status).
--
-- WHAT CHANGES. For a signed-in session (anon, authenticated, also inside their SECURITY DEFINER calls), on an invoice that is a draft
-- (coalesce(status, 'draft') = 'draft'):
--   a. a change of invoice_ref, issued_at or issued_by is refused;
--   b. a move to any other status while it carries a number (the one the same PATCH sets, or one it already had) is refused;
-- (42501, hint invoice_issue_direct) unless it is issue_invoice's own write: 091 replaces 034's issue_invoice with the same body plus the
-- transaction-local quoteflow.invoice_issue naming the invoice around its UPDATE (it runs as the caller, SECURITY INVOKER, so the role
-- test alone can't tell it apart; the pattern is 032's quoteflow.invoice_payment and 073's quoteflow.invoice_void). A move with no number
-- is still refused by 027's invoices_issued_have_number (23514, unchanged); a move to void / cancelled by 073's void guard first (its
-- message unchanged); to paid / partial / credited by 089 first (its message unchanged: zz_invoice_receipts sorts before this trigger).
-- One BEFORE UPDATE OF status, invoice_ref, issued_at, issued_by trigger (zz_invoice_via_issue, function public.invoice_issue_guard(),
-- SECURITY INVOKER: it reads no table; not callable from the API). An INSERT is not checked here: 033's documents_start_as_drafts
-- already refuses a new invoice with a status other than draft or a number, except the data import's (076 / 079 / 085).
-- UNCHANGED PATHS: issue_invoice (034's body, plus the setting); void_invoice (073: issued / sent to void only; a draft is refused);
-- replace_draft_invoice and create_with_lines (021 / 073: no number or issue stamp; create_with_lines's own status write is to 'draft',
-- or refused by the number check as before); the despatch and job draft makers (034 / 059 / 081: drafts with no number, through
-- create_with_lines' engine or their own INSERT); the payment and credit steps (032 / 034 / 035: never on a draft); the data import
-- (INSERTs; its undo deletes); credit notes (085 / 078: credit_notes rows and the payment steps on issued invoices). The database owner
-- and the service role are exempt, as 082's, 088's and 089's guards are. No policy, grant, column or row is changed; 076's lock and
-- 089's guard keep their bodies. GUARD (section 1): issue_invoice must be 034's or 091's, and 091's function, if present, 091's (md5
-- with every whitespace character removed). Safe to run again.
-- Rollback: supabase/release/091_invoice_issue_guard.rollback.sql (only with Rhys's approval; puts 034's issue_invoice back).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 091 builds on is there, issue_invoice is 034's (or already 091's), and 091's own function, if present, is 091's.
DO $$
BEGIN
  IF to_regclass('public.invoices') IS NULL OR to_regprocedure('public.issue_invoice(uuid)') IS NULL THEN
    RAISE EXCEPTION '091: invoices (000) or issue_invoice (027 / 034) is missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices'
        AND column_name IN ('status', 'invoice_ref', 'issued_at', 'issued_by')) <> 4 THEN
    RAISE EXCEPTION '091: an invoice issue column (000, 027, 035) is missing';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.issue_invoice(uuid)'))
       NOT IN ('54622e5030816649217b963fb7ab5419', 'ee9b9005e060379ce9dcc8e45a7afd42') THEN
    RAISE EXCEPTION '091: public.issue_invoice(uuid) is neither 034''s nor 091''s; stop and compare it first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.invoice_issue_guard()')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> 'a601d6b3464100729d4c9b5055d6633e') THEN
    RAISE EXCEPTION '091: public.invoice_issue_guard() already exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. Issuing a draft invoice: 034's issue_invoice exactly, plus quoteflow.invoice_issue naming the invoice around its one UPDATE, so the
-- check below knows the number, the status and the issue stamp are issue_invoice's own. Cleared straight after; transaction-local.
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
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) THEN
    RAISE EXCEPTION 'Only admin or office staff can issue invoices' USING ERRCODE = '42501';
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
  PERFORM set_config('quoteflow.invoice_issue', p_invoice::TEXT, TRUE);
  UPDATE public.invoices
     SET status = 'issued', invoice_ref = v_ref,
         issuer_snapshot = public.issuer_snapshot(v_org), customer_snapshot = public.customer_snapshot(v_org, v_inv.customer)
   WHERE id = p_invoice;
  PERFORM set_config('quoteflow.invoice_issue', '', TRUE);
  RETURN v_ref;
END
$$;
REVOKE ALL ON FUNCTION public.issue_invoice(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_invoice(UUID) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 2a. The check. SECURITY INVOKER: it reads no table, only the row being written and two settings. Not callable from the API.
CREATE OR REPLACE FUNCTION public.invoice_issue_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- An issued invoice: 076's invoice_issue_lock already fixes its number and its issue stamp.
  IF coalesce(OLD.status, 'draft') <> 'draft' THEN
    RETURN NEW;
  END IF;
  IF current_setting('quoteflow.invoice_issue', TRUE) IS NOT DISTINCT FROM OLD.id::TEXT THEN
    RETURN NEW;
  END IF;
  IF NEW.invoice_ref IS DISTINCT FROM OLD.invoice_ref OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR (coalesce(NEW.status, 'draft') <> 'draft' AND NEW.invoice_ref IS NOT NULL) THEN
    RAISE EXCEPTION '%: a draft invoice is issued with Issue invoice, which gives it the next number. Its number and status are not set by editing it.', coalesce(OLD.invoice_ref, 'This draft')
      USING ERRCODE = '42501', HINT = 'invoice_issue_direct';
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2b. Internal only, and the trigger. Named zz_invoice_via_issue so it runs after 073's void guard, the status allowlist and 089's
-- zz_invoice_receipts (their messages come first), and before zzz_actor_stamp (which stamps issued_at / issued_by on the issue).
REVOKE ALL ON FUNCTION public.invoice_issue_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_invoice_via_issue ON public.invoices;
CREATE TRIGGER zz_invoice_via_issue BEFORE UPDATE OF status, invoice_ref, issued_at, issued_by ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoice_issue_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. Self-check before COMMIT: both bodies are 091's, the check is not callable from the API, issue_invoice is still callable by
-- authenticated only, and the trigger is on invoices.
DO $$
BEGIN
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.invoice_issue_guard()')) IS DISTINCT FROM 'a601d6b3464100729d4c9b5055d6633e'
     OR (SELECT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.invoice_issue_guard()')) THEN
    RAISE EXCEPTION '091: invoice_issue_guard is not 091''s after the replace';
  END IF;
  IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.issue_invoice(uuid)')) IS DISTINCT FROM 'ee9b9005e060379ce9dcc8e45a7afd42'
     OR (SELECT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public'] FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.issue_invoice(uuid)')) THEN
    RAISE EXCEPTION '091: issue_invoice is not 091''s after the replace';
  END IF;
  IF has_function_privilege('anon', 'public.invoice_issue_guard()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.invoice_issue_guard()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.issue_invoice(uuid)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.issue_invoice(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '091: the check is callable from the API, or issue_invoice''s grants changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'zz_invoice_via_issue' AND t.tgrelid = 'public.invoices'::regclass
                   AND t.tgfoid = 'public.invoice_issue_guard()'::regprocedure AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '091: the invoice issue trigger is missing';
  END IF;
END
$$;

COMMIT;

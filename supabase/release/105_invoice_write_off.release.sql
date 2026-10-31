-- 105_invoice_write_off.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 105: an issued invoice is written off (and a write-off reversed) only through one server step that asks for a reason, checks there is
-- something left to write off and writes a named audit row; never by editing its status (S5 review finding S5-A1, Medium). Needs 073
-- (void_invoice, the status allowlist), 076 (invoice_issue_lock), 089 (zz_invoice_receipts) and 033 (assert_privileged_aal). Replaces
-- no existing object: two new functions, one new trigger and its function. Independent of 102 to 104.
--
-- WHY. "invoices rbac update" lets admin and office update an issued invoice's status (076's invoice_issue_lock keeps status open, so
-- payments, Send and Void can move it). So an office user could PATCH an issued or sent invoice to 'written_off', and back again, in one
-- API request: no reason, no check that anything was owed, and only the generic row-change audit. A written-off invoice is not owed
-- (lib/receivables.ts), takes no payment or credit (032 / 034) and can't be voided (073), so the PATCH silently removed a debt.
--
-- WHAT CHANGES.
--   a. invoices_write_off_guard (BEFORE UPDATE OF status on invoices, function public.invoices_write_off_guard(), SECURITY INVOKER, not
--      callable from the API). For the browser roles (anon, authenticated, also inside their SECURITY DEFINER calls; the database owner,
--      the importer and the service role are exempt as 073's, 089's and 091's guards are): a change of status INTO or OUT OF written off
--      on an issued invoice (a draft is left to 091's and 027's checks, which already refuse any move out of draft but issue_invoice's)
--      is refused (42501, hint invoice_write_off_direct) unless write_off_invoice or reverse_write_off is making it (transaction-local
--      quoteflow.invoice_write_off = that invoice's id, 073's quoteflow.invoice_void pattern). A status counts as written off when its
--      letters alone spell "writtenoff" (an older row may hold any spelling; a new value is exact, 073's allowlist). Named so it runs
--      after 073's allowlist and void guard and before 089's zz_invoice_receipts and 091's zz_invoice_via_issue.
--   b. write_off_invoice(p_invoice_id, p_reason) (SECURITY DEFINER, as void_invoice): the second step (033) first; admin or office of the
--      caller's company with the invoices section shown; the reason trimmed, 10 to 500 characters. The invoice is locked (FOR UPDATE,
--      the lock every payment and credit step takes first) and refused (22023, hint naming the rule) when it is a draft, void or
--      cancelled, already written off, has imported payments still to be confirmed, payments that don't add up to what it shows paid,
--      nothing left to pay (total - paid - (credited - refunded) <= 0), or a status other than exactly issued, sent or partial.
--      Another company's invoice reads as "not found". The status becomes written_off; amounts, lines and every other column are left
--      as they are. An audit row WRITE_OFF_INVOICE (reason, the status it had, its number, the balance written off) is written in the
--      same transaction.
--   c. reverse_write_off(p_invoice_id, p_reason): the same caller and reason rules; refused unless the status is exactly written_off.
--      The status goes back to what its figures say, as 034's reverse_invoice_payment decides it: paid / credited when nothing is left
--      to pay, partial when something was paid, otherwise sent when a send was recorded (sent_date), else issued. Audit row
--      REVERSE_WRITE_OFF (reason, the status it returns to, its number, the balance owed again).
--   Both set 089's / 076's quoteflow.invoice_payment for their one UPDATE as well, so a part-paid invoice can be written off and come
--   back to part paid (those guards refuse a direct move from or to partial); the UPDATE changes the status only.
--   Neither event is accepted from the app's write_audit (095's audit_event_allowed has no such action, so a made-up WRITE_OFF_INVOICE
--   row is refused, 42501): the functions write their own rows, as void_invoice and the payment steps do.
-- UNCHANGED: void_invoice, issue_invoice, the payment and credit steps, the data import (INSERTs, not checked by an UPDATE trigger),
-- every policy, grant, column and row. The Xero queue (084's integration_enqueue) is not told of a write-off, as before.
-- GUARD (section 1): what 105 builds on is there, and 105's functions, if present, are 105's (md5 with every whitespace character
-- removed). Safe to run again.
-- Rollback: supabase/release/105_invoice_write_off.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard: what 105 builds on is there, and 105's own functions, if present, are 105's.
DO $$
DECLARE
  v_fn  TEXT;
  v_md5 TEXT;
BEGIN
  IF to_regclass('public.invoices') IS NULL OR to_regclass('public.invoice_payments') IS NULL OR to_regclass('security_audit.audit_log') IS NULL THEN
    RAISE EXCEPTION '105: invoices (000), invoice_payments (032) or security_audit.audit_log is missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'invoices'
        AND column_name IN ('status', 'invoice_ref', 'total', 'amount_paid', 'credited_amount', 'refunded_amount', 'payment_unverified', 'sent_date')) <> 8 THEN
    RAISE EXCEPTION '105: an invoice column (000, 027, 032, 034) is missing';
  END IF;
  IF to_regprocedure('public.assert_privileged_aal()') IS NULL OR to_regprocedure('public.has_org_role(text[])') IS NULL
     OR to_regprocedure('public.section_allowed(text)') IS NULL OR to_regprocedure('public.current_user_organization_id()') IS NULL
     OR to_regprocedure('public.void_invoice(uuid,text)') IS NULL OR to_regprocedure('public.invoices_status_allowlist()') IS NULL THEN
    RAISE EXCEPTION '105: an access helper (007, 012, 033) or 073''s void_invoice / status allowlist is missing';
  END IF;
  FOR v_fn, v_md5 IN VALUES
    ('public.invoices_write_off_guard()', '6ec5e742ef64fe23121c8099c42d2200'),
    ('public.write_off_invoice(uuid,text)', 'c7449f4564711533d43a1aa252eddfdf'),
    ('public.reverse_write_off(uuid,text)', '4750ac042335694164b634edca559f23') LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn) AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) <> v_md5) THEN
      RAISE EXCEPTION '105: % already exists with another body; stop and compare it first', v_fn;
    END IF;
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The check (a). SECURITY INVOKER: it reads no table, only the row being written and one setting. Not callable from the API.
CREATE OR REPLACE FUNCTION public.invoices_write_off_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(nullif(current_setting('role', TRUE), 'none'), session_user::TEXT) NOT IN ('anon', 'authenticated')
     OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  -- A draft: 091's zz_invoice_via_issue (with a number) and 027's invoices_issued_have_number (without) already refuse any move out of
  -- draft that is not issue_invoice's, with their own messages.
  IF coalesce(OLD.status, 'draft') = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (lower(regexp_replace(coalesce(OLD.status, ''), '[^[:alpha:]]', '', 'g')) = 'writtenoff'
      OR lower(regexp_replace(coalesce(NEW.status, ''), '[^[:alpha:]]', '', 'g')) = 'writtenoff')
     AND current_setting('quoteflow.invoice_write_off', TRUE) IS DISTINCT FROM OLD.id::TEXT THEN
    RAISE EXCEPTION 'Invoice %: an invoice is written off with Write off (and brought back with Reverse write-off), which asks for a reason. Its status is not changed by editing it.', coalesce(OLD.invoice_ref, '')
      USING ERRCODE = '42501', HINT = 'invoice_write_off_direct';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.invoices_write_off_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_write_off_guard ON public.invoices;
CREATE TRIGGER invoices_write_off_guard BEFORE UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_write_off_guard();

-- -----------------------------------------------------------------------------------------------------
-- 3. write_off_invoice (b).
CREATE OR REPLACE FUNCTION public.write_off_invoice(p_invoice_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_reason  TEXT := btrim(coalesce(p_reason, ''));
  v_inv     RECORD;
  v_label   TEXT;
  v_status  TEXT;
  v_paid    NUMERIC;
  v_balance NUMERIC;
  v_email   TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 10 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give the reason the invoice is being written off (10 to 500 characters).' USING ERRCODE = '22023', HINT = 'write_off_reason_required';
  END IF;
  SELECT i.id, i.invoice_ref, i.status, i.total, i.amount_paid, i.credited_amount, i.refunded_amount, i.payment_unverified INTO v_inv
  FROM public.invoices i WHERE i.id = p_invoice_id AND i.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  v_label := coalesce(v_inv.invoice_ref, 'This invoice');
  v_status := coalesce(v_inv.status, 'draft'); -- exact: no trimming or case folding

  IF v_status = 'written_off' THEN
    RAISE EXCEPTION '% has already been written off.', v_label USING ERRCODE = '22023', HINT = 'invoice_already_written_off';
  END IF;
  IF v_status = 'draft' THEN
    RAISE EXCEPTION 'A draft invoice isn''t owed yet, so there is nothing to write off: delete the draft instead.' USING ERRCODE = '22023', HINT = 'invoice_draft';
  END IF;
  IF lower(regexp_replace(v_status, '[^[:alpha:]]', '', 'g')) IN ('void', 'voided', 'cancelled', 'canceled') THEN
    RAISE EXCEPTION '% is void, so there is nothing to write off.', v_label USING ERRCODE = '22023', HINT = 'invoice_void';
  END IF;
  IF coalesce(v_inv.payment_unverified, FALSE) THEN
    RAISE EXCEPTION '% has imported payments still to be confirmed, so it can''t be written off yet.', v_label USING ERRCODE = '22023', HINT = 'invoice_payments_unconfirmed';
  END IF;
  SELECT coalesce(sum(p.amount), 0) INTO v_paid FROM public.invoice_payments p WHERE p.invoice_id = p_invoice_id;
  IF v_paid IS DISTINCT FROM coalesce(v_inv.amount_paid, 0) THEN
    RAISE EXCEPTION '% shows a different amount paid from its payments, so it can''t be written off. Ask for the payments to be checked.', v_label
      USING ERRCODE = '22023', HINT = 'invoice_payments_mismatch';
  END IF;
  v_balance := coalesce(v_inv.total, 0) - v_paid - (coalesce(v_inv.credited_amount, 0) - coalesce(v_inv.refunded_amount, 0));
  IF v_balance <= 0 THEN
    RAISE EXCEPTION '% has nothing left to pay, so there is nothing to write off.', v_label USING ERRCODE = '22023', HINT = 'invoice_nothing_owed';
  END IF;
  -- Only an invoice still owed is written off: exactly 'issued', 'sent' or 'partial'. Anything else is refused, not guessed.
  IF v_status NOT IN ('issued', 'sent', 'partial') THEN
    RAISE EXCEPTION '% has the status "%", which can''t be written off here. Ask for the record to be checked.', v_label, v_inv.status
      USING ERRCODE = '22023', HINT = 'invoice_status_not_write_offable';
  END IF;

  PERFORM set_config('quoteflow.invoice_write_off', p_invoice_id::TEXT, TRUE);
  PERFORM set_config('quoteflow.invoice_payment', p_invoice_id::TEXT, TRUE);
  UPDATE public.invoices SET status = 'written_off' WHERE id = p_invoice_id;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);
  PERFORM set_config('quoteflow.invoice_write_off', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'WRITE_OFF_INVOICE', 'invoices', p_invoice_id::TEXT,
          jsonb_build_object('source', 'write_audit', 'invoice_ref', v_inv.invoice_ref, 'reason', v_reason, 'from_status', v_inv.status,
                             'balance_written_off', v_balance));
  RETURN jsonb_build_object('invoice_id', p_invoice_id, 'invoice_ref', v_inv.invoice_ref, 'status', 'written_off', 'balance_written_off', v_balance);
END
$$;
REVOKE ALL ON FUNCTION public.write_off_invoice(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.write_off_invoice(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. reverse_write_off (c).
CREATE OR REPLACE FUNCTION public.reverse_write_off(p_invoice_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, security_audit
AS $$
DECLARE
  v_org     UUID := public.current_user_organization_id();
  v_user    UUID := auth.uid();
  v_reason  TEXT := btrim(coalesce(p_reason, ''));
  v_inv     RECORD;
  v_label   TEXT;
  v_paid    NUMERIC;
  v_net     NUMERIC;
  v_to      TEXT;
  v_email   TEXT;
BEGIN
  PERFORM public.assert_privileged_aal();
  IF v_org IS NULL OR v_user IS NULL OR NOT public.has_org_role(ARRAY['admin', 'office']) OR NOT public.section_allowed('invoices') THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 10 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give the reason the write-off is being reversed (10 to 500 characters).' USING ERRCODE = '22023', HINT = 'write_off_reason_required';
  END IF;
  SELECT i.id, i.invoice_ref, i.status, i.total, i.amount_paid, i.credited_amount, i.refunded_amount, i.sent_date INTO v_inv
  FROM public.invoices i WHERE i.id = p_invoice_id AND i.organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
  END IF;
  v_label := coalesce(v_inv.invoice_ref, 'This invoice');
  IF v_inv.status IS DISTINCT FROM 'written_off' THEN
    RAISE EXCEPTION '% hasn''t been written off, so there is nothing to reverse.', v_label USING ERRCODE = '22023', HINT = 'invoice_not_written_off';
  END IF;

  -- Back to what its figures say (034's reverse_invoice_payment rule): nothing was paid or credited while it was written off.
  v_paid := coalesce(v_inv.amount_paid, 0);
  v_net := coalesce(v_inv.credited_amount, 0) - coalesce(v_inv.refunded_amount, 0);
  v_to := CASE
    WHEN v_paid + v_net >= coalesce(v_inv.total, 0) THEN CASE WHEN v_paid > 0 THEN 'paid' ELSE 'credited' END
    WHEN v_paid > 0 THEN 'partial'
    WHEN v_inv.sent_date IS NOT NULL THEN 'sent'
    ELSE 'issued' END;

  PERFORM set_config('quoteflow.invoice_write_off', p_invoice_id::TEXT, TRUE);
  PERFORM set_config('quoteflow.invoice_payment', p_invoice_id::TEXT, TRUE);
  UPDATE public.invoices SET status = v_to WHERE id = p_invoice_id;
  PERFORM set_config('quoteflow.invoice_payment', '', TRUE);
  PERFORM set_config('quoteflow.invoice_write_off', '', TRUE);

  SELECT p.email INTO v_email FROM public.user_profiles p WHERE p.id = v_user;
  INSERT INTO security_audit.audit_log (organization_id, actor_user_id, actor_email, action, entity_table, entity_id, metadata)
  VALUES (v_org, v_user, coalesce(nullif(auth.jwt() ->> 'email', ''), v_email), 'REVERSE_WRITE_OFF', 'invoices', p_invoice_id::TEXT,
          jsonb_build_object('source', 'write_audit', 'invoice_ref', v_inv.invoice_ref, 'reason', v_reason, 'to_status', v_to,
                             'balance_due', coalesce(v_inv.total, 0) - v_paid - v_net));
  RETURN jsonb_build_object('invoice_id', p_invoice_id, 'invoice_ref', v_inv.invoice_ref, 'status', v_to, 'balance_due', coalesce(v_inv.total, 0) - v_paid - v_net);
END
$$;
REVOKE ALL ON FUNCTION public.reverse_write_off(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_write_off(UUID, TEXT) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check before COMMIT: the three bodies are 105's, the check is not callable from the API, the two steps are definer and
-- callable by authenticated only and start with the second-step check, and the trigger is on invoices.
DO $$
DECLARE
  v_fn  TEXT;
  v_md5 TEXT;
  v_def BOOLEAN;
BEGIN
  FOR v_fn, v_md5, v_def IN VALUES
    ('public.invoices_write_off_guard()', '6ec5e742ef64fe23121c8099c42d2200', FALSE),
    ('public.write_off_invoice(uuid,text)', 'c7449f4564711533d43a1aa252eddfdf', TRUE),
    ('public.reverse_write_off(uuid,text)', '4750ac042335694164b634edca559f23', TRUE) LOOP
    IF (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) IS DISTINCT FROM v_md5
       OR (SELECT p.prosecdef IS DISTINCT FROM v_def
                  OR p.proconfig IS DISTINCT FROM CASE WHEN v_def THEN ARRAY['search_path=pg_catalog, public, security_audit'] ELSE ARRAY['search_path=pg_catalog, public'] END
           FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn)) THEN
      RAISE EXCEPTION '105: % is not 105''s after the replace', v_fn;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_fn), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(v_fn), 'EXECUTE') IS DISTINCT FROM v_def
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure(v_fn) AND a.grantee = 0) THEN
      RAISE EXCEPTION '105: % has the wrong grants', v_fn;
    END IF;
    IF v_def AND position('assert_privileged_aal' IN pg_get_functiondef(to_regprocedure(v_fn))) = 0 THEN
      RAISE EXCEPTION '105: % does not start with the second-step check', v_fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'invoices_write_off_guard' AND t.tgrelid = 'public.invoices'::regclass
                   AND t.tgfoid = 'public.invoices_write_off_guard()'::regprocedure AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '105: the invoice write-off trigger is missing';
  END IF;
END
$$;

COMMIT;

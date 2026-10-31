-- Proof of migration 105 (invoice write-off only through write_off_invoice / reverse_write_off). Run with psql on a DISPOSABLE copy
-- of a database that has 000..105 applied (never production):
--   psql -v ON_ERROR_STOP=1 -d <copy> -f tests/scripts/invoice-write-off-105.sql
-- Everything runs in one transaction that is rolled back; it stops with an error at the first check that fails and ends with
-- "105 proof: all checks passed". Signed-in users are simulated with SET ROLE authenticated and request.jwt.claims.
\set ON_ERROR_STOP 1
BEGIN;

-- Fixtures (as the database owner, which the guards do not hold).
INSERT INTO public.organizations (id, name, slug, require_admin_mfa) VALUES
  ('a1050000-0000-0000-0000-00000000000a', 'WO Alpha', 't-wo105-alpha', TRUE),
  ('a1050000-0000-0000-0000-00000000000b', 'WO Beta', 't-wo105-beta', FALSE);
INSERT INTO auth.users (id, email) VALUES
  ('a1050000-0000-0000-0000-0000000000a1', 'admin.wo105@example.test'),
  ('a1050000-0000-0000-0000-0000000000a2', 'office.wo105@example.test'),
  ('a1050000-0000-0000-0000-0000000000a3', 'workshop.wo105@example.test'),
  ('a1050000-0000-0000-0000-0000000000b2', 'office.beta.wo105@example.test');
INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES
  ('a1050000-0000-0000-0000-0000000000a1', 'admin.wo105@example.test', 'admin', 'a1050000-0000-0000-0000-00000000000a'),
  ('a1050000-0000-0000-0000-0000000000a2', 'office.wo105@example.test', 'office', 'a1050000-0000-0000-0000-00000000000a'),
  ('a1050000-0000-0000-0000-0000000000a3', 'workshop.wo105@example.test', 'workshop', 'a1050000-0000-0000-0000-00000000000a'),
  ('a1050000-0000-0000-0000-0000000000b2', 'office.beta.wo105@example.test', 'office', 'a1050000-0000-0000-0000-00000000000b')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, must_change_password = FALSE, active = TRUE;
UPDATE public.user_profiles SET must_change_password = FALSE, active = TRUE WHERE id::TEXT LIKE 'a1050000-%';
INSERT INTO public.organization_members (user_id, organization_id, role) VALUES
  ('a1050000-0000-0000-0000-0000000000a1', 'a1050000-0000-0000-0000-00000000000a', 'admin'),
  ('a1050000-0000-0000-0000-0000000000a2', 'a1050000-0000-0000-0000-00000000000a', 'office'),
  ('a1050000-0000-0000-0000-0000000000a3', 'a1050000-0000-0000-0000-00000000000a', 'workshop'),
  ('a1050000-0000-0000-0000-0000000000b2', 'a1050000-0000-0000-0000-00000000000b', 'office')
ON CONFLICT DO NOTHING;
-- 1 issued, 2 sent, 3 part paid (20 of 120), 4 paid, 5 draft, 6 void, 7 imported payments unconfirmed, 8 written off by import,
-- 9 credited in full (status partial would be odd: kept issued with a full credit), 10 issued (direct PATCH tests).
INSERT INTO public.invoices (id, organization_id, invoice_ref, customer, subtotal, vat, total, status, sent_date, amount_paid, credited_amount, refunded_amount, payment_unverified) VALUES
  ('a1050000-0000-0000-0000-000000000001', 'a1050000-0000-0000-0000-00000000000a', 'WO-1', 'C', 100, 20, 120, 'issued', NULL, 0, 0, 0, FALSE),
  ('a1050000-0000-0000-0000-000000000002', 'a1050000-0000-0000-0000-00000000000a', 'WO-2', 'C', 100, 20, 120, 'sent', now(), 0, 0, 0, FALSE),
  ('a1050000-0000-0000-0000-000000000003', 'a1050000-0000-0000-0000-00000000000a', 'WO-3', 'C', 100, 20, 120, 'partial', now(), 20, 0, 0, FALSE),
  ('a1050000-0000-0000-0000-000000000004', 'a1050000-0000-0000-0000-00000000000a', 'WO-4', 'C', 100, 20, 120, 'paid', now(), 120, 0, 0, FALSE),
  ('a1050000-0000-0000-0000-000000000005', 'a1050000-0000-0000-0000-00000000000a', NULL, 'C', 100, 20, 120, 'draft', NULL, 0, 0, 0, FALSE),
  ('a1050000-0000-0000-0000-000000000006', 'a1050000-0000-0000-0000-00000000000a', 'WO-6', 'C', 100, 20, 120, 'void', NULL, 0, 0, 0, FALSE),
  ('a1050000-0000-0000-0000-000000000007', 'a1050000-0000-0000-0000-00000000000a', 'WO-7', 'C', 100, 20, 120, 'sent', now(), 0, 0, 0, TRUE),
  ('a1050000-0000-0000-0000-000000000008', 'a1050000-0000-0000-0000-00000000000a', 'WO-8', 'C', 100, 20, 120, 'written_off', NULL, 0, 0, 0, FALSE),
  ('a1050000-0000-0000-0000-000000000009', 'a1050000-0000-0000-0000-00000000000a', 'WO-9', 'C', 100, 20, 120, 'issued', NULL, 0, 120, 0, FALSE),
  ('a1050000-0000-0000-0000-000000000010', 'a1050000-0000-0000-0000-00000000000a', 'WO-10', 'C', 100, 20, 120, 'issued', NULL, 0, 0, 0, FALSE);
INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, source) VALUES
  ('a1050000-0000-0000-0000-00000000000a', 'a1050000-0000-0000-0000-000000000003', 20, current_date, 'BACS', 'recorded'),
  ('a1050000-0000-0000-0000-00000000000a', 'a1050000-0000-0000-0000-000000000004', 120, current_date, 'BACS', 'recorded');

-- expect(sql, want): runs sql as the current role; want 'ok' or the refusal's 'SQLSTATE hint' (or 'SQLSTATE' when it has no hint).
CREATE FUNCTION public._t105_expect(p_sql TEXT, p_want TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_got TEXT; v_state TEXT; v_hint TEXT; v_msg TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
    v_got := 'ok';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    v_got := btrim(v_state || ' ' || coalesce(v_hint, ''));
  END;
  IF v_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '105 proof FAILED: % -> got "%" (%), wanted "%"', p_sql, v_got, coalesce(v_msg, ''), p_want;
  END IF;
  RAISE NOTICE 'pass: % -> %', left(p_sql, 110), v_got;
END $$;
GRANT EXECUTE ON FUNCTION public._t105_expect(TEXT, TEXT) TO authenticated;
CREATE FUNCTION public._t105_status(p_id UUID) RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS
  $$ SELECT status FROM public.invoices WHERE id = p_id $$;
GRANT EXECUTE ON FUNCTION public._t105_status(UUID) TO authenticated;
CREATE FUNCTION public._t105_check(p_ok BOOLEAN, p_what TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION '105 proof FAILED: %', p_what; END IF;
  RAISE NOTICE 'pass: %', p_what;
END $$;
GRANT EXECUTE ON FUNCTION public._t105_check(BOOLEAN, TEXT) TO authenticated;

-- ---- Office of Alpha ---------------------------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a1050000-0000-0000-0000-0000000000a2","role":"authenticated","aal":"aal1"}', TRUE);
-- (a) a direct PATCH into written off is refused, on issued, sent and part-paid invoices, and on a draft.
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'written_off' WHERE id = 'a1050000-0000-0000-0000-000000000010'$$, '42501 invoice_write_off_direct');
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'written_off' WHERE id = 'a1050000-0000-0000-0000-000000000002'$$, '42501 invoice_write_off_direct');
-- (part paid: 076's invoice_issue_lock, which sorts first, already refuses any direct move out of partial: 42501, its own message)
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'written_off' WHERE id = 'a1050000-0000-0000-0000-000000000003'$$, '42501');
-- (a draft: 027's number check without a number, 091's guard with one; 105 leaves drafts to them, so their messages are unchanged)
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'written_off' WHERE id = 'a1050000-0000-0000-0000-000000000005'$$, '23514');
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'written_off', invoice_ref = 'WO-OWN' WHERE id = 'a1050000-0000-0000-0000-000000000005'$$, '42501 invoice_issue_direct');
-- ... and out of written off (the imported one) too.
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'sent' WHERE id = 'a1050000-0000-0000-0000-000000000008'$$, '42501 invoice_write_off_direct');
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'issued' WHERE id = 'a1050000-0000-0000-0000-000000000008'$$, '42501 invoice_write_off_direct');
-- Other status moves that were open stay open (issued -> sent).
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'sent' WHERE id = 'a1050000-0000-0000-0000-000000000010'$$, 'ok');
-- (b) write_off_invoice refusals.
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000001', 'too short')$$, '22023 write_off_reason_required');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000001', NULL)$$, '22023 write_off_reason_required');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000001', '          x')$$, '22023 write_off_reason_required');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000005', 'Customer has gone into liquidation')$$, '22023 invoice_draft');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000006', 'Customer has gone into liquidation')$$, '22023 invoice_void');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000004', 'Customer has gone into liquidation')$$, '22023 invoice_nothing_owed');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000009', 'Customer has gone into liquidation')$$, '22023 invoice_nothing_owed');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000007', 'Customer has gone into liquidation')$$, '22023 invoice_payments_unconfirmed');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000008', 'Customer has gone into liquidation')$$, '22023 invoice_already_written_off');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-0000000000ff', 'Customer has gone into liquidation')$$, 'P0002');
-- (b) works: issued, sent and part paid; amounts untouched; audit row with the reason.
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000001', '  Customer has gone into liquidation  ')$$, 'ok');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000002', 'Disputed, not worth chasing')$$, 'ok');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000003', 'Short paid, remainder written off')$$, 'ok');
SELECT public._t105_check(public._t105_status('a1050000-0000-0000-0000-000000000001') = 'written_off'
  AND public._t105_status('a1050000-0000-0000-0000-000000000002') = 'written_off'
  AND public._t105_status('a1050000-0000-0000-0000-000000000003') = 'written_off', 'issued, sent and part paid are written off');
-- payments are refused on a written-off invoice (034, unchanged).
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000001', 'Customer has gone into liquidation')$$, '22023 invoice_already_written_off');
-- (c) reverse_write_off refusals and work.
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000010', 'Customer paid after all')$$, '22023 invoice_not_written_off');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000001', 'short')$$, '22023 write_off_reason_required');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000001', 'Customer paid after all')$$, 'ok');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000002', 'Customer paid after all')$$, 'ok');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000003', 'Customer paid after all')$$, 'ok');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000008', 'Imported in error as written off')$$, 'ok');
SELECT public._t105_check(public._t105_status('a1050000-0000-0000-0000-000000000001') = 'issued'
  AND public._t105_status('a1050000-0000-0000-0000-000000000002') = 'sent'
  AND public._t105_status('a1050000-0000-0000-0000-000000000003') = 'partial'
  AND public._t105_status('a1050000-0000-0000-0000-000000000008') = 'issued', 'reversed to issued, sent, partial (by figures and sent date)');
-- a direct PATCH back into written off is refused again after the reversal.
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'written_off' WHERE id = 'a1050000-0000-0000-0000-000000000001'$$, '42501 invoice_write_off_direct');
-- The app's write_audit can't make up either event.
SELECT public._t105_expect($$SELECT public.write_audit('WRITE_OFF_INVOICE', 'invoices', 'a1050000-0000-0000-0000-000000000001', NULL, NULL, '{}'::jsonb, NULL, NULL)$$, '42501');
SELECT public._t105_expect($$SELECT public.write_audit('REVERSE_WRITE_OFF', 'invoices', 'a1050000-0000-0000-0000-000000000001', NULL, NULL, '{}'::jsonb, NULL, NULL)$$, '42501');
RESET ROLE;

SELECT public._t105_check((SELECT count(*) = 3 FROM security_audit.audit_log WHERE action = 'WRITE_OFF_INVOICE' AND entity_id LIKE 'a1050000-%'
    AND actor_user_id = 'a1050000-0000-0000-0000-0000000000a2'), 'three WRITE_OFF_INVOICE rows by the office user');
SELECT public._t105_check((SELECT metadata ->> 'reason' = 'Customer has gone into liquidation' AND metadata ->> 'from_status' = 'issued'
    AND (metadata ->> 'balance_written_off')::NUMERIC = 120 FROM security_audit.audit_log WHERE action = 'WRITE_OFF_INVOICE' AND entity_id = 'a1050000-0000-0000-0000-000000000001'),
  'write-off audit carries the trimmed reason, the status it had and the balance');
SELECT public._t105_check((SELECT (metadata ->> 'balance_written_off')::NUMERIC = 100 FROM security_audit.audit_log WHERE action = 'WRITE_OFF_INVOICE' AND entity_id = 'a1050000-0000-0000-0000-000000000003'),
  'part paid: only the balance (100 of 120) is written off');
SELECT public._t105_check((SELECT count(*) = 4 FROM security_audit.audit_log WHERE action = 'REVERSE_WRITE_OFF' AND entity_id LIKE 'a1050000-%'
    AND metadata ->> 'reason' = CASE WHEN entity_id = 'a1050000-0000-0000-0000-000000000008' THEN 'Imported in error as written off' ELSE 'Customer paid after all' END), 'four REVERSE_WRITE_OFF rows with their reasons');
SELECT public._t105_check((SELECT bool_and(total = 120 AND subtotal = 100 AND vat = 20 AND invoice_ref IS NOT NULL) AND sum(amount_paid) = 20
    FROM public.invoices WHERE id IN ('a1050000-0000-0000-0000-000000000001', 'a1050000-0000-0000-0000-000000000002', 'a1050000-0000-0000-0000-000000000003')),
  'amounts and numbers untouched');

-- ---- Admin of Alpha (the company requires admin MFA): refused on aal1, works on aal2 ------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a1050000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal1"}', TRUE);
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000001', 'Customer has gone into liquidation')$$, '42501 mfa_required');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000001', 'Customer has gone into liquidation')$$, '42501 mfa_required');
SELECT set_config('request.jwt.claims', '{"sub":"a1050000-0000-0000-0000-0000000000a1","role":"authenticated","aal":"aal2"}', TRUE);
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'written_off' WHERE id = 'a1050000-0000-0000-0000-000000000001'$$, '42501 invoice_write_off_direct');
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000001', 'Customer has gone into liquidation')$$, 'ok');
SELECT public._t105_expect($$UPDATE public.invoices SET status = 'issued' WHERE id = 'a1050000-0000-0000-0000-000000000001'$$, '42501 invoice_write_off_direct');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000001', 'Customer paid after all')$$, 'ok');
SELECT public._t105_check(public._t105_status('a1050000-0000-0000-0000-000000000001') = 'issued', 'admin on aal2 writes off and reverses');

-- ---- Workshop of Alpha: not authorised ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"a1050000-0000-0000-0000-0000000000a3","role":"authenticated","aal":"aal1"}', TRUE);
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000001', 'Customer has gone into liquidation')$$, '42501');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000001', 'Customer has gone into liquidation')$$, '42501');

-- ---- Office of Beta: another company's invoice reads as not found -------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"a1050000-0000-0000-0000-0000000000b2","role":"authenticated","aal":"aal1"}', TRUE);
SELECT public._t105_expect($$SELECT public.write_off_invoice('a1050000-0000-0000-0000-000000000010', 'Customer has gone into liquidation')$$, 'P0002');
SELECT public._t105_expect($$SELECT public.reverse_write_off('a1050000-0000-0000-0000-000000000008', 'Customer has gone into liquidation')$$, 'P0002');
RESET ROLE;
SELECT public._t105_check(public._t105_status('a1050000-0000-0000-0000-000000000010') = 'sent'
  AND public._t105_status('a1050000-0000-0000-0000-000000000008') = 'issued', 'the other company''s refusals changed nothing');

-- ---- anon: no execute ---------------------------------------------------------------------------------------------
SELECT public._t105_check(NOT has_function_privilege('anon', 'public.write_off_invoice(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.reverse_write_off(uuid,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.write_off_invoice(uuid,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.reverse_write_off(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.invoices_write_off_guard()', 'EXECUTE'), 'grants: authenticated only; the check not callable');

-- The database owner is not held to the guard (imports, maintenance).
UPDATE public.invoices SET status = 'written_off' WHERE id = 'a1050000-0000-0000-0000-000000000010';
SELECT public._t105_check(public._t105_status('a1050000-0000-0000-0000-000000000010') = 'written_off', 'owner exempt');

SELECT '105 proof: all checks passed' AS result;
ROLLBACK;

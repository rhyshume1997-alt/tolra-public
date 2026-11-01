-- Local proof for migration 123 (the customer's PO on the quote). Run on a COPY of a database with the chain applied plus 123:
--   createdb e_123 -T base; psql -d e_123 -f supabase/release/123_quote_customer_po.release.sql; psql -d e_123 -f this
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises FAIL.
\set ON_ERROR_STOP 1
BEGIN;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('12300000-0000-0000-0000-0000000000a0', 'Proof A', 't-proof-123-a'),
  ('12300000-0000-0000-0000-0000000000b0', 'Proof B', 't-proof-123-b');
INSERT INTO auth.users (id, email) VALUES
  ('12300000-0000-0000-0000-0000000000a1', 'office.a@example.test'),
  ('12300000-0000-0000-0000-0000000000a2', 'workshop.a@example.test'),
  ('12300000-0000-0000-0000-0000000000b1', 'office.b@example.test');
INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES
  ('12300000-0000-0000-0000-0000000000a1', 'office.a@example.test', 'office', '12300000-0000-0000-0000-0000000000a0'),
  ('12300000-0000-0000-0000-0000000000a2', 'workshop.a@example.test', 'workshop', '12300000-0000-0000-0000-0000000000a0'),
  ('12300000-0000-0000-0000-0000000000b1', 'office.b@example.test', 'office', '12300000-0000-0000-0000-0000000000b0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id;
INSERT INTO public.organization_members (user_id, organization_id, role, hidden_sections) VALUES
  ('12300000-0000-0000-0000-0000000000a1', '12300000-0000-0000-0000-0000000000a0', 'office', '{}'),
  ('12300000-0000-0000-0000-0000000000a2', '12300000-0000-0000-0000-0000000000a0', 'workshop', '{}'),
  ('12300000-0000-0000-0000-0000000000b1', '12300000-0000-0000-0000-0000000000b0', 'office', '{}');
-- Quotes (made by the owner, so their status can start as sent): VAT off, one line of 100.00, total 100.00.
INSERT INTO public.quotes (id, organization_id, quote_ref, customer, status, sent_at, total_value, vat_enabled, customer_po) VALUES
  ('12300000-0000-0000-0000-00000000c001', '12300000-0000-0000-0000-0000000000a0', 'QUO-9001', 'Chain Co', 'sent', now(), 100, FALSE, '4471'),
  ('12300000-0000-0000-0000-00000000c002', '12300000-0000-0000-0000-0000000000a0', 'QUO-9002', 'Late Co', 'sent', now(), 100, FALSE, NULL),
  ('12300000-0000-0000-0000-00000000c003', '12300000-0000-0000-0000-0000000000a0', 'QUO-9003', 'Dialog Co', 'sent', now(), 100, FALSE, '5000'),
  ('12300000-0000-0000-0000-00000000c004', '12300000-0000-0000-0000-0000000000a0', 'QUO-9004', 'Rev Co', 'sent', now(), 100, FALSE, '6000'),
  ('12300000-0000-0000-0000-00000000c0b1', '12300000-0000-0000-0000-0000000000b0', 'QUO-9101', 'B Co', 'sent', now(), 100, FALSE, 'B-PO');
INSERT INTO public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct, vat_exempt)
SELECT q.organization_id, q.id, 0, 'Bush', 1, 100, 20, FALSE FROM public.quotes q WHERE q.quote_ref LIKE 'QUO-9%' AND q.organization_id IN ('12300000-0000-0000-0000-0000000000a0', '12300000-0000-0000-0000-0000000000b0');

-- Sign in (aal2) and run one statement; '<sqlstate>' on error, 'ok:<result>' otherwise.
CREATE FUNCTION pg_temp.as_user(p_user UUID, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_out TEXT; v_state TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::TEXT, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql INTO v_out;
    RESET ROLE;
    RETURN 'ok:' || coalesce(v_out, '');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RESET ROLE;
    RETURN v_state;
  END;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(UUID, TEXT) TO authenticated;

DO $$
DECLARE r TEXT; j JSONB; so RECORD; jb RECORD; inv RECORD; v_inv UUID; v_issued UUID;
  A CONSTANT UUID := '12300000-0000-0000-0000-0000000000a1'; W CONSTANT UUID := '12300000-0000-0000-0000-0000000000a2'; B CONSTANT UUID := '12300000-0000-0000-0000-0000000000b1';
BEGIN
  -- 1. The column's rules: trimmed, not empty, at most 100.
  BEGIN UPDATE public.quotes SET customer_po = ' 4471' WHERE id = '12300000-0000-0000-0000-00000000c002'; RAISE EXCEPTION 'FAIL 1 untrimmed accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.quotes SET customer_po = '' WHERE id = '12300000-0000-0000-0000-00000000c002'; RAISE EXCEPTION 'FAIL 1 empty accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.quotes SET customer_po = repeat('x', 101) WHERE id = '12300000-0000-0000-0000-00000000c002'; RAISE EXCEPTION 'FAIL 1 101 accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'PASS 1 quotes.customer_po: untrimmed, empty and 101 characters refused';

  -- 2. The guard: a sent quote's PO (or any other field) can't be changed directly by a signed-in user.
  r := pg_temp.as_user(A, $q$UPDATE public.quotes SET customer_po = '9999' WHERE id = '12300000-0000-0000-0000-00000000c002' RETURNING id$q$);
  IF r <> '42501' THEN RAISE EXCEPTION 'FAIL 2 direct PO change on a sent quote: %', r; END IF;
  r := pg_temp.as_user(A, $q$UPDATE public.quotes SET description = 'changed' WHERE id = '12300000-0000-0000-0000-00000000c002' RETURNING id$q$);
  IF r <> '42501' THEN RAISE EXCEPTION 'FAIL 2 description change on a sent quote: %', r; END IF;
  -- The setting set_quote_customer_po uses lets only customer_po through: with it set, the description is still refused.
  PERFORM set_config('quoteflow.set_quote_customer_po', '12300000-0000-0000-0000-00000000c002', true);
  r := pg_temp.as_user(A, $q$UPDATE public.quotes SET description = 'changed' WHERE id = '12300000-0000-0000-0000-00000000c002' RETURNING id$q$);
  IF r <> '42501' THEN RAISE EXCEPTION 'FAIL 2 description change with the PO setting: %', r; END IF;
  PERFORM set_config('quoteflow.set_quote_customer_po', '', true);
  RAISE NOTICE 'PASS 2 sent quote: direct PO change and other edits refused (42501), even with the PO setting the description stays refused';

  -- 3. The whole chain: quote QUO-9001 with PO 4471 -> accept (dialog empty) -> order with customer_po 4471 -> job 4471 -> draft invoice 4471.
  r := pg_temp.as_user(A, $q$SELECT public.accept_quote('12300000-0000-0000-0000-00000000c001', NULL, NULL)::TEXT$q$);
  IF r NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 3 accept: %', r; END IF;
  j := substr(r, 4)::JSONB;
  SELECT * INTO so FROM public.sales_orders WHERE quote_id = '12300000-0000-0000-0000-00000000c001';
  IF so.customer_po IS DISTINCT FROM '4471' OR so.id::TEXT <> j->>'so_id' THEN RAISE EXCEPTION 'FAIL 3 order %', row_to_json(so); END IF;
  SELECT * INTO jb FROM public.jobs WHERE id = (j->>'job_id')::UUID;
  IF jb.customer_po IS DISTINCT FROM '4471' THEN RAISE EXCEPTION 'FAIL 3 job %', row_to_json(jb); END IF;
  r := pg_temp.as_user(A, format($q$UPDATE public.jobs SET started_at = now() - interval '1 hour', finished_at = now() WHERE id = %L RETURNING id$q$, jb.id));
  IF r NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 3 finish: %', r; END IF;
  -- Finished with nothing despatched: no draft yet (099). The despatch (owner-made note of the order's lines, sent out), then the
  -- Job Finish drafting function itself (099's job_finish_draft_invoice, the caller's company).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', A, 'role', 'authenticated', 'aal', 'aal2')::TEXT, true);
  PERFORM public.ensure_sales_order_lines(so.id);
  INSERT INTO public.delivery_notes (organization_id, dn_number, customer, sales_order_id, job_id, status, delivery_date)
  VALUES ('12300000-0000-0000-0000-0000000000a0', 'DLN-9001', 'Chain Co', so.id, jb.id, 'despatched', CURRENT_DATE) RETURNING id INTO v_issued;
  INSERT INTO public.delivery_note_items (organization_id, delivery_note_id, position, description, quantity, sales_order_line_id)
  SELECT l.organization_id, v_issued, l.position, l.description, l.quantity, l.id FROM public.sales_order_lines l WHERE l.sales_order_id = so.id;
  r := public.job_finish_draft_invoice(jb.id, '12300000-0000-0000-0000-0000000000a0');
  SELECT * INTO inv FROM public.invoices WHERE job_id = jb.id;
  IF inv.status <> 'draft' OR inv.customer_po IS DISTINCT FROM '4471' THEN RAISE EXCEPTION 'FAIL 3 draft invoice (%) %', r, row_to_json(inv); END IF;
  RAISE NOTICE 'PASS 3 chain: QUO-9001 (Customer PO 4471) > order % (customer_po 4471) > job % (4471) > draft invoice % (4471)', so.so_number, jb.job_no, inv.invoice_ref;

  -- 4. The dialog's PO wins over the quote's.
  r := pg_temp.as_user(A, $q$SELECT public.accept_quote('12300000-0000-0000-0000-00000000c003', 'DIALOG-1', NULL)::TEXT$q$);
  IF r NOT LIKE 'ok:%' OR (SELECT customer_po FROM public.sales_orders WHERE quote_id = '12300000-0000-0000-0000-00000000c003') IS DISTINCT FROM 'DIALOG-1' THEN RAISE EXCEPTION 'FAIL 4: %', r; END IF;
  RAISE NOTICE 'PASS 4 the accept dialog''s PO is used when given';

  -- 5. Late PO: QUO-9002 accepted with none, then the PO is added on the quote: quote, order, unfinished job, draft invoice.
  r := pg_temp.as_user(A, $q$SELECT public.accept_quote('12300000-0000-0000-0000-00000000c002', NULL, NULL)::TEXT$q$);
  IF r NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 5 accept: %', r; END IF;
  j := substr(r, 4)::JSONB;
  -- A draft invoice already on the job (as Finish makes), so the late PO must reach it; the job is still unfinished.
  INSERT INTO public.invoices (organization_id, invoice_ref, customer, job_id, status, subtotal, vat, total) VALUES
    ('12300000-0000-0000-0000-0000000000a0', 'INV-9902', 'Late Co', (j->>'job_id')::UUID, 'draft', 100, 0, 100) RETURNING id INTO v_inv;
  r := pg_temp.as_user(A, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c002', ' 7788 ')::TEXT$q$);
  IF r NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 5 set: %', r; END IF;
  j := substr(r, 4)::JSONB;
  IF (j->>'changed')::BOOLEAN IS NOT TRUE OR (j->>'job_updated')::BOOLEAN IS NOT TRUE OR (j->>'draft_invoices')::INT <> 1 THEN RAISE EXCEPTION 'FAIL 5 result %', j; END IF;
  IF (SELECT customer_po FROM public.quotes WHERE id = '12300000-0000-0000-0000-00000000c002') IS DISTINCT FROM '7788'
     OR (SELECT customer_po FROM public.sales_orders WHERE quote_id = '12300000-0000-0000-0000-00000000c002') IS DISTINCT FROM '7788'
     OR (SELECT customer_po FROM public.jobs WHERE id = (j->>'job_id')::UUID) IS DISTINCT FROM '7788'
     OR (SELECT customer_po FROM public.invoices WHERE id = v_inv) IS DISTINCT FROM '7788' THEN RAISE EXCEPTION 'FAIL 5 copies'; END IF;
  IF (SELECT count(*) FROM security_audit.audit_log WHERE action = 'SET_CUSTOMER_PO' AND entity_table = 'quotes' AND entity_id = '12300000-0000-0000-0000-00000000c002') <> 1 THEN RAISE EXCEPTION 'FAIL 5 audit'; END IF;
  r := pg_temp.as_user(A, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c002', '7788')::TEXT$q$);
  IF (substr(r, 4)::JSONB->>'changed')::BOOLEAN IS NOT FALSE THEN RAISE EXCEPTION 'FAIL 5 same again: %', r; END IF;
  RAISE NOTICE 'PASS 5 late PO on an accepted quote: quote, order, unfinished job and draft invoice all 7788; one audit event; same again = no change';

  -- 6. An issued invoice is never changed: QUO-9001's invoice issued (owner), then its PO changed on the quote.
  UPDATE public.invoices SET status = 'sent', invoice_ref = 'INV-9901', issued_at = now() WHERE id = inv.id;
  r := pg_temp.as_user(A, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c001', '4472')::TEXT$q$);
  IF r NOT LIKE 'ok:%' OR (substr(r, 4)::JSONB->>'draft_invoices')::INT <> 0 THEN RAISE EXCEPTION 'FAIL 6: %', r; END IF;
  IF (SELECT customer_po FROM public.invoices WHERE id = inv.id) IS DISTINCT FROM '4471' THEN RAISE EXCEPTION 'FAIL 6 issued invoice changed'; END IF;
  IF (SELECT customer_po FROM public.jobs WHERE id = jb.id) IS DISTINCT FROM '4471' THEN RAISE EXCEPTION 'FAIL 6 finished job changed'; END IF;
  IF (SELECT customer_po FROM public.sales_orders WHERE id = so.id) IS DISTINCT FROM '4472' THEN RAISE EXCEPTION 'FAIL 6 order not changed'; END IF;
  RAISE NOTICE 'PASS 6 issued invoice keeps 4471 and the finished job keeps 4471; the quote and order take 4472';

  -- 7. Refusals: another company's quote, the workshop, an empty PO once there is an order, over 100 characters.
  r := pg_temp.as_user(A, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c0b1', 'X')::TEXT$q$);
  IF r <> 'P0002' THEN RAISE EXCEPTION 'FAIL 7 cross-company: %', r; END IF;
  IF (SELECT customer_po FROM public.quotes WHERE id = '12300000-0000-0000-0000-00000000c0b1') IS DISTINCT FROM 'B-PO' THEN RAISE EXCEPTION 'FAIL 7 B changed'; END IF;
  r := pg_temp.as_user(W, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c002', 'X')::TEXT$q$);
  IF r <> '42501' THEN RAISE EXCEPTION 'FAIL 7 workshop: %', r; END IF;
  r := pg_temp.as_user(A, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c002', '  ')::TEXT$q$);
  IF r <> '22023' THEN RAISE EXCEPTION 'FAIL 7 empty with an order: %', r; END IF;
  r := pg_temp.as_user(A, format($q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c002', %L)::TEXT$q$, repeat('x', 101)));
  IF r <> '22023' THEN RAISE EXCEPTION 'FAIL 7 101: %', r; END IF;
  r := pg_temp.as_user(B, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c002', 'X')::TEXT$q$);
  IF r <> 'P0002' THEN RAISE EXCEPTION 'FAIL 7 B on A: %', r; END IF;
  RAISE NOTICE 'PASS 7 refused: other company (P0002 both ways), workshop (42501), empty with an order and 101 characters (22023)';

  -- 8. A sent quote with no order: the PO set (and cleared) on the quote alone; revise keeps it.
  r := pg_temp.as_user(A, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c004', '6001')::TEXT$q$);
  IF r NOT LIKE 'ok:%' OR (SELECT customer_po FROM public.quotes WHERE id = '12300000-0000-0000-0000-00000000c004') IS DISTINCT FROM '6001' THEN RAISE EXCEPTION 'FAIL 8 set: %', r; END IF;
  r := pg_temp.as_user(A, $q$SELECT public.revise_quote('12300000-0000-0000-0000-00000000c004')::TEXT$q$);
  IF r NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 8 revise: %', r; END IF;
  IF (SELECT customer_po FROM public.quotes WHERE id = (substr(r, 4)::JSONB->>'quote_id')::UUID) IS DISTINCT FROM '6001' THEN RAISE EXCEPTION 'FAIL 8 revision lost the PO'; END IF;
  r := pg_temp.as_user(A, $q$SELECT public.set_quote_customer_po('12300000-0000-0000-0000-00000000c004', 'X')::TEXT$q$);
  IF r <> '22023' THEN RAISE EXCEPTION 'FAIL 8 superseded: %', r; END IF;
  RAISE NOTICE 'PASS 8 sent quote without an order: PO set on the quote; revise_quote carries it to v2; the superseded v1 refuses (22023)';
END
$$;
ROLLBACK;

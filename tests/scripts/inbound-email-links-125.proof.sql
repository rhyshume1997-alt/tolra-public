-- Local proof for migration 125 (inbox e-mails linked to a quote or purchase order; suggestions only). Run on a COPY of a database with
-- the chain applied plus 125 (and, for sections 10 and 11, 123 too):
--   createdb x -T <chain db>; psql -d x -f supabase/release/125_inbound_email_links.release.sql; psql -d x -f this
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises FAIL.
\set ON_ERROR_STOP 1
BEGIN;
-- Two companies. A: admin, office, workshop, viewer, an office with Quotes hidden. B: admin, office.
INSERT INTO public.organizations (id, name, slug) VALUES
  ('12500000-0000-0000-0000-0000000000a0', 'Proof A', 't-proof-125-a'),
  ('12500000-0000-0000-0000-0000000000b0', 'Proof B', 't-proof-125-b');
INSERT INTO auth.users (id, email) VALUES
  ('12500000-0000-0000-0000-0000000000a1', 'admin.a@example.test'),
  ('12500000-0000-0000-0000-0000000000a2', 'office.a@example.test'),
  ('12500000-0000-0000-0000-0000000000a3', 'workshop.a@example.test'),
  ('12500000-0000-0000-0000-0000000000a4', 'viewer.a@example.test'),
  ('12500000-0000-0000-0000-0000000000a5', 'office.noquotes.a@example.test'),
  ('12500000-0000-0000-0000-0000000000b1', 'admin.b@example.test'),
  ('12500000-0000-0000-0000-0000000000b2', 'office.b@example.test');
INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES
  ('12500000-0000-0000-0000-0000000000a1', 'admin.a@example.test', 'admin', '12500000-0000-0000-0000-0000000000a0'),
  ('12500000-0000-0000-0000-0000000000a2', 'office.a@example.test', 'office', '12500000-0000-0000-0000-0000000000a0'),
  ('12500000-0000-0000-0000-0000000000a3', 'workshop.a@example.test', 'workshop', '12500000-0000-0000-0000-0000000000a0'),
  ('12500000-0000-0000-0000-0000000000a4', 'viewer.a@example.test', 'viewer', '12500000-0000-0000-0000-0000000000a0'),
  ('12500000-0000-0000-0000-0000000000a5', 'office.noquotes.a@example.test', 'office', '12500000-0000-0000-0000-0000000000a0'),
  ('12500000-0000-0000-0000-0000000000b1', 'admin.b@example.test', 'admin', '12500000-0000-0000-0000-0000000000b0'),
  ('12500000-0000-0000-0000-0000000000b2', 'office.b@example.test', 'office', '12500000-0000-0000-0000-0000000000b0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id;
INSERT INTO public.organization_members (user_id, organization_id, role, hidden_sections) VALUES
  ('12500000-0000-0000-0000-0000000000a1', '12500000-0000-0000-0000-0000000000a0', 'admin', '{}'),
  ('12500000-0000-0000-0000-0000000000a2', '12500000-0000-0000-0000-0000000000a0', 'office', '{}'),
  ('12500000-0000-0000-0000-0000000000a3', '12500000-0000-0000-0000-0000000000a0', 'workshop', '{}'),
  ('12500000-0000-0000-0000-0000000000a4', '12500000-0000-0000-0000-0000000000a0', 'viewer', '{}'),
  ('12500000-0000-0000-0000-0000000000a5', '12500000-0000-0000-0000-0000000000a0', 'office', '{quotes}'),
  ('12500000-0000-0000-0000-0000000000b1', '12500000-0000-0000-0000-0000000000b0', 'admin', '{}'),
  ('12500000-0000-0000-0000-0000000000b2', '12500000-0000-0000-0000-0000000000b0', 'office', '{}');
-- Quotes (A: two sent, one draft; B: one sent), purchase orders (one each), e-mails (A: three; B: one). Written as the owner.
INSERT INTO public.quotes (id, organization_id, quote_ref, customer, status) VALUES
  ('12500000-0000-0000-0000-00000000c0a1', '12500000-0000-0000-0000-0000000000a0', 'QUO-P125-1', 'Acme Ltd', 'sent'),
  ('12500000-0000-0000-0000-00000000c0a2', '12500000-0000-0000-0000-0000000000a0', 'QUO-P125-2', 'Acme Ltd', 'sent'),
  ('12500000-0000-0000-0000-00000000c0a3', '12500000-0000-0000-0000-0000000000a0', 'QUO-P125-3', 'Acme Ltd', 'draft'),
  ('12500000-0000-0000-0000-00000000c0b1', '12500000-0000-0000-0000-0000000000b0', 'QUO-P125-B', 'Beta Buyer', 'sent');
INSERT INTO public.purchase_orders (id, organization_id, po_ref, po_number, supplier, status) VALUES
  ('12500000-0000-0000-0000-00000000d0a1', '12500000-0000-0000-0000-0000000000a0', 'PO-P125-1', 'PO-P125-1', 'Steel Co', 'sent'),
  ('12500000-0000-0000-0000-00000000d0b1', '12500000-0000-0000-0000-0000000000b0', 'PO-P125-B', 'PO-P125-B', 'B Steel', 'sent');
INSERT INTO public.inbound_emails (id, organization_id, graph_message_id, from_address, subject, received_at, body_text) VALUES
  ('12500000-0000-0000-0000-00000000e0a1', '12500000-0000-0000-0000-0000000000a0', 'p125-a1', 'buyer@acme.example', 'PO 4471 for QUO-P125-1', now(), 'Our PO 4471.'),
  ('12500000-0000-0000-0000-00000000e0a2', '12500000-0000-0000-0000-0000000000a0', 'p125-a2', 'buyer@acme.example', 'PO 9999', now(), 'PO 9999.'),
  ('12500000-0000-0000-0000-00000000e0a3', '12500000-0000-0000-0000-0000000000a0', 'p125-a3', 'buyer@acme.example', 'PO 5555', now(), 'PO 5555.'),
  ('12500000-0000-0000-0000-00000000e0b1', '12500000-0000-0000-0000-0000000000b0', 'p125-b1', 'buyer@beta.example', 'PO 7777', now(), 'PO 7777.');

-- Sign in as someone (or as anon with p_user NULL), call link_inbound_email, return 'ok:<jsonb>' or '<sqlstate>/<hint>'.
CREATE FUNCTION pg_temp.link(p_user UUID, p_email UUID, p_kind TEXT, p_target UUID, p_po TEXT, p_how TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_out JSONB; v_state TEXT; v_hint TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_user IS NULL THEN '{"role":"anon"}' ELSE json_build_object('sub', p_user, 'role', 'authenticated')::TEXT END, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::TEXT, ''), true);
  IF p_user IS NULL THEN SET LOCAL ROLE anon; ELSE SET LOCAL ROLE authenticated; END IF;
  BEGIN
    v_out := public.link_inbound_email(p_email, p_kind, p_target, p_po, p_how);
    RESET ROLE;
    RETURN 'ok:' || v_out::TEXT;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    RESET ROLE;
    RETURN v_state || '/' || v_hint;
  END;
END $$;
-- A statement as a signed-in person; returns 'ok:<rows>' or the SQLSTATE.
CREATE FUNCTION pg_temp.as_user(p_user UUID, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_n BIGINT; v_state TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::TEXT, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql INTO v_n;
    RESET ROLE;
    RETURN 'ok:' || coalesce(v_n::TEXT, 'null');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RESET ROLE;
    RETURN v_state;
  END;
END $$;

DO $$
DECLARE
  A_ADMIN CONSTANT UUID := '12500000-0000-0000-0000-0000000000a1'; A_OFFICE CONSTANT UUID := '12500000-0000-0000-0000-0000000000a2';
  A_WORK  CONSTANT UUID := '12500000-0000-0000-0000-0000000000a3'; A_VIEW   CONSTANT UUID := '12500000-0000-0000-0000-0000000000a4';
  A_NOQ   CONSTANT UUID := '12500000-0000-0000-0000-0000000000a5'; B_OFFICE CONSTANT UUID := '12500000-0000-0000-0000-0000000000b2';
  EA1 CONSTANT UUID := '12500000-0000-0000-0000-00000000e0a1'; EA2 CONSTANT UUID := '12500000-0000-0000-0000-00000000e0a2';
  EA3 CONSTANT UUID := '12500000-0000-0000-0000-00000000e0a3'; EB1 CONSTANT UUID := '12500000-0000-0000-0000-00000000e0b1';
  QA1 CONSTANT UUID := '12500000-0000-0000-0000-00000000c0a1'; QA2 CONSTANT UUID := '12500000-0000-0000-0000-00000000c0a2';
  QA3 CONSTANT UUID := '12500000-0000-0000-0000-00000000c0a3'; QB1 CONSTANT UUID := '12500000-0000-0000-0000-00000000c0b1';
  PA1 CONSTANT UUID := '12500000-0000-0000-0000-00000000d0a1'; PB1 CONSTANT UUID := '12500000-0000-0000-0000-00000000d0b1';
  r TEXT; e public.inbound_emails%ROWTYPE; b_before TEXT; i INT;
BEGIN
  SELECT md5(string_agg(t::TEXT, '|' ORDER BY t::TEXT)) INTO b_before FROM (
    SELECT row_to_json(x)::TEXT AS t FROM public.inbound_emails x WHERE organization_id = '12500000-0000-0000-0000-0000000000b0'
    UNION ALL SELECT row_to_json(x)::TEXT FROM public.quotes x WHERE organization_id = '12500000-0000-0000-0000-0000000000b0'
    UNION ALL SELECT row_to_json(x)::TEXT FROM public.purchase_orders x WHERE organization_id = '12500000-0000-0000-0000-0000000000b0') s;

  -- 1. The inbox check (admin) saves a suggestion: listed, status 'suggested', nothing linked, audited.
  r := pg_temp.link(A_ADMIN, EA1, 'quote', QA1, '4471', 'suggested');
  SELECT * INTO e FROM public.inbound_emails WHERE id = EA1;
  IF r NOT LIKE 'ok:%' OR e.link_status <> 'suggested' OR e.linked_quote_id IS NOT NULL OR e.linked_po_number IS NOT NULL
     OR e.link_suggestions <> jsonb_build_array(jsonb_build_object('kind', 'quote', 'id', QA1, 'ref', 'QUO-P125-1', 'po', '4471')) THEN
    RAISE EXCEPTION 'FAIL 1: % / % %', r, e.link_status, e.link_suggestions; END IF;
  IF NOT EXISTS (SELECT 1 FROM security_audit.audit_log WHERE action = 'SUGGEST_EMAIL_LINK' AND entity_id = EA1::TEXT AND actor_user_id = A_ADMIN) THEN RAISE EXCEPTION 'FAIL 1 audit'; END IF;
  -- The same candidate again adds nothing; a second quote (the customer has two) is added, so John can choose.
  r := pg_temp.link(A_ADMIN, EA1, 'quote', QA1, '4471', 'suggested');
  IF r NOT LIKE 'ok:%"changed": false%' THEN RAISE EXCEPTION 'FAIL 1 repeat: %', r; END IF;
  r := pg_temp.link(A_ADMIN, EA1, 'quote', QA2, '4471', 'suggested');
  IF (SELECT jsonb_array_length(link_suggestions) FROM public.inbound_emails WHERE id = EA1) <> 2 THEN RAISE EXCEPTION 'FAIL 1 second: %', r; END IF;
  RAISE NOTICE 'PASS 1 a suggestion is saved (status suggested, nothing linked, audited); repeats add nothing; several are kept for a choice';

  -- 2. Only the admin's inbox check saves suggestions; 'auto' is refused for everyone (reserved, off).
  IF pg_temp.link(A_OFFICE, EA2, 'quote', QA1, '9999', 'suggested') <> '42501/' THEN RAISE EXCEPTION 'FAIL 2 office suggested'; END IF;
  r := pg_temp.link(A_ADMIN, EA2, 'quote', QA1, '9999', 'auto');
  IF r <> '22023/auto_link_off' THEN RAISE EXCEPTION 'FAIL 2 auto: %', r; END IF;
  IF pg_temp.link(A_OFFICE, EA2, 'quote', QA1, '9999', 'auto') <> '22023/auto_link_off' THEN RAISE EXCEPTION 'FAIL 2 auto office'; END IF;
  IF (SELECT link_status FROM public.inbound_emails WHERE id = EA2) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 2 changed'; END IF;
  RAISE NOTICE 'PASS 2 office cannot save suggestions; automatic linking is refused (22023 auto_link_off) for admin and office';

  -- 3. Roles for the Link click: workshop and viewer refused; Quotes hidden refuses a quote link; anon has no EXECUTE.
  IF pg_temp.link(A_WORK, EA1, 'quote', QA1, '4471', 'manual') <> '42501/' THEN RAISE EXCEPTION 'FAIL 3 workshop'; END IF;
  IF pg_temp.link(A_VIEW, EA1, 'quote', QA1, '4471', 'manual') <> '42501/' THEN RAISE EXCEPTION 'FAIL 3 viewer'; END IF;
  IF pg_temp.link(A_NOQ, EA1, 'quote', QA1, '4471', 'manual') <> '42501/' THEN RAISE EXCEPTION 'FAIL 3 quotes hidden'; END IF;
  IF pg_temp.link(NULL, EA1, 'quote', QA1, '4471', 'manual') <> '42501/' THEN RAISE EXCEPTION 'FAIL 3 anon'; END IF;
  IF (SELECT link_status FROM public.inbound_emails WHERE id = EA1) <> 'suggested' THEN RAISE EXCEPTION 'FAIL 3 changed'; END IF;
  RAISE NOTICE 'PASS 3 workshop, viewer, office without Quotes and anon are refused (42501); nothing changed';

  -- 4. Cross-company: B's e-mail, B's quote and B's order all read "not found" (P0002) for A's admin and office; B's rows unchanged.
  FOREACH r IN ARRAY ARRAY[
      pg_temp.link(A_ADMIN, EB1, 'quote', QA1, '7777', 'manual'), pg_temp.link(A_OFFICE, EB1, 'quote', QA1, '7777', 'manual'),
      pg_temp.link(A_ADMIN, EB1, 'quote', QB1, '7777', 'suggested'), pg_temp.link(A_ADMIN, EA1, 'quote', QB1, '7777', 'suggested'),
      pg_temp.link(A_OFFICE, EA1, 'quote', QB1, '7777', 'manual'), pg_temp.link(A_OFFICE, EA1, 'purchase_order', PB1, NULL, 'manual')] LOOP
    IF r <> 'P0002/' THEN RAISE EXCEPTION 'FAIL 4: %', r; END IF;
  END LOOP;
  IF (SELECT md5(string_agg(t::TEXT, '|' ORDER BY t::TEXT)) FROM (
        SELECT row_to_json(x)::TEXT AS t FROM public.inbound_emails x WHERE organization_id = '12500000-0000-0000-0000-0000000000b0'
        UNION ALL SELECT row_to_json(x)::TEXT FROM public.quotes x WHERE organization_id = '12500000-0000-0000-0000-0000000000b0'
        UNION ALL SELECT row_to_json(x)::TEXT FROM public.purchase_orders x WHERE organization_id = '12500000-0000-0000-0000-0000000000b0') s) <> b_before THEN
    RAISE EXCEPTION 'FAIL 4 B changed'; END IF;
  IF EXISTS (SELECT 1 FROM public.inbound_emails WHERE id = EA1 AND (linked_quote_id IS NOT NULL OR link_suggestions::TEXT LIKE '%' || QB1 || '%')) THEN RAISE EXCEPTION 'FAIL 4 A got B''s quote'; END IF;
  RAISE NOTICE 'PASS 4 cross-company refused: B''s e-mail, quote and order are "not found" to A; every row of B unchanged';

  -- 5. Office's Link click: linked to the quote, status manual, the PO kept on the link; audited with the previous state.
  r := pg_temp.link(A_OFFICE, EA1, 'quote', QA1, '4471', 'manual');
  SELECT * INTO e FROM public.inbound_emails WHERE id = EA1;
  IF r NOT LIKE 'ok:%' OR e.link_status <> 'manual' OR e.linked_quote_id <> QA1 OR e.linked_purchase_order_id IS NOT NULL OR e.linked_po_number <> '4471' THEN
    RAISE EXCEPTION 'FAIL 5: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM security_audit.audit_log WHERE action = 'LINK_INBOUND_EMAIL' AND entity_id = EA1::TEXT AND actor_user_id = A_OFFICE
                   AND metadata->>'previous_link_status' = 'suggested' AND metadata->>'target_ref' = 'QUO-P125-1' AND metadata->>'po_number' = '4471') THEN
    RAISE EXCEPTION 'FAIL 5 audit'; END IF;
  -- The same click again changes nothing; a later suggestion does not undo a person's link.
  IF pg_temp.link(A_OFFICE, EA1, 'quote', QA1, '4471', 'manual') NOT LIKE 'ok:%"changed": false%' THEN RAISE EXCEPTION 'FAIL 5 repeat'; END IF;
  IF pg_temp.link(A_ADMIN, EA1, 'quote', QA2, '4471', 'suggested') NOT LIKE 'ok:%"changed": false%'
     OR (SELECT linked_quote_id FROM public.inbound_emails WHERE id = EA1) <> QA1 THEN RAISE EXCEPTION 'FAIL 5 suggestion after link'; END IF;
  RAISE NOTICE 'PASS 5 office Link: linked (manual, PO kept), audited with the previous state (%); repeat and later suggestion change nothing', r;

  -- 6. A supplier document linked to the order: the quote link is replaced (one link at most).
  r := pg_temp.link(A_ADMIN, EA1, 'purchase_order', PA1, 'PO-P125-1', 'manual');
  SELECT * INTO e FROM public.inbound_emails WHERE id = EA1;
  IF r NOT LIKE 'ok:%' OR e.linked_purchase_order_id <> PA1 OR e.linked_quote_id IS NOT NULL THEN RAISE EXCEPTION 'FAIL 6: %', r; END IF;
  RAISE NOTICE 'PASS 6 linked to a purchase order instead; one link at a time';

  -- 7. No direct writes for the API roles; RLS: B's office sees none of A's e-mails, A's workshop sees none.
  IF pg_temp.as_user(A_ADMIN, format('WITH u AS (UPDATE public.inbound_emails SET link_status = %L WHERE id = %L RETURNING 1) SELECT count(*) FROM u', 'manual', EA2)) <> '42501' THEN RAISE EXCEPTION 'FAIL 7 update'; END IF;
  IF pg_temp.as_user(B_OFFICE, format('SELECT count(*) FROM public.inbound_emails WHERE organization_id = %L', '12500000-0000-0000-0000-0000000000a0')) <> 'ok:0' THEN RAISE EXCEPTION 'FAIL 7 B reads A'; END IF;
  IF pg_temp.as_user(A_WORK, 'SELECT count(*) FROM public.inbound_emails') <> 'ok:0' THEN RAISE EXCEPTION 'FAIL 7 workshop reads'; END IF;
  RAISE NOTICE 'PASS 7 no direct UPDATE (42501); B''s office and A''s workshop read none of A''s e-mails';

  -- 8. The table's own rules, even for the owner: same-company trigger, a link needs manual/auto, one link at most, at most 10 suggestions.
  BEGIN UPDATE public.inbound_emails SET linked_quote_id = QB1, linked_purchase_order_id = NULL, link_status = 'manual' WHERE id = EA2; RAISE EXCEPTION 'FAIL 8 cross-org link stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.inbound_emails SET linked_quote_id = QA1, link_status = 'suggested' WHERE id = EA2; RAISE EXCEPTION 'FAIL 8 suggested link stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.inbound_emails SET linked_quote_id = QA1, linked_purchase_order_id = PA1, link_status = 'manual' WHERE id = EA2; RAISE EXCEPTION 'FAIL 8 two links stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.inbound_emails SET link_status = 'later' WHERE id = EA2; RAISE EXCEPTION 'FAIL 8 status stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  FOR i IN 1..12 LOOP
    INSERT INTO public.quotes (id, organization_id, quote_ref, customer, status)
    VALUES (('12500000-0000-0000-0000-0000000010' || lpad(i::TEXT, 2, '0'))::UUID, '12500000-0000-0000-0000-0000000000a0', 'QUO-P125-X' || i, 'Acme Ltd', 'sent');
    r := pg_temp.link(A_ADMIN, EA3, 'quote', ('12500000-0000-0000-0000-0000000010' || lpad(i::TEXT, 2, '0'))::UUID, '5555', 'suggested');
  END LOOP;
  IF (SELECT jsonb_array_length(link_suggestions) FROM public.inbound_emails WHERE id = EA3) <> 10 OR r NOT LIKE 'ok:%"changed": false%' THEN RAISE EXCEPTION 'FAIL 8 cap: %', r; END IF;
  RAISE NOTICE 'PASS 8 same-company trigger (23514), link only by a person, one link, known statuses, at most 10 suggestions';

  -- 9. A deleted draft quote leaves the e-mail unlinked (ON DELETE SET NULL), never deleted.
  r := pg_temp.link(A_OFFICE, EA2, 'quote', QA3, NULL, 'manual');
  DELETE FROM public.quotes WHERE id = QA3;
  SELECT * INTO e FROM public.inbound_emails WHERE id = EA2;
  IF r NOT LIKE 'ok:%' OR NOT FOUND OR e.linked_quote_id IS NOT NULL THEN RAISE EXCEPTION 'FAIL 9: % %', r, e.linked_quote_id; END IF;
  RAISE NOTICE 'PASS 9 deleting the quote unlinks the e-mail (SET NULL); the e-mail stays';
END $$;

-- 10. The customer PO goes on the quote through 123's set_quote_customer_po when 123 is applied; never overwritten. Skipped without 123.
DO $$
DECLARE r TEXT; v_po TEXT;
  A_OFFICE CONSTANT UUID := '12500000-0000-0000-0000-0000000000a2';
  QA1 CONSTANT UUID := '12500000-0000-0000-0000-00000000c0a1'; QA2 CONSTANT UUID := '12500000-0000-0000-0000-00000000c0a2';
BEGIN
  IF to_regprocedure('public.set_quote_customer_po(uuid, text)') IS NULL THEN
    r := pg_temp.link(A_OFFICE, '12500000-0000-0000-0000-00000000e0a3', 'quote', QA2, '5555', 'manual');
    IF r NOT LIKE '%"po_state": "no_quote_po_yet"%' THEN RAISE EXCEPTION 'FAIL 10 (no 123): %', r; END IF;
    RAISE NOTICE 'PASS 10 (123 not applied): linked; po_state no_quote_po_yet, no quote changed';
    RETURN;
  END IF;
  r := pg_temp.link(A_OFFICE, '12500000-0000-0000-0000-00000000e0a3', 'quote', QA2, '5555', 'manual');
  EXECUTE 'SELECT customer_po FROM public.quotes WHERE id = $1' INTO v_po USING QA2;
  IF r NOT LIKE '%"po_state": "written"%' OR v_po IS DISTINCT FROM '5555' THEN RAISE EXCEPTION 'FAIL 10 written: % / %', r, v_po; END IF;
  IF NOT EXISTS (SELECT 1 FROM security_audit.audit_log WHERE action = 'SET_CUSTOMER_PO' AND entity_id = QA2::TEXT AND actor_user_id = A_OFFICE) THEN RAISE EXCEPTION 'FAIL 10 123 audit'; END IF;
  -- Another e-mail with another PO for the same quote: linked, the quote keeps 5555.
  r := pg_temp.link(A_OFFICE, '12500000-0000-0000-0000-00000000e0a2', 'quote', QA2, '9999', 'manual');
  EXECUTE 'SELECT customer_po FROM public.quotes WHERE id = $1' INTO v_po USING QA2;
  IF r NOT LIKE '%"po_state": "kept_existing"%' OR v_po <> '5555' THEN RAISE EXCEPTION 'FAIL 10 kept: % / %', r, v_po; END IF;
  r := pg_temp.link(A_OFFICE, '12500000-0000-0000-0000-00000000e0a1', 'quote', QA2, 'po-5555', 'manual');
  IF r NOT LIKE '%"po_state": "already_set"%' THEN RAISE EXCEPTION 'FAIL 10 already: %', r; END IF;
  RAISE NOTICE 'PASS 10 (123 applied): PO written through set_quote_customer_po (its SET_CUSTOMER_PO audit); a different PO never overwrites it';
END $$;
-- 11. ChatGPT P1 conditions, against the real 123. Dedupe by message id: the inbox check storing a message it already holds (the same
--     Microsoft message id) adds no row, no RFQ, and leaves that e-mail's link and suggestions as they were. No automatic link ever: no
--     e-mail of either company is 'auto', and every linked e-mail was linked by a person's Link click (LINK_INBOUND_EMAIL, manual).
--     Never overwrite: a quote whose customer PO came another way (set_quote_customer_po, not from an e-mail) keeps it; a rejected
--     quote (123 refuses its PO) refuses the whole Link click and nothing changes.
DO $$
DECLARE r JSONB; t TEXT; v_po TEXT; e_before TEXT; n_rows BIGINT; n_rfq BIGINT;
  A_ADMIN CONSTANT UUID := '12500000-0000-0000-0000-0000000000a1'; A_OFFICE CONSTANT UUID := '12500000-0000-0000-0000-0000000000a2';
  ORG_A CONSTANT UUID := '12500000-0000-0000-0000-0000000000a0';
  EA1 CONSTANT UUID := '12500000-0000-0000-0000-00000000e0a1'; QA1 CONSTANT UUID := '12500000-0000-0000-0000-00000000c0a1';
  QR CONSTANT UUID := '12500000-0000-0000-0000-00000000c0a9';
BEGIN
  SELECT row_to_json(x)::TEXT INTO e_before FROM public.inbound_emails x WHERE id = EA1;
  SELECT count(*) INTO n_rows FROM public.inbound_emails WHERE organization_id = ORG_A;
  SELECT count(*) INTO n_rfq FROM public.rfqs WHERE organization_id = ORG_A;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', A_ADMIN, 'role', 'authenticated')::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', A_ADMIN::TEXT, true);
  SET LOCAL ROLE authenticated;
  r := public.record_inbound_email('p125-a1', NULL, 'buyer@acme.example', 'Buyer', 'PO 4471 for QUO-P125-1 (again)', now(), 'Our PO 4471.', 'Our PO 4471.');
  RESET ROLE;
  IF (r->>'inserted')::BOOLEAN IS NOT FALSE
     OR (SELECT count(*) FROM public.inbound_emails WHERE organization_id = ORG_A) <> n_rows
     OR (SELECT count(*) FROM public.inbound_emails WHERE organization_id = ORG_A AND graph_message_id = 'p125-a1') <> 1
     OR (SELECT count(*) FROM public.rfqs WHERE organization_id = ORG_A) <> n_rfq
     OR (SELECT row_to_json(x)::TEXT FROM public.inbound_emails x WHERE id = EA1) <> e_before THEN
    RAISE EXCEPTION 'FAIL 11 dedupe: %', r; END IF;
  IF EXISTS (SELECT 1 FROM public.inbound_emails WHERE organization_id IN (ORG_A, '12500000-0000-0000-0000-0000000000b0') AND link_status = 'auto')
     OR EXISTS (SELECT 1 FROM public.inbound_emails x WHERE x.organization_id = ORG_A AND (x.linked_quote_id IS NOT NULL OR x.linked_purchase_order_id IS NOT NULL)
                  AND (x.link_status <> 'manual' OR NOT EXISTS (SELECT 1 FROM security_audit.audit_log l WHERE l.action = 'LINK_INBOUND_EMAIL' AND l.entity_id = x.id::TEXT))) THEN
    RAISE EXCEPTION 'FAIL 11 auto link'; END IF;
  -- A PO set on the quote by hand first (123's own call), then an e-mail with another PO linked to it: kept_existing, the quote keeps it.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', A_OFFICE, 'role', 'authenticated')::TEXT, true);
  PERFORM set_config('request.jwt.claim.sub', A_OFFICE::TEXT, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.set_quote_customer_po('12500000-0000-0000-0000-000000001001', 'HAND-1');
  RESET ROLE;
  t := pg_temp.link(A_OFFICE, '12500000-0000-0000-0000-00000000e0a3', 'quote', '12500000-0000-0000-0000-000000001001', '5555', 'manual');
  SELECT customer_po INTO v_po FROM public.quotes WHERE id = '12500000-0000-0000-0000-000000001001';
  IF t NOT LIKE '%"po_state": "kept_existing"%' OR v_po <> 'HAND-1' THEN RAISE EXCEPTION 'FAIL 11 hand PO: % / %', t, v_po; END IF;
  INSERT INTO public.quotes (id, organization_id, quote_ref, customer, status) VALUES (QR, ORG_A, 'QUO-P125-R', 'Acme Ltd', 'rejected');
  SELECT row_to_json(x)::TEXT INTO e_before FROM public.inbound_emails x WHERE id = '12500000-0000-0000-0000-00000000e0a2';
  t := pg_temp.link(A_OFFICE, '12500000-0000-0000-0000-00000000e0a2', 'quote', QR, '8888', 'manual');
  IF t <> '22023/' OR (SELECT customer_po FROM public.quotes WHERE id = QR) IS NOT NULL
     OR (SELECT row_to_json(x)::TEXT FROM public.inbound_emails x WHERE id = '12500000-0000-0000-0000-00000000e0a2') <> e_before THEN
    RAISE EXCEPTION 'FAIL 11 rejected: %', t; END IF;
  RAISE NOTICE 'PASS 11 same message id again: inserted false, no new row or RFQ, its link and suggestions unchanged; no auto link anywhere, every link a person''s; a PO set by hand is kept; a rejected quote refuses the Link whole (22023)';
END $$;
ROLLBACK;

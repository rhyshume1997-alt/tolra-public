-- Local proof for migration 127 (reading the company's own Microsoft 365 inbox through the delegated connection). Run on a COPY of a
-- database with the chain applied plus 127:
--   createdb x -T <chain db>; psql -d x -f supabase/release/127_mailbox_read.release.sql; psql -d x -f this
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises FAIL.
\set ON_ERROR_STOP 1
BEGIN;
-- Two companies, A and B, each an admin and an office user, each connected to its own mailbox. C: connected before 127 (no Mail.Read).
INSERT INTO public.organizations (id, name, slug) VALUES
  ('12700000-0000-0000-0000-0000000000a0', 'Proof A', 't-proof-127-a'),
  ('12700000-0000-0000-0000-0000000000b0', 'Proof B', 't-proof-127-b'),
  ('12700000-0000-0000-0000-0000000000c0', 'Proof C', 't-proof-127-c');
INSERT INTO auth.users (id, email) VALUES
  ('12700000-0000-0000-0000-0000000000a1', 'admin.a@example.test'), ('12700000-0000-0000-0000-0000000000a2', 'office.a@example.test'),
  ('12700000-0000-0000-0000-0000000000b1', 'admin.b@example.test'), ('12700000-0000-0000-0000-0000000000c1', 'admin.c@example.test');
INSERT INTO public.user_profiles (id, email, role, organization_id) VALUES
  ('12700000-0000-0000-0000-0000000000a1', 'admin.a@example.test', 'admin', '12700000-0000-0000-0000-0000000000a0'),
  ('12700000-0000-0000-0000-0000000000a2', 'office.a@example.test', 'office', '12700000-0000-0000-0000-0000000000a0'),
  ('12700000-0000-0000-0000-0000000000b1', 'admin.b@example.test', 'admin', '12700000-0000-0000-0000-0000000000b0'),
  ('12700000-0000-0000-0000-0000000000c1', 'admin.c@example.test', 'admin', '12700000-0000-0000-0000-0000000000c0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id;
INSERT INTO public.organization_members (user_id, organization_id, role, hidden_sections) VALUES
  ('12700000-0000-0000-0000-0000000000a1', '12700000-0000-0000-0000-0000000000a0', 'admin', '{}'),
  ('12700000-0000-0000-0000-0000000000a2', '12700000-0000-0000-0000-0000000000a0', 'office', '{}'),
  ('12700000-0000-0000-0000-0000000000b1', '12700000-0000-0000-0000-0000000000b0', 'admin', '{}'),
  ('12700000-0000-0000-0000-0000000000c1', '12700000-0000-0000-0000-0000000000c0', 'admin', '{}');

-- As the service role (the server): run one statement, return 'ok:<text>' or '<sqlstate>/<hint>'.
CREATE FUNCTION pg_temp.svc(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_out TEXT; v_state TEXT; v_hint TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  SET LOCAL ROLE service_role;
  BEGIN
    EXECUTE p_sql INTO v_out;
    RESET ROLE;
    RETURN 'ok:' || coalesce(v_out, 'null');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    RESET ROLE;
    RETURN v_state || '/' || v_hint;
  END;
END $$;
-- As a signed-in person (or anon with p_user NULL).
CREATE FUNCTION pg_temp.as_user(p_user UUID, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_out TEXT; v_state TEXT; v_hint TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_user IS NULL THEN '{"role":"anon"}' ELSE json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::TEXT END, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_user::TEXT, ''), true);
  IF p_user IS NULL THEN SET LOCAL ROLE anon; ELSE SET LOCAL ROLE authenticated; END IF;
  BEGIN
    EXECUTE p_sql INTO v_out;
    RESET ROLE;
    RETURN 'ok:' || coalesce(v_out, 'null');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    RESET ROLE;
    RETURN v_state || '/' || v_hint;
  END;
END $$;
-- Connect a company to a mailbox the way the callback does (084's integration_store_connection, as the service role).
CREATE FUNCTION pg_temp.connect(p_org UUID, p_user UUID, p_mailbox TEXT) RETURNS TEXT LANGUAGE sql AS $$
  SELECT pg_temp.svc(format('SELECT public.integration_store_connection(%L, %L, ''microsoft'', %L, %L, NULL, ''v1.aaaa.bbbb.cccc'', ''v1.aaaa.bbbb.dddd'', now() + interval ''1 hour'', 1)::TEXT',
                            p_org, p_user, p_mailbox, p_mailbox || '@example.test'))
$$;
-- One message for a company through the server function.
CREATE FUNCTION pg_temp.rec(p_org UUID, p_id TEXT) RETURNS TEXT LANGUAGE sql AS $$
  SELECT pg_temp.svc(format('SELECT public.mailbox_record_inbound(%L, %L, NULL, ''buyer@example.test'', ''Buyer'', ''RFQ %s'', ''2026-11-01T09:00:00Z'', ''Please quote'', ''Body'')::TEXT', p_org, p_id, p_id))
$$;

DO $$
DECLARE
  A CONSTANT UUID := '12700000-0000-0000-0000-0000000000a0'; B CONSTANT UUID := '12700000-0000-0000-0000-0000000000b0';
  C CONSTANT UUID := '12700000-0000-0000-0000-0000000000c0';
  A_ADMIN CONSTANT UUID := '12700000-0000-0000-0000-0000000000a1'; A_OFFICE CONSTANT UUID := '12700000-0000-0000-0000-0000000000a2';
  B_ADMIN CONSTANT UUID := '12700000-0000-0000-0000-0000000000b1'; C_ADMIN CONSTANT UUID := '12700000-0000-0000-0000-0000000000c1';
  r TEXT; s public.integration_mailbox_sync%ROWTYPE; b_before TEXT; b_after TEXT; n INT;
BEGIN
  -- 1. The table and the server functions are closed to the API.
  IF has_table_privilege('authenticated', 'public.integration_mailbox_sync', 'SELECT') OR has_table_privilege('anon', 'public.integration_mailbox_sync', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL 1 table grant'; END IF;
  IF pg_temp.as_user(A_ADMIN, 'SELECT count(*)::TEXT FROM public.integration_mailbox_sync') NOT LIKE '42501/%' THEN RAISE EXCEPTION 'FAIL 1 admin reads table'; END IF;
  FOREACH r IN ARRAY ARRAY[format('SELECT public.mailbox_sync_connected(%L, ''mbx-a'', TRUE)::TEXT', A), format('SELECT count(*)::TEXT FROM public.mailbox_sync_due(%L)', A),
                           format('SELECT public.mailbox_sync_result(%L, NULL, NULL, now())::TEXT', A),
                           format('SELECT public.mailbox_record_inbound(%L, ''x'', NULL, NULL, NULL, NULL, now(), NULL, NULL)::TEXT', A)] LOOP
    IF pg_temp.as_user(A_ADMIN, r) NOT LIKE '42501/%' OR pg_temp.as_user(NULL, r) NOT LIKE '42501/%' THEN RAISE EXCEPTION 'FAIL 1 API may call: %', r; END IF;
  END LOOP;
  RAISE NOTICE 'PASS 1 integration_mailbox_sync and the four server functions are not reachable by anon or a signed-in admin';

  -- 2. Connect: A and B with Mail.Read, C before 127 (Mail.Send only: no sync row, or mail_read FALSE).
  IF pg_temp.connect(A, A_ADMIN, 'mbx-a') NOT LIKE 'ok:%' OR pg_temp.connect(B, B_ADMIN, 'mbx-b') NOT LIKE 'ok:%' OR pg_temp.connect(C, C_ADMIN, 'mbx-c') NOT LIKE 'ok:%' THEN
    RAISE EXCEPTION 'FAIL 2 connect'; END IF;
  r := pg_temp.svc(format('SELECT public.mailbox_sync_connected(%L, ''mbx-a'', TRUE)::TEXT', A));
  IF substr(r, 4)::JSONB <> '{"resumed": false, "mail_read": true}'::JSONB THEN RAISE EXCEPTION 'FAIL 2 A: %', r; END IF;
  IF pg_temp.svc(format('SELECT public.mailbox_sync_connected(%L, ''mbx-b'', TRUE)::TEXT', B)) NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 2 B'; END IF;
  -- Another company's mailbox, or a company not connected to it, is refused.
  IF pg_temp.svc(format('SELECT public.mailbox_sync_connected(%L, ''mbx-b'', TRUE)::TEXT', A)) <> 'P0002/not_connected' THEN RAISE EXCEPTION 'FAIL 2 other mailbox'; END IF;
  IF pg_temp.svc('SELECT public.mailbox_sync_connected(''12700000-0000-0000-0000-0000000000ff'', ''mbx-a'', TRUE)::TEXT') <> 'P0002/not_connected' THEN RAISE EXCEPTION 'FAIL 2 unknown org'; END IF;
  r := pg_temp.svc('SELECT string_agg(organization_id::TEXT, '','' ORDER BY organization_id) FROM public.mailbox_sync_due(NULL) WHERE organization_id::TEXT LIKE ''12700000%''');
  IF r <> format('ok:%s,%s', A, B) THEN RAISE EXCEPTION 'FAIL 2 due: %', r; END IF;
  IF pg_temp.svc(format('SELECT count(*)::TEXT FROM public.mailbox_sync_due(%L)', C)) <> 'ok:0' THEN RAISE EXCEPTION 'FAIL 2 C due'; END IF;
  RAISE NOTICE 'PASS 2 connect records Mail.Read for its own mailbox only; due lists A and B, not C (no Mail.Read yet)';

  -- 3. Isolation: a message recorded for A is A's only; the same Graph id for B is B's own row; C (no Mail.Read) and an unknown company refused.
  SELECT md5(coalesce(string_agg(row_to_json(x)::TEXT, '|' ORDER BY x.id), '')) INTO b_before FROM public.inbound_emails x WHERE x.organization_id = B;
  r := pg_temp.rec(A, 'msg-1');
  IF r NOT LIKE 'ok:{"rfq_id": "%", "inserted": true, %' THEN RAISE EXCEPTION 'FAIL 3 A insert: %', r; END IF;
  SELECT md5(coalesce(string_agg(row_to_json(x)::TEXT, '|' ORDER BY x.id), '')) INTO b_after FROM public.inbound_emails x WHERE x.organization_id = B;
  IF b_before <> b_after THEN RAISE EXCEPTION 'FAIL 3 B changed by A'; END IF;
  IF (SELECT count(*) FROM public.inbound_emails WHERE graph_message_id = 'msg-1') <> 1
     OR (SELECT organization_id FROM public.inbound_emails WHERE graph_message_id = 'msg-1') <> A
     OR (SELECT r2.organization_id FROM public.rfqs r2 JOIN public.inbound_emails e ON e.rfq_id = r2.id WHERE e.graph_message_id = 'msg-1') <> A
     OR (SELECT r2.created_by FROM public.rfqs r2 JOIN public.inbound_emails e ON e.rfq_id = r2.id WHERE e.graph_message_id = 'msg-1') <> A_ADMIN THEN
    RAISE EXCEPTION 'FAIL 3 A row'; END IF;
  r := pg_temp.rec(B, 'msg-1');
  IF r NOT LIKE 'ok:%"inserted": true%' OR (SELECT count(*) FROM public.inbound_emails WHERE graph_message_id = 'msg-1') <> 2 THEN RAISE EXCEPTION 'FAIL 3 B own: %', r; END IF;
  IF pg_temp.rec(C, 'msg-c') <> '42501/mailbox_not_readable' THEN RAISE EXCEPTION 'FAIL 3 C'; END IF;
  IF pg_temp.rec('12700000-0000-0000-0000-0000000000ff', 'msg-x') <> '42501/mailbox_not_readable' THEN RAISE EXCEPTION 'FAIL 3 unknown'; END IF;
  IF pg_temp.svc('SELECT public.mailbox_record_inbound(NULL, ''x'', NULL, NULL, NULL, NULL, now(), NULL, NULL)::TEXT') <> '42501/mailbox_not_readable' THEN RAISE EXCEPTION 'FAIL 3 null org'; END IF;
  -- A's admin sees A's message and not B's (031's RLS, unchanged); B's admin the reverse.
  IF pg_temp.as_user(A_ADMIN, format('SELECT count(*)::TEXT FROM public.inbound_emails WHERE organization_id = %L', B)) <> 'ok:0'
     OR pg_temp.as_user(A_ADMIN, 'SELECT count(*)::TEXT FROM public.inbound_emails WHERE graph_message_id = ''msg-1''') <> 'ok:1'
     OR pg_temp.as_user(B_ADMIN, format('SELECT count(*)::TEXT FROM public.inbound_emails WHERE organization_id = %L', A)) <> 'ok:0' THEN
    RAISE EXCEPTION 'FAIL 3 RLS'; END IF;
  RAISE NOTICE 'PASS 3 a message is written for the given company only (B untouched), one RFQ in that company; C and unknown refused; RLS unchanged';

  -- 4. Idempotent: the same page twice makes nothing new (no row, no RFQ), and 031's record_inbound_email agrees with it.
  n := (SELECT count(*) FROM public.rfqs WHERE organization_id = A);
  IF pg_temp.rec(A, 'msg-1') <> 'ok:{"rfq_id": null, "inserted": false, "inbound_email_id": null}' THEN RAISE EXCEPTION 'FAIL 4 repeat'; END IF;
  -- (one call per statement: SQL does not promise the order an OR is worked out in)
  r := pg_temp.rec(A, 'msg-2');
  IF r NOT LIKE 'ok:%"inserted": true%' THEN RAISE EXCEPTION 'FAIL 4 first: %', r; END IF;
  r := pg_temp.rec(A, 'msg-2');
  IF r NOT LIKE 'ok:%"inserted": false%' THEN RAISE EXCEPTION 'FAIL 4 second: %', r; END IF;
  r := pg_temp.as_user(A_ADMIN, 'SELECT public.record_inbound_email(''msg-2'', NULL, ''buyer@example.test'', NULL, ''RFQ'', ''2026-11-01T09:00:00Z'', '''', '''')::TEXT');
  IF r <> 'ok:{"rfq_id": null, "inserted": false, "inbound_email_id": null}' THEN RAISE EXCEPTION 'FAIL 4 031 path: %', r; END IF;
  IF (SELECT count(*) FROM public.inbound_emails WHERE organization_id = A) <> 2 OR (SELECT count(*) FROM public.rfqs WHERE organization_id = A) <> n + 1 THEN
    RAISE EXCEPTION 'FAIL 4 counts'; END IF;
  RAISE NOTICE 'PASS 4 re-reading the same messages adds 0 rows and 0 RFQs, through either function';

  -- 5. The cursor: a good check moves it on (never backwards) and clears failures; failures count up and leave it; codes only.
  PERFORM pg_temp.svc(format('SELECT public.mailbox_sync_result(%L, NULL, ''https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=1'', ''2026-11-01T09:00:00Z'')::TEXT', A));
  PERFORM pg_temp.svc(format('SELECT public.mailbox_sync_result(%L, NULL, NULL, ''2026-10-01T09:00:00Z'')::TEXT', A));
  SELECT * INTO s FROM public.integration_mailbox_sync WHERE organization_id = A;
  IF s.checkpoint <> '2026-11-01T09:00:00Z' OR s.next_link IS NOT NULL OR s.last_sync_at IS NULL OR s.error_count <> 0 THEN RAISE EXCEPTION 'FAIL 5 good: %', row_to_json(s); END IF;
  PERFORM pg_temp.svc(format('SELECT public.mailbox_sync_result(%L, ''busy'', NULL, NULL)::TEXT', A));
  PERFORM pg_temp.svc(format('SELECT public.mailbox_sync_result(%L, ''unavailable'', NULL, NULL)::TEXT', A));
  SELECT * INTO s FROM public.integration_mailbox_sync WHERE organization_id = A;
  IF s.error_count <> 2 OR s.last_error <> 'unavailable' OR s.checkpoint <> '2026-11-01T09:00:00Z' OR NOT s.mail_read THEN RAISE EXCEPTION 'FAIL 5 failed: %', row_to_json(s); END IF;
  IF pg_temp.svc(format('SELECT public.mailbox_sync_result(%L, ''Bearer eyJ0eXAi secret body'', NULL, NULL)::TEXT', A)) NOT LIKE '23514/%' THEN RAISE EXCEPTION 'FAIL 5 free text accepted'; END IF;
  IF pg_temp.svc(format('SELECT public.mailbox_sync_result(%L, NULL, ''https://evil.example/next'', NULL)::TEXT', A)) NOT LIKE '23514/%' THEN RAISE EXCEPTION 'FAIL 5 foreign link'; END IF;
  -- A result for A never touches B.
  IF (SELECT error_count FROM public.integration_mailbox_sync WHERE organization_id = B) <> 0 THEN RAISE EXCEPTION 'FAIL 5 B touched'; END IF;
  RAISE NOTICE 'PASS 5 cursor moves forward only, failures counted with a fixed code (free text and foreign links refused), B untouched';

  -- 6. The card: admins see their own company's status only (never the cursor); office and anon refused.
  r := pg_temp.as_user(A_ADMIN, 'SELECT public.mailbox_sync_status()::TEXT');
  IF r NOT LIKE 'ok:%' OR (substr(r, 4)::JSONB - 'last_sync_at') <> '{"last_error": "unavailable", "mail_read": true, "error_count": 2}'::JSONB
     OR substr(r, 4)::JSONB ->> 'last_sync_at' IS NULL OR r LIKE '%next_link%' OR r LIKE '%checkpoint%' OR r LIKE '%mbx-%' THEN RAISE EXCEPTION 'FAIL 6 A: %', r; END IF;
  r := pg_temp.as_user(B_ADMIN, 'SELECT public.mailbox_sync_status()::TEXT');
  IF r NOT LIKE 'ok:%' OR (substr(r, 4)::JSONB - 'last_sync_at') <> '{"last_error": null, "mail_read": true, "error_count": 0}'::JSONB THEN RAISE EXCEPTION 'FAIL 6 B: %', r; END IF;
  r := pg_temp.as_user(C_ADMIN, 'SELECT public.mailbox_sync_status()::TEXT');
  IF r NOT LIKE 'ok:%' OR substr(r, 4)::JSONB <> '{"last_error": null, "mail_read": false, "error_count": 0, "last_sync_at": null}'::JSONB THEN RAISE EXCEPTION 'FAIL 6 C: %', r; END IF;
  IF pg_temp.as_user(A_OFFICE, 'SELECT public.mailbox_sync_status()::TEXT') NOT LIKE '42501/%' OR pg_temp.as_user(NULL, 'SELECT public.mailbox_sync_status()::TEXT') NOT LIKE '42501/%' THEN RAISE EXCEPTION 'FAIL 6 refused'; END IF;
  RAISE NOTICE 'PASS 6 status: own company only, no cursor or mailbox id; C reads mail_read false (Reconnect to allow reading mail); office and anon refused';

  -- 7. Expired consent: needs_reconnect stops the checks (due empty, record refused); sending state is 084's (unchanged here).
  PERFORM pg_temp.svc(format('SELECT public.integration_mark_needs_reconnect(%L, ''microsoft'', ''refused'')::TEXT', A));
  PERFORM pg_temp.svc(format('SELECT public.mailbox_sync_result(%L, ''reconnect'', NULL, NULL)::TEXT', A));
  IF pg_temp.svc(format('SELECT count(*)::TEXT FROM public.mailbox_sync_due(%L)', A)) <> 'ok:0' OR pg_temp.rec(A, 'msg-3') <> '42501/mailbox_not_readable' THEN RAISE EXCEPTION 'FAIL 7 still polled'; END IF;
  IF pg_temp.svc(format('SELECT count(*)::TEXT FROM public.mailbox_sync_due(%L)', B)) <> 'ok:1' THEN RAISE EXCEPTION 'FAIL 7 B stopped too'; END IF;
  -- Reconnect to the same mailbox: the cursor is kept, the failure cleared, checks resume; the messages already stored are skipped.
  IF pg_temp.connect(A, A_ADMIN, 'mbx-a') NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 7 reconnect'; END IF;
  r := pg_temp.svc(format('SELECT public.mailbox_sync_connected(%L, ''mbx-a'', TRUE)::TEXT', A));
  SELECT * INTO s FROM public.integration_mailbox_sync WHERE organization_id = A;
  IF substr(r, 4)::JSONB <> '{"resumed": true, "mail_read": true}'::JSONB OR s.checkpoint <> '2026-11-01T09:00:00Z' OR s.error_count <> 0 OR s.last_error IS NOT NULL THEN RAISE EXCEPTION 'FAIL 7 resume: % %', r, row_to_json(s); END IF;
  IF pg_temp.svc(format('SELECT checkpoint::TEXT FROM public.mailbox_sync_due(%L)', A)) <> 'ok:2026-11-01 09:00:00+00' THEN RAISE EXCEPTION 'FAIL 7 due after'; END IF;
  r := pg_temp.rec(A, 'msg-1');
  IF r NOT LIKE 'ok:%"inserted": false%' THEN RAISE EXCEPTION 'FAIL 7 dedupe after resume: %', r; END IF;
  r := pg_temp.rec(A, 'msg-3');
  IF r NOT LIKE 'ok:%"inserted": true%' THEN RAISE EXCEPTION 'FAIL 7 new after resume: %', r; END IF;
  RAISE NOTICE 'PASS 7 needs_reconnect stops A only; reconnecting the same mailbox resumes from the cursor with no duplicates';

  -- 8. Microsoft refuses reading (403 consent): mail_read clears, checks stop, the card asks to reconnect; sending is not touched.
  PERFORM pg_temp.svc(format('SELECT public.mailbox_sync_result(%L, ''consent'', NULL, NULL)::TEXT', B));
  IF pg_temp.svc(format('SELECT count(*)::TEXT FROM public.mailbox_sync_due(%L)', B)) <> 'ok:0'
     OR (SELECT status FROM public.integration_connections WHERE organization_id = B AND provider = 'microsoft') <> 'connected' THEN RAISE EXCEPTION 'FAIL 8'; END IF;
  -- C allows Mail.Read by reconnecting: it joins the checks.
  PERFORM pg_temp.svc(format('SELECT public.mailbox_sync_connected(%L, ''mbx-c'', TRUE)::TEXT', C));
  IF pg_temp.svc(format('SELECT count(*)::TEXT FROM public.mailbox_sync_due(%L)', C)) <> 'ok:1' THEN RAISE EXCEPTION 'FAIL 8 C'; END IF;
  RAISE NOTICE 'PASS 8 a consent refusal stops reading only (connection stays connected); C reconnecting with Mail.Read joins';

  -- 9. A different mailbox after a disconnect starts afresh (the old cursor belongs to the old mailbox).
  UPDATE public.integration_connections SET status = 'disconnected' WHERE organization_id = A AND provider = 'microsoft';
  IF pg_temp.svc(format('SELECT count(*)::TEXT FROM public.mailbox_sync_due(%L)', A)) <> 'ok:0' THEN RAISE EXCEPTION 'FAIL 9 disconnected polled'; END IF;
  IF pg_temp.connect(A, A_ADMIN, 'mbx-a2') NOT LIKE 'ok:%' THEN RAISE EXCEPTION 'FAIL 9 connect'; END IF;
  IF pg_temp.svc(format('SELECT count(*)::TEXT FROM public.mailbox_sync_due(%L)', A)) <> 'ok:0' THEN RAISE EXCEPTION 'FAIL 9 old cursor used for new mailbox'; END IF;
  r := pg_temp.svc(format('SELECT public.mailbox_sync_connected(%L, ''mbx-a2'', TRUE)::TEXT', A));
  SELECT * INTO s FROM public.integration_mailbox_sync WHERE organization_id = A;
  IF substr(r, 4)::JSONB <> '{"resumed": false, "mail_read": true}'::JSONB OR s.checkpoint IS NOT NULL OR s.next_link IS NOT NULL THEN RAISE EXCEPTION 'FAIL 9 fresh: %', row_to_json(s); END IF;
  RAISE NOTICE 'PASS 9 disconnected is not polled; a new mailbox starts with no cursor';

  -- 10. The throttle (mailbox_sync_claim): one real check per company per interval, whatever the number of callers; the API can't call it.
  -- (Two callers at the same moment, on two connections: tests/scripts/mailbox-claim-127.race.sh.)
  r := pg_temp.svc(format('SELECT public.mailbox_sync_claim(%L, 90)::TEXT', A));
  IF substr(r, 4)::JSONB ->> 'state' <> 'claimed' OR substr(r, 4)::JSONB ? 'last_error' THEN RAISE EXCEPTION 'FAIL 10 first claim: %', r; END IF;
  r := pg_temp.svc(format('SELECT public.mailbox_sync_claim(%L, 90)::TEXT', A));
  IF substr(r, 4)::JSONB ->> 'state' <> 'recent' OR r LIKE '%next_link%' OR r LIKE '%checkpoint%' THEN RAISE EXCEPTION 'FAIL 10 second claim: %', r; END IF;
  -- B's claim is B's own: A's claim does not throttle B.
  PERFORM pg_temp.svc(format('SELECT public.mailbox_sync_connected(%L, ''mbx-b'', TRUE)::TEXT', B));
  r := pg_temp.svc(format('SELECT public.mailbox_sync_claim(%L, 90)::TEXT', B));
  IF substr(r, 4)::JSONB ->> 'state' <> 'claimed' THEN RAISE EXCEPTION 'FAIL 10 B throttled by A: %', r; END IF;
  -- Once the interval has passed, a claim starts a check again (a check that never finished holds nothing).
  UPDATE public.integration_mailbox_sync SET claimed_at = now() - interval '91 seconds' WHERE organization_id = A;
  r := pg_temp.svc(format('SELECT public.mailbox_sync_claim(%L, 90)::TEXT', A));
  IF substr(r, 4)::JSONB ->> 'state' <> 'claimed' THEN RAISE EXCEPTION 'FAIL 10 after interval: %', r; END IF;
  -- A company whose mailbox can't be read is never claimed: needs_reconnect, no Mail.Read, unknown.
  PERFORM pg_temp.svc(format('SELECT public.integration_mark_needs_reconnect(%L, ''microsoft'', ''refused'')::TEXT', C));
  IF pg_temp.svc(format('SELECT public.mailbox_sync_claim(%L, 90)::TEXT', C)) <> 'ok:{"state": "not_readable"}'
     OR pg_temp.svc('SELECT public.mailbox_sync_claim(''12700000-0000-0000-0000-0000000000ff'', 90)::TEXT') <> 'ok:{"state": "not_readable"}' THEN RAISE EXCEPTION 'FAIL 10 not readable'; END IF;
  IF (SELECT claimed_at FROM public.integration_mailbox_sync WHERE organization_id = C) IS NOT NULL THEN RAISE EXCEPTION 'FAIL 10 C claimed'; END IF;
  IF pg_temp.svc(format('SELECT public.mailbox_sync_claim(%L, -1)::TEXT', A)) NOT LIKE '22023/%' OR pg_temp.svc('SELECT public.mailbox_sync_claim(NULL, 90)::TEXT') NOT LIKE '22023/%' THEN RAISE EXCEPTION 'FAIL 10 bad args'; END IF;
  r := format('SELECT public.mailbox_sync_claim(%L, 0)::TEXT', A);
  IF pg_temp.as_user(A_ADMIN, r) NOT LIKE '42501/%' OR pg_temp.as_user(A_OFFICE, r) NOT LIKE '42501/%' OR pg_temp.as_user(NULL, r) NOT LIKE '42501/%' THEN RAISE EXCEPTION 'FAIL 10 API may claim'; END IF;
  RAISE NOTICE 'PASS 10 claim: once per interval per company (B separate), again after it; never for an unreadable company; not callable through the API';
END
$$;
ROLLBACK;

-- Local proof for migration 128 (Settings > Workshop network: rename; refused clock actions recorded for the banner). Run on a COPY of a
-- database with 000..122 applied, plus 128:
--   createdb m_wn128 -T <base>; psql -d m_wn128 -f supabase/release/128_workshop_network.release.sql
--   psql -d m_wn128 -f tests/scripts/workshop-network-128.proof.sql
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises (ON_ERROR_STOP). The request's address is what
-- PostgREST puts in request.headers (cf-connecting-ip); set here with set_config, as the 114 proof and the db tests do.
-- Also run in CI by tests/db/workshop-network-128.test.ts, which drops the psql meta-commands (the lines starting with a backslash).
\set ON_ERROR_STOP 1
\set QUIET 1
\o /dev/null
BEGIN;
-- Two companies. A: admin, office, w1 (the default: no exception), w2 (allowed off site while locked). B: admin.
INSERT INTO public.organizations (id, name, slug) VALUES
  ('12800000-0000-0000-0000-0000000000a0', 'Net A', 't-net128-a'), ('12800000-0000-0000-0000-0000000000b0', 'Net B', 't-net128-b');
INSERT INTO auth.users (id, email) VALUES
  ('12800000-0000-0000-0000-00000000a001', 'net128.admin.a@example.test'), ('12800000-0000-0000-0000-00000000a003', 'net128.office.a@example.test'),
  ('12800000-0000-0000-0000-00000000a004', 'net128.w1.a@example.test'), ('12800000-0000-0000-0000-00000000a005', 'net128.w2.a@example.test'),
  ('12800000-0000-0000-0000-00000000b001', 'net128.admin.b@example.test');
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id) VALUES
  ('12800000-0000-0000-0000-00000000a001', 'net128.admin.a@example.test', 'Admin A', 'admin', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000a003', 'net128.office.a@example.test', 'Office A', 'office', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000a004', 'net128.w1.a@example.test', 'Worker One', 'workshop', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000a005', 'net128.w2.a@example.test', 'Worker Two', 'workshop', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000b001', 'net128.admin.b@example.test', 'Admin B', 'admin', '12800000-0000-0000-0000-0000000000b0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, full_name = EXCLUDED.full_name;
INSERT INTO public.organization_members (user_id, organization_id, role) VALUES
  ('12800000-0000-0000-0000-00000000a001', '12800000-0000-0000-0000-0000000000a0', 'admin'),
  ('12800000-0000-0000-0000-00000000a003', '12800000-0000-0000-0000-0000000000a0', 'office'),
  ('12800000-0000-0000-0000-00000000a004', '12800000-0000-0000-0000-0000000000a0', 'workshop'),
  ('12800000-0000-0000-0000-00000000a005', '12800000-0000-0000-0000-0000000000a0', 'workshop'),
  ('12800000-0000-0000-0000-00000000b001', '12800000-0000-0000-0000-0000000000b0', 'admin')
ON CONFLICT DO NOTHING;

-- Sign in as a person (aal given), from an address (NULL = no client address header, e.g. not through the API gateway).
CREATE FUNCTION pg_temp.sign_in(p_user TEXT, p_ip TEXT DEFAULT NULL, p_aal TEXT DEFAULT 'aal2', p_xff TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('role', 'none', TRUE),
         set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::TEXT, TRUE),
         set_config('request.jwt.claim.sub', p_user, TRUE),
         set_config('request.headers', CASE WHEN p_ip IS NULL AND p_xff IS NULL THEN '{}'
                                            ELSE json_strip_nulls(json_build_object('cf-connecting-ip', p_ip, 'x-forwarded-for', p_xff))::TEXT END, TRUE),
         set_config('role', 'authenticated', TRUE);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.sign_in(TEXT, TEXT, TEXT, TEXT) TO authenticated;
CREATE FUNCTION pg_temp.expect_refused(p_sql TEXT, p_label TEXT, p_hint TEXT, p_like TEXT DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_msg TEXT; v_state TEXT; v_hint TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
    IF (p_hint IS NOT NULL AND v_hint IS DISTINCT FROM p_hint) OR (p_like IS NOT NULL AND v_msg NOT ILIKE p_like) THEN
      RAISE EXCEPTION 'FAIL % refused for the wrong reason: % % [%]', p_label, v_state, v_msg, v_hint;
    END IF;
    RAISE NOTICE 'PASS % refused (% %: %)', p_label, v_state, v_hint, v_msg;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % was allowed', p_label;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect_refused(TEXT, TEXT, TEXT, TEXT) TO authenticated;
CREATE FUNCTION pg_temp.ok(p_cond BOOLEAN, p_label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'FAIL %', p_label; END IF;
  RAISE NOTICE 'PASS %', p_label;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.ok(BOOLEAN, TEXT) TO authenticated;
-- A clock action as the signed-in person; returns the event id.
CREATE FUNCTION pg_temp.clock(p_action TEXT, p_at TIMESTAMPTZ DEFAULT NULL) RETURNS UUID LANGUAGE sql AS $$
  SELECT (public.record_attendance_event(gen_random_uuid(), p_action, p_at, 'Proof phone') ->> 'event_id')::UUID
$$;
GRANT EXECUTE ON FUNCTION pg_temp.clock(TEXT, TIMESTAMPTZ) TO authenticated;
CREATE TEMP TABLE proof_ids (k TEXT PRIMARY KEY, id UUID);
GRANT ALL ON proof_ids TO authenticated;

-- 1. Rename (admin, two-step, keyed, audited). Company A saves its workshop network the one-click way (the request's address), B too.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
INSERT INTO proof_ids VALUES ('netA', (public.add_site_network(gen_random_uuid(), NULL, 'Workshop') ->> 'id')::UUID);
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000b001', '198.51.100.20');
INSERT INTO proof_ids VALUES ('netB', (public.add_site_network(gen_random_uuid(), NULL, 'B yard') ->> 'id')::UUID);
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
DO $$ DECLARE r JSONB; BEGIN
  r := public.rename_site_network('12800000-0000-0000-0000-00000000c001', (SELECT id FROM proof_ids WHERE k = 'netA'), '  Main workshop  ');
  PERFORM pg_temp.ok(r ->> 'label' = 'Main workshop' AND (r ->> 'renamed')::BOOLEAN AND NOT (r ->> 'replayed')::BOOLEAN
                     AND r ->> 'network' = '203.0.113.7/32', '1a admin renames, the name trimmed, the address unchanged: ' || r::TEXT);
  r := public.rename_site_network('12800000-0000-0000-0000-00000000c001', (SELECT id FROM proof_ids WHERE k = 'netA'), 'Main workshop');
  PERFORM pg_temp.ok((r ->> 'replayed')::BOOLEAN AND (r ->> 'renamed')::BOOLEAN AND r ->> 'label' = 'Main workshop', '1b the same key and request again: the first answer (replayed)');
END $$;
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network('12800000-0000-0000-0000-00000000c001', (SELECT id FROM proof_ids WHERE k = 'netA'), 'Other name')$$,
                              '1c the same key for another name', 'client_op_reused');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(NULL, (SELECT id FROM proof_ids WHERE k = 'netA'), 'No key')$$, '1d no key', 'client_op_missing');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), '   ')$$, '1e a blank name', 'bad_label');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), NULL)$$, '1f no name', 'bad_label');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), repeat('x', 61))$$, '1g 61 characters', 'bad_label');
SELECT pg_temp.ok((public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), repeat('y', 60)) ->> 'label') = repeat('y', 60), '1h 60 characters: saved');
DO $$ DECLARE r JSONB; BEGIN
  r := public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Main workshop');
  r := public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Main workshop');
  PERFORM pg_temp.ok(NOT (r ->> 'renamed')::BOOLEAN, '1i the same name under a new key: nothing changes, not audited');
END $$;
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), gen_random_uuid(), 'Ghost')$$, '1j an unknown network', 'network_missing');
-- Not the admin: office, workshop.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a003', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Office try')$$, '1k office renames', 'admin_only');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Workshop try')$$, '1l workshop renames', 'admin_only');
-- Another company: B's admin can't rename A's network (not found in B), and A's can't rename B's.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000b001', '198.51.100.20');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Hijack')$$, '1m company B renames A''s network', 'network_missing');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netB'), 'Hijack')$$, '1n company A renames B''s network', 'network_missing');
-- The admin before the second step, where the company requires it.
RESET ROLE;
SET LOCAL session_replication_role = replica;
UPDATE public.organizations SET require_admin_mfa = TRUE WHERE id = '12800000-0000-0000-0000-0000000000a0';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7', 'aal1');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Before two-step')$$, '1o admin at aal1 (two-step required)', 'mfa_required');
RESET ROLE;
SELECT pg_temp.ok((SELECT label = 'Main workshop' AND network = '203.0.113.7/32' FROM public.site_networks WHERE id = (SELECT id FROM proof_ids WHERE k = 'netA')),
                  '1p A''s network: the last saved name, the same address');
SELECT pg_temp.ok((SELECT label = 'B yard' FROM public.site_networks WHERE id = (SELECT id FROM proof_ids WHERE k = 'netB')), '1q B''s network untouched');
SELECT pg_temp.ok((SELECT count(*) = 3 FROM security_audit.audit_log WHERE organization_id = '12800000-0000-0000-0000-0000000000a0' AND action = 'SITE_NETWORK_RENAMED'
                   AND entity_id = (SELECT id::TEXT FROM proof_ids WHERE k = 'netA') AND metadata ->> 'network' = '203.0.113.7/32')
                  AND EXISTS (SELECT 1 FROM security_audit.audit_log WHERE organization_id = '12800000-0000-0000-0000-0000000000a0' AND action = 'SITE_NETWORK_RENAMED'
                              AND metadata ->> 'before' = 'Workshop' AND metadata ->> 'after' = 'Main workshop'),
                  '1r audited once per real change (3), none for the replay or the unchanged name');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM security_audit.audit_log WHERE organization_id = '12800000-0000-0000-0000-0000000000b0' AND action = 'SITE_NETWORK_RENAMED'),
                  '1s nothing audited in B');
SELECT pg_temp.ok((SELECT count(*) = 4 FROM public.site_network_ops WHERE organization_id = '12800000-0000-0000-0000-0000000000a0' AND kind = 'rename'),
                  '1t four keyed rename saves kept in A (refused calls keep none)');

-- 2. Refused clock actions reach the record. A locks clock-in to 203.0.113.7 (114); w2 may clock in off site.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT public.lock_clock_in_network();
SELECT public.set_clock_in_off_site_allowed('12800000-0000-0000-0000-00000000a005', TRUE);
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '198.51.100.9');
SELECT pg_temp.expect_refused($$SELECT public.record_attendance_event('12800000-0000-0000-0000-00000000d001', 'in', NULL, 'Proof phone')$$,
                              '2a w1 clock in from another address: refused by 114, nothing stored', 'clock_in_network_locked');
DO $$ DECLARE r JSONB; BEGIN
  r := public.record_clock_in_refusal('12800000-0000-0000-0000-00000000d001', 'in');
  PERFORM pg_temp.ok((r ->> 'recorded')::BOOLEAN AND NOT (r ->> 'replayed')::BOOLEAN AND r ->> 'status' = 'refused_unrecognised' AND NOT r ? 'ip',
                     '2b the device reports it: recorded, refused_unrecognised; the answer holds no address');
  r := public.record_clock_in_refusal('12800000-0000-0000-0000-00000000d001', 'in');
  PERFORM pg_temp.ok((r ->> 'replayed')::BOOLEAN, '2c reported again under the same key: the first record (replayed)');
END $$;
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal('12800000-0000-0000-0000-00000000d001', 'out')$$, '2d the same key for another action', 'client_op_reused');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal(gen_random_uuid(), 'lunch')$$, '2e an unknown action', 'bad_action');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal(NULL, 'in')$$, '2f no key', 'client_op_missing');
-- The database decides: nothing is recorded when 114 would not refuse this request.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal(gen_random_uuid(), 'in')$$, '2g w1 from the locked address', 'not_refused');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', NULL, 'aal2', '198.51.100.9');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal(gen_random_uuid(), 'in')$$, '2h w1 with no client address (x-forwarded-for only)', 'not_refused');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a005', '198.51.100.9');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal(gen_random_uuid(), 'in')$$, '2i w2 (allowed off site)', 'not_refused');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000b001', '198.51.100.9');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal(gen_random_uuid(), 'in')$$, '2j company B (unlocked)', 'not_refused');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT public.record_attendance_event('12800000-0000-0000-0000-00000000d002', 'in', NULL, 'Proof phone');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '198.51.100.9');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal('12800000-0000-0000-0000-00000000d002', 'in')$$, '2k a key the server recorded as a clock action', 'op_applied');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 1 AND bool_and(ip = '198.51.100.9'::INET AND user_id = '12800000-0000-0000-0000-00000000a004' AND action = 'in' AND status = 'refused_unrecognised')
                   FROM public.clock_in_network_refusals WHERE organization_id = '12800000-0000-0000-0000-0000000000a0'),
                  '2l exactly one refusal row in A: w1, in, with the request''s address');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_refusals WHERE organization_id = '12800000-0000-0000-0000-0000000000b0'), '2m none in B');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.organization_id = '12800000-0000-0000-0000-0000000000a0' AND to_jsonb(a)::TEXT LIKE '%198.51.100.9%'),
                  '2n the refused address is nowhere in the audit log');

-- 3. Read rules: the company's admin only. The banner's 7-day count (lib/site-network.ts loadUnrecognisedClockActions) includes it.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.clock_in_network_refusals WHERE status = 'refused_unrecognised' AND attempted_at >= now() - INTERVAL '7 days'),
                  '3a admin A: the refused attempt is there for the banner');
SELECT pg_temp.ok((SELECT count(*) FROM public.attendance_event_networks WHERE status = 'off_site' AND checked_at >= now() - INTERVAL '7 days')
                  + (SELECT count(*) FROM public.clock_in_network_refusals WHERE attempted_at >= now() - INTERVAL '7 days') = 1,
                  '3b the banner total (Flag off_site checks + refused attempts) is 1');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a003', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_refusals), '3c office A reads none');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_refusals), '3d w1 reads none (not even their own)');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000b001', '198.51.100.20');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_refusals), '3e admin B reads none of A''s');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.expect_refused($$INSERT INTO public.clock_in_network_refusals (organization_id, user_id, client_op_id, action)
                                VALUES ('12800000-0000-0000-0000-0000000000a0', '12800000-0000-0000-0000-00000000a004', gen_random_uuid(), 'in')$$, '3f admin direct insert', NULL, '%permission denied%');
SELECT pg_temp.expect_refused($$UPDATE public.clock_in_network_refusals SET ip = NULL$$, '3g admin direct update', NULL, '%permission denied%');
SELECT pg_temp.expect_refused($$DELETE FROM public.clock_in_network_refusals$$, '3h admin direct delete', NULL, '%permission denied%');

-- 4. The brake: at most 30 reports per person per hour.
RESET ROLE;
INSERT INTO public.clock_in_network_refusals (organization_id, user_id, client_op_id, action, ip)
SELECT '12800000-0000-0000-0000-0000000000a0', '12800000-0000-0000-0000-00000000a004', gen_random_uuid(), 'out', '198.51.100.9' FROM generate_series(1, 29);
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '198.51.100.9');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal(gen_random_uuid(), 'out')$$, '4a the 31st report in an hour', 'too_many_refusals');
SELECT pg_temp.ok((public.record_clock_in_refusal('12800000-0000-0000-0000-00000000d001', 'in') ->> 'replayed')::BOOLEAN, '4b a replay is still answered past the brake');

-- 5. The same retention and purge as every clock-in address (078's 30 days): the cron's site_network_ip_purge, a report, the admin buttons.
RESET ROLE;
UPDATE public.clock_in_network_refusals SET attempted_at = now() - INTERVAL '31 days' WHERE organization_id = '12800000-0000-0000-0000-0000000000a0' AND action = 'out';
UPDATE public.clock_in_network_refusals SET attempted_at = now() - INTERVAL '29 days' WHERE client_op_id = '12800000-0000-0000-0000-00000000d001';
SET LOCAL ROLE service_role;
SELECT pg_temp.ok(public.site_network_ip_purge('12800000-0000-0000-0000-0000000000a0', 10) = 10, '5a the cron''s call (service role), limit 10: 10 cleared');
SELECT pg_temp.ok(public.site_network_ip_purge('12800000-0000-0000-0000-0000000000a0', 500) = 19, '5b the next call: the other 19');
SELECT pg_temp.ok(public.site_network_ip_purge('12800000-0000-0000-0000-0000000000a0', 500) = 0, '5c again: nothing left to clear');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 29 AND bool_and(ip IS NULL) FROM public.clock_in_network_refusals WHERE organization_id = '12800000-0000-0000-0000-0000000000a0' AND action = 'out'),
                  '5d the 29 old refusals stay, without their address');
SELECT pg_temp.ok((SELECT ip = '198.51.100.9'::INET FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000d001'),
                  '5e the 29-day-old one keeps its address');
-- A report clears the company's expired addresses first.
INSERT INTO public.clock_in_network_refusals (organization_id, user_id, client_op_id, action, ip, attempted_at)
VALUES ('12800000-0000-0000-0000-0000000000a0', '12800000-0000-0000-0000-00000000a005', '12800000-0000-0000-0000-00000000d003', 'break_end', '198.51.100.77', now() - INTERVAL '40 days');
DELETE FROM public.clock_in_network_refusals WHERE organization_id = '12800000-0000-0000-0000-0000000000a0' AND action = 'out';
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '198.51.100.10');
SELECT pg_temp.ok((public.record_clock_in_refusal(gen_random_uuid(), 'break_start') ->> 'recorded')::BOOLEAN, '5f a new report is recorded');
RESET ROLE;
SELECT pg_temp.ok((SELECT ip IS NULL FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000d003'),
                  '5g ... and the 40-day-old address was cleared first');
-- The admin's Delete expired (p_all false) and Delete all (p_all true).
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.ok((public.purge_site_network_ips(FALSE) ->> 'removed')::INT = 0, '5h admin Delete expired: none left to clear');
SELECT pg_temp.ok((public.purge_site_network_ips(TRUE) ->> 'removed')::INT = 2, '5i admin Delete all: the 2 kept refusal addresses cleared');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 3 AND bool_and(ip IS NULL) FROM public.clock_in_network_refusals WHERE organization_id = '12800000-0000-0000-0000-0000000000a0'),
                  '5j every A refusal row kept, no address');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM security_audit.audit_log WHERE organization_id = '12800000-0000-0000-0000-0000000000a0' AND action = 'SITE_NETWORK_IPS_PURGED'
                   AND (metadata ->> 'removed')::INT = 2), '5k Delete all audited with the count only');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000b001', '198.51.100.20');
SELECT pg_temp.ok((public.purge_site_network_ips(TRUE) ->> 'removed')::INT = 0, '5l company B''s Delete all clears nothing of A');

\o
SELECT 'workshop network 128: all checks passed' AS result;
ROLLBACK;

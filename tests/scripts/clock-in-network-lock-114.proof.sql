-- Local proof for migration 114 (lock clock-in to the workshop network, M27). Run on a COPY of a database with 000..101 applied, plus 114:
--   createdb m_iplock -T sec_base; node scripts/release-sql.mjs supabase/migrations/114_clock_in_network_lock.sql | psql -d m_iplock
--   psql -d m_iplock -f tests/scripts/clock-in-network-lock-114.proof.sql
-- Everything runs in one transaction that is rolled back. Each check prints PASS or raises (ON_ERROR_STOP).
-- The request's address is what PostgREST puts in request.headers (cf-connecting-ip); set here with set_config, as the db tests do.
-- Also run in CI by tests/db/clock-in-network-lock-114.test.ts, which drops the psql meta-commands (the lines starting with a backslash).
\set ON_ERROR_STOP 1
\set QUIET 1
\o /dev/null
BEGIN;
-- Two companies. A: admin, office, w1 (the default: no exception), w2 (allowed off site while locked). B: admin.
-- THE LOCK COVERS EVERYONE: only 114's own exception lets a person clock in off site; 075's On site only flag is not consulted.
INSERT INTO public.organizations (id, name, slug) VALUES
  ('11400000-0000-0000-0000-0000000000a0', 'Lock A', 't-lock114-a'), ('11400000-0000-0000-0000-0000000000b0', 'Lock B', 't-lock114-b');
INSERT INTO auth.users (id, email) VALUES
  ('11400000-0000-0000-0000-00000000a001', 'lock114.admin.a@example.test'), ('11400000-0000-0000-0000-00000000a003', 'lock114.office.a@example.test'),
  ('11400000-0000-0000-0000-00000000a004', 'lock114.w1.a@example.test'), ('11400000-0000-0000-0000-00000000a005', 'lock114.w2.a@example.test'),
  ('11400000-0000-0000-0000-00000000b001', 'lock114.admin.b@example.test');
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id) VALUES
  ('11400000-0000-0000-0000-00000000a001', 'lock114.admin.a@example.test', 'Admin A', 'admin', '11400000-0000-0000-0000-0000000000a0'),
  ('11400000-0000-0000-0000-00000000a003', 'lock114.office.a@example.test', 'Office A', 'office', '11400000-0000-0000-0000-0000000000a0'),
  ('11400000-0000-0000-0000-00000000a004', 'lock114.w1.a@example.test', 'Worker One', 'workshop', '11400000-0000-0000-0000-0000000000a0'),
  ('11400000-0000-0000-0000-00000000a005', 'lock114.w2.a@example.test', 'Worker Two', 'workshop', '11400000-0000-0000-0000-0000000000a0'),
  ('11400000-0000-0000-0000-00000000b001', 'lock114.admin.b@example.test', 'Admin B', 'admin', '11400000-0000-0000-0000-0000000000b0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, full_name = EXCLUDED.full_name;
INSERT INTO public.organization_members (user_id, organization_id, role) VALUES
  ('11400000-0000-0000-0000-00000000a001', '11400000-0000-0000-0000-0000000000a0', 'admin'),
  ('11400000-0000-0000-0000-00000000a003', '11400000-0000-0000-0000-0000000000a0', 'office'),
  ('11400000-0000-0000-0000-00000000a004', '11400000-0000-0000-0000-0000000000a0', 'workshop'),
  ('11400000-0000-0000-0000-00000000a005', '11400000-0000-0000-0000-0000000000a0', 'workshop'),
  ('11400000-0000-0000-0000-00000000b001', '11400000-0000-0000-0000-0000000000b0', 'admin')
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

-- 075's flag, the opposite way round to 114's, to show the lock ignores it: w1 "Can work off site" (075), w2 "On site only" (075).
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT public.set_member_on_site_only(gen_random_uuid(), '11400000-0000-0000-0000-00000000a004', FALSE);
SELECT public.set_member_on_site_only(gen_random_uuid(), '11400000-0000-0000-0000-00000000a005', TRUE);

-- 1. Default (unlocked): nobody is refused, from anywhere; nothing is marked.
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '198.51.100.9');
INSERT INTO proof_ids VALUES ('unlocked', pg_temp.clock('in'));
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a005', '198.51.100.9');
INSERT INTO proof_ids VALUES ('unlocked2', pg_temp.clock('in'));
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_unverified WHERE event_id IN (SELECT id FROM proof_ids WHERE k IN ('unlocked', 'unlocked2'))), '1 unlocked: w1 and w2 clock in from another address, recorded, nothing marked');

-- 2. Who may lock: not office, not workshop, not an admin before the second step (company requires it), not without an address, not a
--    private address. The admin, two-step, from a public address: yes.
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a003', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.lock_clock_in_network()$$, '2a office locks', 'admin_only');
SELECT pg_temp.expect_refused($$SELECT public.unlock_clock_in_network()$$, '2b office unlocks', 'admin_only');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.lock_clock_in_network()$$, '2c workshop locks', 'admin_only');
RESET ROLE;
SET LOCAL session_replication_role = replica;
UPDATE public.organizations SET require_admin_mfa = TRUE WHERE id = '11400000-0000-0000-0000-0000000000a0';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '203.0.113.7', 'aal1');
SELECT pg_temp.expect_refused($$SELECT public.lock_clock_in_network()$$, '2d admin at aal1 (two-step required)', 'mfa_required');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', NULL);
SELECT pg_temp.expect_refused($$SELECT public.lock_clock_in_network()$$, '2e no client address', 'ip_unknown');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '10.1.2.3');
SELECT pg_temp.expect_refused($$SELECT public.lock_clock_in_network()$$, '2f private address', 'private_network');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', NULL, 'aal2', '203.0.113.99, 162.158.0.1');
SELECT pg_temp.expect_refused($$SELECT public.lock_clock_in_network()$$, '2g x-forwarded-for only (never trusted)', 'ip_unknown');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '203.0.113.7');
DO $$ DECLARE r JSONB; BEGIN
  r := public.lock_clock_in_network();
  PERFORM pg_temp.ok(r ->> 'network' = '203.0.113.7/32' AND (r ->> 'locked')::BOOLEAN AND NOT (r ->> 'recaptured')::BOOLEAN
                     AND r ->> 'locked_by' = '11400000-0000-0000-0000-00000000a001', '2h admin aal2 locks to the request''s address: ' || r::TEXT);
END $$;
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 1 FROM security_audit.audit_log WHERE organization_id = '11400000-0000-0000-0000-0000000000a0' AND action = 'CLOCK_IN_NETWORK_LOCKED'
                   AND metadata ->> 'after' = '203.0.113.7/32'), '2i the lock is audited (CLOCK_IN_NETWORK_LOCKED)');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_locks WHERE organization_id = '11400000-0000-0000-0000-0000000000b0'), '2j company B stays unlocked');

-- 2x. The per-person exception: admin only (two-step), a person of the admin's own company only, audited.
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a003', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.set_clock_in_off_site_allowed('11400000-0000-0000-0000-00000000a005', TRUE)$$, '2k office sets an exception', 'admin_only');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a005', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.set_clock_in_off_site_allowed('11400000-0000-0000-0000-00000000a005', TRUE)$$, '2l workshop sets their own exception', 'admin_only');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '203.0.113.7', 'aal1');
SELECT pg_temp.expect_refused($$SELECT public.set_clock_in_off_site_allowed('11400000-0000-0000-0000-00000000a005', TRUE)$$, '2m admin at aal1 (two-step required)', 'mfa_required');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT public.set_clock_in_off_site_allowed('11400000-0000-0000-0000-00000000b001', TRUE)$$, '2n company B''s person', 'person_missing');
SELECT pg_temp.expect_refused($$SELECT public.set_clock_in_off_site_allowed('11400000-0000-0000-0000-00000000a005', NULL)$$, '2o no value', 'bad_value');
DO $$ DECLARE r JSONB; BEGIN
  r := public.set_clock_in_off_site_allowed('11400000-0000-0000-0000-00000000a005', TRUE);
  PERFORM pg_temp.ok((r ->> 'off_site_allowed')::BOOLEAN AND (r ->> 'changed')::BOOLEAN, '2p admin allows w2 off site');
  r := public.set_clock_in_off_site_allowed('11400000-0000-0000-0000-00000000a005', TRUE);
  PERFORM pg_temp.ok(NOT (r ->> 'changed')::BOOLEAN, '2q again: unchanged');
END $$;
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 1 FROM security_audit.audit_log WHERE organization_id = '11400000-0000-0000-0000-0000000000a0' AND action = 'CLOCK_IN_OFF_SITE_ALLOWED_SET'),
                  '2r the exception is audited once (CLOCK_IN_OFF_SITE_ALLOWED_SET)');

-- 3. Locked: the default person (w1, though 075 says they can work off site) online from another address is refused, nothing
--    recorded; from the locked address, allowed.
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '198.51.100.9');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('in')$$, '3a w1 clock in from another address', 'clock_in_network_locked', 'Clock in from the workshop Wi-Fi%');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('out')$$, '3b w1 clock out from another address', 'clock_in_network_locked', 'Clock out from the workshop Wi-Fi%');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('break_start')$$, '3c w1 break start (pause) from another address', 'clock_in_network_locked', 'Start your break from the workshop Wi-Fi%');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('break_end')$$, '3d w1 break end from another address', 'clock_in_network_locked', 'End your break from the workshop Wi-Fi%');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('in', now() - interval '90 seconds')$$, '3e w1 device time 90 s behind (still online)', 'clock_in_network_locked');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '198.51.100.9', 'aal2', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('in')$$, '3f w1 with a spoofed x-forwarded-for of the locked address', 'clock_in_network_locked');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '203.0.113.7');
INSERT INTO proof_ids VALUES ('on_lock', pg_temp.clock('in'));
SELECT pg_temp.ok((SELECT id FROM proof_ids WHERE k = 'on_lock') IS NOT NULL, '3g w1 from the locked address: recorded');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '::ffff:203.0.113.7');
SELECT pg_temp.ok(pg_temp.clock('out') IS NOT NULL, '3h w1 from the locked address written IPv4-mapped: recorded');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 3 FROM public.attendance_events WHERE user_id = '11400000-0000-0000-0000-00000000a004'),
                  '3i only the unlocked, locked-address and mapped clock actions exist (refusals recorded nothing)');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_unverified WHERE user_id = '11400000-0000-0000-0000-00000000a004'), '3j checked online: nothing marked');

-- 4. Not checked: a person allowed off site (even though 075 marks them On site only); another company; a correction by the admin.
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a005', '198.51.100.9');
SELECT pg_temp.ok(pg_temp.clock('in') IS NOT NULL, '4a w2 (allowed off site; 075 On site only) from another address: recorded');
SELECT pg_temp.ok(pg_temp.clock('out', now() - interval '10 minutes') IS NOT NULL, '4a2 w2 synced later: recorded');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000b001', '198.51.100.9');
SELECT pg_temp.ok(pg_temp.clock('in') IS NOT NULL, '4b company B''s admin (B unlocked) from another address: recorded');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '198.51.100.9');
SELECT pg_temp.ok((public.correct_attendance_event(gen_random_uuid(), '11400000-0000-0000-0000-00000000a004', NULL, 'out', now() - interval '1 minute',
                  'Left early, forgot to clock out') ->> 'event_id') IS NOT NULL, '4c admin correction for w1 from another address: recorded (corrections never checked)');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_unverified WHERE organization_id IN ('11400000-0000-0000-0000-0000000000a0', '11400000-0000-0000-0000-0000000000b0')),
                  '4d none of those is marked');

-- 5. Can't be checked: synced later (queued offline) or no client address: ACCEPTED and marked network_unverified, never refused.
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '198.51.100.9');
INSERT INTO proof_ids VALUES ('synced', pg_temp.clock('break_start', now() - interval '10 minutes'));
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', NULL);
INSERT INTO proof_ids VALUES ('noaddr', pg_temp.clock('break_end'));
RESET ROLE;
SELECT pg_temp.ok((SELECT reason = 'synced_later' AND action = 'break_start' AND device_at IS NOT NULL FROM public.clock_in_network_unverified
                   WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'synced')), '5a synced later: recorded, marked synced_later');
SELECT pg_temp.ok((SELECT reason = 'address_unknown' FROM public.clock_in_network_unverified WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'noaddr')),
                  '5b no client address: recorded, marked address_unknown');
SELECT pg_temp.expect_refused($$UPDATE public.clock_in_network_unverified SET reason = 'synced_later' WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'noaddr')$$,
                              '5c a mark is never changed', NULL);
SELECT pg_temp.expect_refused($$DELETE FROM public.clock_in_network_unverified WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'noaddr')$$, '5d a mark is never removed', NULL);

-- 6. Reads and writes: office sees the lock, the exception and both marks; workshop w1 their own marks only, not the lock, no exception;
--    w2 their own exception and none of w1's marks; B nothing of A. No API role writes the tables directly.
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a003', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.clock_in_network_locks) AND (SELECT count(*) = 2 FROM public.clock_in_network_unverified), '6a office: the lock and both marks');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.clock_in_network_exemptions), '6a2 office: the exception');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_locks) AND (SELECT count(*) = 2 FROM public.clock_in_network_unverified), '6b w1: own marks, not the lock');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_exemptions), '6b2 w1: no exception rows');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a005', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_unverified), '6c w2: none of w1''s marks');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.clock_in_network_exemptions WHERE user_id = '11400000-0000-0000-0000-00000000a005'), '6c2 w2: their own exception');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000b001', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_locks) AND (SELECT count(*) = 0 FROM public.clock_in_network_unverified), '6d company B: nothing of A');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_exemptions), '6d2 company B: no exception of A');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.expect_refused($$INSERT INTO public.clock_in_network_locks (organization_id, network) VALUES ('11400000-0000-0000-0000-0000000000a0', '198.51.100.9/32')$$, '6e admin direct insert of a lock', NULL, '%permission denied%');
SELECT pg_temp.expect_refused($$DELETE FROM public.clock_in_network_locks$$, '6f admin direct delete of the lock', NULL, '%permission denied%');
SELECT pg_temp.expect_refused($$UPDATE public.clock_in_network_locks SET network = '198.51.100.9/32'$$, '6g admin direct update of the lock', NULL, '%permission denied%');
SELECT pg_temp.expect_refused($$INSERT INTO public.clock_in_network_exemptions (organization_id, user_id, off_site_allowed) VALUES ('11400000-0000-0000-0000-0000000000a0', '11400000-0000-0000-0000-00000000a004', TRUE)$$, '6h admin direct insert of an exception', NULL, '%permission denied%');

-- 7. A saved site network (075's list) is accepted too. Re-capture from IPv6: the /64, so other devices on that LAN pass.
SELECT public.add_site_network(gen_random_uuid(), '192.0.2.0/24', 'Second site');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '192.0.2.44');
SELECT pg_temp.ok(pg_temp.clock('in') IS NOT NULL, '7a w1 from a saved site network: recorded');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '2001:db8:1:2::5');
DO $$ DECLARE r JSONB; BEGIN
  r := public.lock_clock_in_network();
  PERFORM pg_temp.ok(r ->> 'network' = '2001:db8:1:2::/64' AND (r ->> 'recaptured')::BOOLEAN AND (r ->> 'changed')::BOOLEAN, '7b re-capture from IPv6 locks its /64: ' || r::TEXT);
  r := public.lock_clock_in_network();
  PERFORM pg_temp.ok(NOT (r ->> 'changed')::BOOLEAN, '7c re-capture from the same address: unchanged');
END $$;
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '2001:db8:1:2:abcd::99');
SELECT pg_temp.ok(pg_temp.clock('out') IS NOT NULL, '7d w1 from another address in the locked /64: recorded');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '2001:db8:9::1');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('in')$$, '7e w1 from another IPv6 /64', 'clock_in_network_locked');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('in')$$, '7f w1 from the OLD address after re-capture', 'clock_in_network_locked');

-- 8. The exception withdrawn: w2 is refused like everyone. Then unlock: nobody is refused, nothing is marked.
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '198.51.100.9');
SELECT pg_temp.ok(NOT (public.set_clock_in_off_site_allowed('11400000-0000-0000-0000-00000000a005', FALSE) ->> 'off_site_allowed')::BOOLEAN, '8- admin withdraws w2''s exception');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a005', '198.51.100.9');
SELECT pg_temp.expect_refused($$SELECT pg_temp.clock('in')$$, '8-- w2 without the exception, from another address', 'clock_in_network_locked');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a001', '198.51.100.9');
DO $$ DECLARE r JSONB; BEGIN
  r := public.unlock_clock_in_network();
  PERFORM pg_temp.ok(NOT (r ->> 'locked')::BOOLEAN AND (r ->> 'changed')::BOOLEAN, '8a admin unlocks');
  r := public.unlock_clock_in_network();
  PERFORM pg_temp.ok(NOT (r ->> 'changed')::BOOLEAN, '8b unlock again: unchanged');
END $$;
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a005', '198.51.100.9');
SELECT pg_temp.ok(pg_temp.clock('in') IS NOT NULL, '8b2 after unlock: w2 (no exception) from another address: recorded');
SELECT pg_temp.sign_in('11400000-0000-0000-0000-00000000a004', '198.51.100.9');
SELECT pg_temp.ok(pg_temp.clock('out') IS NOT NULL, '8b3 after unlock: w1 from another address: recorded');
INSERT INTO proof_ids VALUES ('after_unlock', pg_temp.clock('in', now() - interval '10 minutes'));
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_unverified WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'after_unlock')),
                  '8c after unlock: w1 from another address, synced later: recorded, not marked');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM security_audit.audit_log WHERE organization_id = '11400000-0000-0000-0000-0000000000a0' AND action = 'CLOCK_IN_NETWORK_UNLOCKED'),
                  '8d the unlock is audited once (CLOCK_IN_NETWORK_UNLOCKED)');

\o
SELECT 'clock-in network lock 114: all checks passed' AS result;
ROLLBACK;

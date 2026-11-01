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
-- Two companies. A: admin, office, w1 (the default: no exception), w2 (allowed off site while locked), viewer. B: admin.
INSERT INTO public.organizations (id, name, slug) VALUES
  ('12800000-0000-0000-0000-0000000000a0', 'Net A', 't-net128-a'), ('12800000-0000-0000-0000-0000000000b0', 'Net B', 't-net128-b');
INSERT INTO auth.users (id, email) VALUES
  ('12800000-0000-0000-0000-00000000a001', 'net128.admin.a@example.test'), ('12800000-0000-0000-0000-00000000a003', 'net128.office.a@example.test'),
  ('12800000-0000-0000-0000-00000000a004', 'net128.w1.a@example.test'), ('12800000-0000-0000-0000-00000000a005', 'net128.w2.a@example.test'),
  ('12800000-0000-0000-0000-00000000a006', 'net128.viewer.a@example.test'), ('12800000-0000-0000-0000-00000000b001', 'net128.admin.b@example.test');
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id) VALUES
  ('12800000-0000-0000-0000-00000000a001', 'net128.admin.a@example.test', 'Admin A', 'admin', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000a003', 'net128.office.a@example.test', 'Office A', 'office', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000a004', 'net128.w1.a@example.test', 'Worker One', 'workshop', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000a005', 'net128.w2.a@example.test', 'Worker Two', 'workshop', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000a006', 'net128.viewer.a@example.test', 'Viewer A', 'viewer', '12800000-0000-0000-0000-0000000000a0'),
  ('12800000-0000-0000-0000-00000000b001', 'net128.admin.b@example.test', 'Admin B', 'admin', '12800000-0000-0000-0000-0000000000b0')
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, full_name = EXCLUDED.full_name;
INSERT INTO public.organization_members (user_id, organization_id, role) VALUES
  ('12800000-0000-0000-0000-00000000a001', '12800000-0000-0000-0000-0000000000a0', 'admin'),
  ('12800000-0000-0000-0000-00000000a003', '12800000-0000-0000-0000-0000000000a0', 'office'),
  ('12800000-0000-0000-0000-00000000a004', '12800000-0000-0000-0000-0000000000a0', 'workshop'),
  ('12800000-0000-0000-0000-00000000a005', '12800000-0000-0000-0000-0000000000a0', 'workshop'),
  ('12800000-0000-0000-0000-00000000a006', '12800000-0000-0000-0000-0000000000a0', 'viewer'),
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
SELECT pg_temp.ok((SELECT label = 'Workshop' AND network = '203.0.113.7/32' FROM public.site_networks WHERE id = (SELECT id FROM proof_ids WHERE k = 'netA'))
                  AND (SELECT label = 'Main workshop' AND organization_id = '12800000-0000-0000-0000-0000000000a0' AND renamed_by = '12800000-0000-0000-0000-00000000a001'
                       FROM public.site_network_names WHERE network_id = (SELECT id FROM proof_ids WHERE k = 'netA')),
                  '1p A''s network row never written (saved label and address as added); the last name is in site_network_names');
SELECT pg_temp.ok((SELECT array_agg(p.oid::regprocedure::TEXT ORDER BY 1) = ARRAY['add_site_network(uuid,text,text)'] FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname IN ('public', 'security_audit') AND p.prosrc ~* '(insert\s+into|update)\s+(public\.)?site_networks\M'),
                  '1p2 078''s rule holds: add_site_network is still the only function writing site_networks');
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
SELECT pg_temp.ok((SELECT count(*) = 3 FROM security_audit.audit_log WHERE organization_id = '12800000-0000-0000-0000-0000000000a0' AND entity_table = 'site_network_names'),
                  '1t2 the name row changes are audited (insert + 2 updates)');

-- 1u. The names are read as site_networks: admin and office of the company; not workshop, not another company; no API writes.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a003', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.site_network_names), '1u office A reads A''s name');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.site_network_names), '1v workshop reads none');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000b001', '198.51.100.20');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.site_network_names), '1w admin B reads none of A''s');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.expect_refused($$UPDATE public.site_network_names SET label = 'Direct'$$, '1x admin direct update of a name', NULL, '%permission denied%');
-- A removed network takes its name with it.
DO $$ DECLARE v UUID; BEGIN
  v := (public.add_site_network(gen_random_uuid(), '192.0.2.0/24', 'Second site') ->> 'id')::UUID;
  PERFORM public.rename_site_network(gen_random_uuid(), v, 'Unit 2');
  PERFORM public.remove_site_network(gen_random_uuid(), v);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.site_network_names WHERE network_id = v), '1y removing a network removes its name');
END $$;
RESET ROLE;

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

-- 6. Duplicates are idempotent: one refused clock action reported live, then again from the offline queue (lib/offline/sync.ts
--    executeClockRefusalOp: the same client op id), from any address, is ONE row; the first record's address and time are kept.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '198.51.100.60');
SELECT pg_temp.expect_refused($$SELECT public.record_attendance_event('12800000-0000-0000-0000-00000000e001', 'out', NULL, 'Proof phone')$$,
                              '6a w1 clock out from an unrecognised address: refused by 114', 'clock_in_network_locked');
DO $$ DECLARE live JSONB; q JSONB; BEGIN
  live := public.record_clock_in_refusal('12800000-0000-0000-0000-00000000e001', 'out');
  PERFORM pg_temp.ok((live ->> 'recorded')::BOOLEAN AND NOT (live ->> 'replayed')::BOOLEAN, '6b the live report: recorded');
  INSERT INTO proof_ids VALUES ('live', (live ->> 'id')::UUID);
  q := public.record_clock_in_refusal('12800000-0000-0000-0000-00000000e001', 'out');
  PERFORM pg_temp.ok((q ->> 'replayed')::BOOLEAN AND q ->> 'id' = live ->> 'id' AND q ->> 'attempted_at' = live ->> 'attempted_at',
                     '6c the queued resend from the same address: the first record (replayed, same id and time)');
END $$;
-- The queue sends it on reconnect, by then maybe back on the workshop Wi-Fi (where 114 would not refuse) or on another network.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.ok((SELECT (r ->> 'replayed')::BOOLEAN AND r ->> 'id' = (SELECT id::TEXT FROM proof_ids WHERE k = 'live')
                   FROM (SELECT public.record_clock_in_refusal('12800000-0000-0000-0000-00000000e001', 'out') AS r) x),
                  '6d the queued resend from the workshop address: replayed (not not_refused), the same record');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '198.51.100.61');
SELECT pg_temp.ok((SELECT (r ->> 'replayed')::BOOLEAN AND r ->> 'id' = (SELECT id::TEXT FROM proof_ids WHERE k = 'live')
                   FROM (SELECT public.record_clock_in_refusal('12800000-0000-0000-0000-00000000e001', 'out') AS r) x),
                  '6e the queued resend from another address: replayed, the same record');
-- Someone else (office A, also refused from outside) under the same key: refused, nothing added.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a003', '198.51.100.62');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal('12800000-0000-0000-0000-00000000e001', 'out')$$, '6f another person under the same key', 'client_op_reused');
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 1 AND bool_and(ip = '198.51.100.60'::INET AND user_id = '12800000-0000-0000-0000-00000000a004' AND action = 'out')
                   FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000e001'),
                  '6g ONE row for the key: w1, out, the live report''s address (198.51.100.60), never a resend''s');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.attendance_events WHERE client_op_id = '12800000-0000-0000-0000-00000000e001'),
                  '6h no clock record under the key (the report never records the clock action)');
SELECT pg_temp.expect_refused($$INSERT INTO public.clock_in_network_refusals (organization_id, user_id, client_op_id, action)
                                VALUES ('12800000-0000-0000-0000-0000000000a0', '12800000-0000-0000-0000-00000000a004', '12800000-0000-0000-0000-00000000e001', 'out')$$,
                              '6i a second row for the key, even written directly by the owner', NULL, '%clock_in_network_refusals_one_per_key%');

-- 7. Who can read an address or rename, per role (RLS, as PostgREST). A switches the Flag check on for w1 and w2 (075) so their clock
--    actions keep their address (078's attendance_event_network_ips): w1 clocks out on the workshop network, w2 (allowed off site) clocks in from outside.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT public.set_site_network_check(gen_random_uuid(), 'flag');
SELECT public.set_member_on_site_only(gen_random_uuid(), '12800000-0000-0000-0000-00000000a004', TRUE);
SELECT public.set_member_on_site_only(gen_random_uuid(), '12800000-0000-0000-0000-00000000a005', TRUE);
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '203.0.113.7');
INSERT INTO proof_ids VALUES ('w1out', pg_temp.clock('out'));
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a005', '198.51.100.50');
INSERT INTO proof_ids VALUES ('w2in', pg_temp.clock('in'));
RESET ROLE;
SELECT pg_temp.ok((SELECT count(*) = 2 FROM public.attendance_event_network_ips WHERE event_id IN (SELECT id FROM proof_ids WHERE k IN ('w1out', 'w2in'))),
                  '7a both clock actions kept their address (078)');
-- Admin: everything of the company.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) FROM public.site_networks) >= 1 AND (SELECT count(*) = 1 FROM public.site_network_names)
                  AND (SELECT count(*) = 2 FROM public.attendance_event_network_ips) AND (SELECT count(*) = 1 FROM public.clock_in_network_locks)
                  AND EXISTS (SELECT 1 FROM public.clock_in_network_refusals WHERE ip = '198.51.100.60'::INET),
                  '7b admin A reads the networks, the name, both addresses, the lock and the refusal address');
-- Office (075/078/114's rule: admin and office read the networks, names, addresses and lock; 128's refusals are admin only).
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a003', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) FROM public.site_networks) >= 1 AND (SELECT count(*) = 1 FROM public.site_network_names)
                  AND (SELECT count(*) = 2 FROM public.attendance_event_network_ips),
                  '7c office A reads the networks, the name and the clock-in addresses (075/078''s admin-and-office rule, unchanged)');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_refusals), '7d office A reads no refusal record and so no refusal address (admin only)');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Office try')$$, '7e office renames', 'admin_only');
-- Workshop (w1): no network, name, lock or refusal; of the clock-in addresses only their own (078's rule), never anyone else's.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a004', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.site_networks), '7f workshop reads no site network (no saved address)');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.site_network_names), '7g workshop reads no network name');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_locks), '7h workshop reads no lock (no locked address)');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_refusals), '7i workshop reads no refusal record, not even their own (no refusal address)');
SELECT pg_temp.ok((SELECT count(*) = 1 AND bool_and(user_id = '12800000-0000-0000-0000-00000000a004') FROM public.attendance_event_network_ips)
                  AND NOT EXISTS (SELECT 1 FROM public.attendance_event_network_ips WHERE ip = '198.51.100.50'::INET),
                  '7j workshop: only their own clock-in address (078''s rule), never w2''s');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.attendance_event_networks WHERE ip IS NOT NULL OR user_id <> '12800000-0000-0000-0000-00000000a004'),
                  '7k workshop: their own checks only, and a check row never holds an address (078)');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Workshop try')$$, '7l workshop renames', 'admin_only');
-- Viewer: nothing at all, and can't rename or report.
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a006', '203.0.113.7');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.site_networks), '7m viewer reads no site network');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.site_network_names), '7n viewer reads no network name');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_locks), '7o viewer reads no lock');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.clock_in_network_refusals), '7p viewer reads no refusal record');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.attendance_event_network_ips), '7q viewer reads no clock-in address');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.attendance_event_networks), '7r viewer reads no clock-in check');
SELECT pg_temp.expect_refused($$SELECT public.rename_site_network(gen_random_uuid(), (SELECT id FROM proof_ids WHERE k = 'netA'), 'Viewer try')$$, '7s viewer renames', 'not_allowed');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a006', '198.51.100.63');
SELECT pg_temp.expect_refused($$SELECT public.record_clock_in_refusal(gen_random_uuid(), 'in')$$, '7t viewer reports a refusal', 'not_allowed');
-- No API role can write any of them (admin included).
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.expect_refused($$UPDATE public.site_networks SET label = 'Direct'$$, '7u admin direct update of site_networks', NULL, '%permission denied%');
SELECT pg_temp.expect_refused($$DELETE FROM public.attendance_event_network_ips$$, '7v admin direct delete of clock-in addresses', NULL, '%permission denied%');
RESET ROLE;

-- 8. 30-day deletion covers BOTH the clock-in addresses (078) and the refusal addresses (128): rows at 29 and 31 days, in one purge.
UPDATE public.attendance_event_network_ips SET checked_at = now() - INTERVAL '31 days' WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w1out');
UPDATE public.attendance_event_network_ips SET checked_at = now() - INTERVAL '29 days' WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w2in');
INSERT INTO public.clock_in_network_refusals (organization_id, user_id, client_op_id, action, ip, attempted_at) VALUES
  ('12800000-0000-0000-0000-0000000000a0', '12800000-0000-0000-0000-00000000a004', '12800000-0000-0000-0000-00000000f031', 'in', '198.51.100.131', now() - INTERVAL '31 days'),
  ('12800000-0000-0000-0000-0000000000a0', '12800000-0000-0000-0000-00000000a004', '12800000-0000-0000-0000-00000000f029', 'in', '198.51.100.129', now() - INTERVAL '29 days');
SET LOCAL ROLE service_role;
SELECT pg_temp.ok(public.site_network_ip_purge('12800000-0000-0000-0000-0000000000a0', 500) = 2, '8a the cron''s purge (service role): 2 cleared, the 31-day address and the 31-day refusal address');
SELECT pg_temp.ok(public.site_network_ip_purge('12800000-0000-0000-0000-0000000000a0', 500) = 0, '8b again: nothing left');
RESET ROLE;
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.attendance_event_network_ips WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w1out'))
                  AND EXISTS (SELECT 1 FROM public.attendance_event_networks WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w1out') AND status = 'on_site'),
                  '8c clock-in address at 31 days: deleted (the check row and its status stay)');
SELECT pg_temp.ok((SELECT ip = '198.51.100.50'::INET FROM public.attendance_event_network_ips WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w2in')),
                  '8d clock-in address at 29 days: kept');
SELECT pg_temp.ok((SELECT ip IS NULL FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000f031'),
                  '8e refusal at 31 days: the row stays, its address cleared');
SELECT pg_temp.ok((SELECT ip = '198.51.100.129'::INET FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000f029'),
                  '8f refusal at 29 days: address kept');
-- A clock action clears the company's expired addresses first (078's trigger, which now runs 128's purge): both kinds at 31 days.
UPDATE public.attendance_event_network_ips SET checked_at = now() - INTERVAL '31 days' WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w2in');
INSERT INTO public.clock_in_network_refusals (organization_id, user_id, client_op_id, action, ip, attempted_at) VALUES
  ('12800000-0000-0000-0000-0000000000a0', '12800000-0000-0000-0000-00000000a004', '12800000-0000-0000-0000-00000000f131', 'out', '198.51.100.132', now() - INTERVAL '31 days');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a005', '198.51.100.50');
INSERT INTO proof_ids VALUES ('w2out', pg_temp.clock('out'));
RESET ROLE;
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.attendance_event_network_ips WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w2in'))
                  AND (SELECT ip IS NULL FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000f131')
                  AND (SELECT ip = '198.51.100.129'::INET FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000f029')
                  AND EXISTS (SELECT 1 FROM public.attendance_event_network_ips WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w2out')),
                  '8g a clock action: the 31-day address and the 31-day refusal address cleared, the 29-day refusal kept, the new address kept');
-- The admin's Delete expired: the same 30 days for both.
UPDATE public.attendance_event_network_ips SET checked_at = now() - INTERVAL '31 days' WHERE event_id = (SELECT id FROM proof_ids WHERE k = 'w2out');
INSERT INTO public.clock_in_network_refusals (organization_id, user_id, client_op_id, action, ip, attempted_at) VALUES
  ('12800000-0000-0000-0000-0000000000a0', '12800000-0000-0000-0000-00000000a004', '12800000-0000-0000-0000-00000000f231', 'out', '198.51.100.133', now() - INTERVAL '31 days');
SELECT pg_temp.sign_in('12800000-0000-0000-0000-00000000a001', '203.0.113.7');
SELECT pg_temp.ok((public.purge_site_network_ips(FALSE) ->> 'removed')::INT = 2, '8h admin Delete expired: the 31-day address and the 31-day refusal address (2)');
RESET ROLE;
SELECT pg_temp.ok((SELECT ip = '198.51.100.129'::INET FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000f029')
                  AND (SELECT ip IS NULL FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000f231')
                  AND (SELECT ip = '198.51.100.60'::INET FROM public.clock_in_network_refusals WHERE client_op_id = '12800000-0000-0000-0000-00000000e001'),
                  '8i after Delete expired: the 29-day and today''s refusal addresses kept, the 31-day one cleared');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM security_audit.audit_log a WHERE a.organization_id = '12800000-0000-0000-0000-0000000000a0'
                              AND (to_jsonb(a)::TEXT LIKE '%198.51.100.1%' OR to_jsonb(a)::TEXT LIKE '%198.51.100.60%' OR to_jsonb(a)::TEXT LIKE '%198.51.100.50%')),
                  '8j no refusal or clock-in address is anywhere in the audit log');

\o
SELECT 'workshop network 128: all checks passed' AS result;
ROLLBACK;

-- Local proof for migration 134 (G3: the AI assistant, built OFF, on 133's cap rules). Run on a COPY of a database with the chain
-- applied up to and including 134:
--   createdb e_134 -T base; psql -d e_134 -f supabase/release/134_ai_assistant.release.sql; psql -X -d e_134 -f this
-- One transaction, rolled back. Prints one PASS or FAIL line per check, then TOTAL n/m. The same through vitest:
-- tests/db/ai-assistant-134.test.ts.
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
CREATE TEMP TABLE r(n serial, name text, ok boolean);
GRANT ALL ON r TO PUBLIC; GRANT ALL ON SEQUENCE r_n_seq TO PUBLIC;
INSERT INTO public.organizations(id, name, slug, status) VALUES
  ('a0000000-0000-0000-0000-000000000134', 'Alpha 134', 'alpha-134', 'active'), ('b0000000-0000-0000-0000-000000000134', 'Beta 134', 'beta-134', 'active');
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-0000-0000-0000000001a1', 'office.a134@example.test'), ('a0000000-0000-0000-0000-0000000001ad', 'admin.a134@example.test');
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
VALUES ('a0000000-0000-0000-0000-0000000001a1', 'office.a134@example.test', 'Office A', 'office', 'a0000000-0000-0000-0000-000000000134', TRUE, FALSE),
       ('a0000000-0000-0000-0000-0000000001ad', 'admin.a134@example.test', 'Admin A', 'admin', 'a0000000-0000-0000-0000-000000000134', TRUE, FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, active = TRUE, must_change_password = FALSE;
INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES
  ('a0000000-0000-0000-0000-0000000001a1', 'a0000000-0000-0000-0000-000000000134', 'office', TRUE),
  ('a0000000-0000-0000-0000-0000000001ad', 'a0000000-0000-0000-0000-000000000134', 'admin', TRUE);
INSERT INTO auth.sessions (id, user_id) VALUES ('a0000000-0000-0000-0000-00000000005e', 'a0000000-0000-0000-0000-0000000001a1'), ('a0000000-0000-0000-0000-00000000005d', 'a0000000-0000-0000-0000-0000000001ad');
INSERT INTO security_audit.session_company (session_id, user_id, organization_id) VALUES
  ('a0000000-0000-0000-0000-00000000005e', 'a0000000-0000-0000-0000-0000000001a1', 'a0000000-0000-0000-0000-000000000134'),
  ('a0000000-0000-0000-0000-00000000005d', 'a0000000-0000-0000-0000-0000000001ad', 'a0000000-0000-0000-0000-000000000134');
INSERT INTO public.ai_helper_settings (organization_id, rfq_enabled, roundup_enabled, monthly_cap_pence) VALUES ('a0000000-0000-0000-0000-000000000134', TRUE, TRUE, 500);
INSERT INTO public.ai_helper_secrets (organization_id, api_key_enc) VALUES ('a0000000-0000-0000-0000-000000000134', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc');

-- One function call as a signed-in person of Alpha (aal2, their session) or as the service role; the answer, or {"error": SQLSTATE}.
CREATE FUNCTION pg_temp.as_person(p_who text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb; v_state text; v_id text; v_session text; v_email text;
BEGIN
  IF p_who = 'admin' THEN v_id := 'a0000000-0000-0000-0000-0000000001ad'; v_session := 'a0000000-0000-0000-0000-00000000005d'; v_email := 'admin.a134@example.test';
  ELSE v_id := 'a0000000-0000-0000-0000-0000000001a1'; v_session := 'a0000000-0000-0000-0000-00000000005e'; v_email := 'office.a134@example.test'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_id, 'role', 'authenticated', 'aal', 'aal2', 'email', v_email, 'session_id', v_session)::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_id, true);
  SET LOCAL ROLE authenticated;
  BEGIN EXECUTE 'SELECT to_jsonb(' || p_sql || ')' INTO v;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; v := jsonb_build_object('error', v_state); END;
  RESET ROLE;
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.as_service(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SET LOCAL ROLE service_role;
  BEGIN EXECUTE 'SELECT to_jsonb(' || p_sql || ')' INTO v;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; v := jsonb_build_object('error', v_state); END;
  RESET ROLE;
  RETURN v;
END $f$;
CREATE TEMP TABLE ids(name text PRIMARY KEY, id uuid);
GRANT ALL ON ids TO PUBLIC;
CREATE TEMP TABLE got(name text PRIMARY KEY, v jsonb);
GRANT ALL ON got TO PUBLIC;
CREATE FUNCTION pg_temp.ledger() RETURNS jsonb LANGUAGE sql AS $f$
  SELECT coalesce((SELECT jsonb_build_object('reserved', reserved_pence, 'spent', spent_pence) FROM public.ai_helper_usage WHERE organization_id = 'a0000000-0000-0000-0000-000000000134'),
                  '{"reserved": 0, "spent": 0}')
$f$;

-- Off by default, and only an admin switches it on.
INSERT INTO got SELECT 'off', pg_temp.as_person('office', $$public.ai_helper_reserve_assistant(5, repeat('a', 64), 100)$$);
INSERT INTO r(name, ok) SELECT 'off by default (round-up and RFQ on, key set, room under the cap): the assistant reserve is refused 42501, nothing logged or reserved',
  (SELECT assistant_enabled FROM public.ai_helper_settings WHERE organization_id = 'a0000000-0000-0000-0000-000000000134') = FALSE
  AND (SELECT v FROM got WHERE name = 'off') = '{"error": "42501"}'
  AND NOT EXISTS (SELECT 1 FROM public.ai_helper_requests WHERE organization_id = 'a0000000-0000-0000-0000-000000000134')
  AND pg_temp.ledger() = '{"reserved": 0, "spent": 0}';
INSERT INTO got SELECT 'office on', pg_temp.as_person('office', $$public.ai_helper_set_assistant(true)$$);
INSERT INTO r(name, ok) SELECT 'office cannot switch it on (42501); it stays off',
  (SELECT v FROM got WHERE name = 'office on') = '{"error": "42501"}'
  AND (SELECT assistant_enabled FROM public.ai_helper_settings WHERE organization_id = 'a0000000-0000-0000-0000-000000000134') = FALSE;
DO $$
DECLARE v_state text := 'none';
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'a0000000-0000-0000-0000-0000000001ad', 'role', 'authenticated', 'aal', 'aal2', 'session_id', 'a0000000-0000-0000-0000-00000000005d')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN UPDATE public.ai_helper_settings SET assistant_enabled = TRUE WHERE organization_id = 'a0000000-0000-0000-0000-000000000134';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE; END;
  RESET ROLE;
  INSERT INTO r(name, ok) VALUES ('nobody signed in may write the switch directly (42501)', v_state = '42501');
END $$;
INSERT INTO got SELECT 'admin on', pg_temp.as_person('admin', $$public.ai_helper_set_assistant(true)$$);
INSERT INTO r(name, ok) SELECT 'the admin switches it on, audited; the round-up and RFQ switches do not move',
  (SELECT v FROM got WHERE name = 'admin on') = '{"assistant_enabled": true}'
  AND (SELECT assistant_enabled AND roundup_enabled AND rfq_enabled FROM public.ai_helper_settings WHERE organization_id = 'a0000000-0000-0000-0000-000000000134')
  AND EXISTS (SELECT 1 FROM security_audit.audit_log WHERE organization_id = 'a0000000-0000-0000-0000-000000000134' AND action = 'ai_helper_settings_updated'
              AND metadata ->> 'assistant_enabled' = 'true' AND actor_user_id = 'a0000000-0000-0000-0000-0000000001ad');

-- 133's Q4 rule: a reservation nobody settled within 10 minutes is CHARGED IN FULL by the next reserve (the assistant's own).
INSERT INTO ids SELECT 'first', (pg_temp.as_person('office', $$public.ai_helper_reserve_assistant(40, repeat('a', 64), 100)$$) ->> 'request_id')::uuid;
INSERT INTO r(name, ok) SELECT 'assistant reserve 40p: reserved 40, spent 0, an assistant request row',
  pg_temp.ledger() = '{"reserved": 40, "spent": 0}'
  AND (SELECT feature = 'assistant' AND status = 'reserved' FROM public.ai_helper_requests WHERE id = (SELECT id FROM ids WHERE name = 'first'));
UPDATE public.ai_helper_requests SET created_at = now() - interval '11 minutes' WHERE id = (SELECT id FROM ids WHERE name = 'first');
INSERT INTO ids SELECT 'second', (pg_temp.as_person('office', $$public.ai_helper_reserve_assistant(10, repeat('a', 64), 100)$$) ->> 'request_id')::uuid;
INSERT INTO r(name, ok) SELECT 'the next assistant reserve: the stale 40p moves into spent (not released, as 103 did); only the new 10p is reserved',
  pg_temp.ledger() = '{"reserved": 10, "spent": 40}'
  AND (SELECT status = 'expired' AND cost_pence = 40 FROM public.ai_helper_requests WHERE id = (SELECT id FROM ids WHERE name = 'first'));
INSERT INTO got SELECT 'late', pg_temp.as_service(format($$public.ai_helper_settle(%L, 'suggested', NULL, 3, 'claude-sonnet-5-5', '{"kind":"assistant"}'::jsonb)$$, (SELECT id FROM ids WHERE name = 'first')));
INSERT INTO r(name, ok) SELECT 'its late answer (cost 3) is recorded, the charge stays 40, the ledger does not move (133''s settle)',
  (SELECT v FROM got WHERE name = 'late') = '""'::jsonb AND pg_temp.ledger() = '{"reserved": 10, "spent": 40}'
  AND (SELECT status = 'suggested' AND cost_pence = 40 FROM public.ai_helper_requests WHERE id = (SELECT id FROM ids WHERE name = 'first'));
-- 133's ai_helper_reserve sweeps a stale assistant reservation the same way.
UPDATE public.ai_helper_requests SET created_at = now() - interval '11 minutes' WHERE id = (SELECT id FROM ids WHERE name = 'second');
INSERT INTO got SELECT 'rfq', pg_temp.as_person('office', $$public.ai_helper_reserve('rfq', 1, repeat('a', 64), 100)$$);
INSERT INTO r(name, ok) SELECT '133''s ai_helper_reserve (RFQ) charges the stale 10p assistant reservation in full too',
  ((SELECT v FROM got WHERE name = 'rfq') ->> 'ok')::boolean AND pg_temp.ledger() = '{"reserved": 1, "spent": 50}'
  AND (SELECT status = 'expired' AND cost_pence = 10 FROM public.ai_helper_requests WHERE id = (SELECT id FROM ids WHERE name = 'second'));
INSERT INTO got SELECT 'rfq settle', pg_temp.as_service(format($$public.ai_helper_settle(%L, 'failed', 'unavailable', 0, NULL, NULL)$$, (SELECT v ->> 'request_id' FROM got WHERE name = 'rfq')));
-- The app's two settles for a failed call: 0 for a certain rejection (the reservation given back), the full reservation otherwise.
INSERT INTO ids SELECT 'rejected', (pg_temp.as_person('office', $$public.ai_helper_reserve_assistant(4, repeat('a', 64), 100)$$) ->> 'request_id')::uuid;
INSERT INTO got SELECT 'rejected', pg_temp.as_service(format($$public.ai_helper_settle(%L, 'failed', 'unavailable', 0, 'claude-sonnet-5-5', NULL)$$, (SELECT id FROM ids WHERE name = 'rejected')));
INSERT INTO r(name, ok) SELECT 'a certain rejection (settled at 0) gives the 4p back: nothing spent',
  (SELECT v FROM got WHERE name = 'rejected') = '""'::jsonb AND pg_temp.ledger() = '{"reserved": 0, "spent": 50}';
INSERT INTO ids SELECT 'uncertain', (pg_temp.as_person('office', $$public.ai_helper_reserve_assistant(6, repeat('a', 64), 100)$$) ->> 'request_id')::uuid;
INSERT INTO got SELECT 'uncertain', pg_temp.as_service(format($$public.ai_helper_settle(%L, 'failed', 'unavailable', 6, 'claude-sonnet-5-5', NULL)$$, (SELECT id FROM ids WHERE name = 'uncertain')));
INSERT INTO r(name, ok) SELECT 'an uncertain failure (settled at the full 6p reservation) is charged in full',
  (SELECT v FROM got WHERE name = 'uncertain') = '""'::jsonb AND pg_temp.ledger() = '{"reserved": 0, "spent": 56}';

-- 133's Q6 purge covers assistant rows.
SET LOCAL session_replication_role = replica;
INSERT INTO public.ai_helper_requests (id, organization_id, user_id, feature, month, status, input_digest, input_bytes, reserved_pence, cost_pence, model, output, created_at)
SELECT v.id::uuid, v.org::uuid, gen_random_uuid(), 'assistant', date_trunc('month', now() - v.age)::date, 'suggested', repeat('a', 64), 10, 5, 3, 'claude-sonnet-5-5', '{"kind":"assistant"}', now() - v.age
FROM (VALUES ('a1340000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000134', interval '13 months'),
             ('a1340000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000134', interval '11 months 29 days'),
             ('b1340000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000134', interval '24 months')) AS v(id, org, age);
SET LOCAL session_replication_role = origin;
INSERT INTO got SELECT 'purge', pg_temp.as_service($$public.ai_helper_purge_requests(10000)$$);
INSERT INTO r(name, ok) SELECT '133''s 12-month purge deletes assistant requests past 12 months in both companies and keeps the younger one',
  ((SELECT v FROM got WHERE name = 'purge')::text)::int >= 2
  AND NOT EXISTS (SELECT 1 FROM public.ai_helper_requests WHERE id IN ('a1340000-0000-0000-0000-000000000001', 'b1340000-0000-0000-0000-000000000001'))
  AND EXISTS (SELECT 1 FROM public.ai_helper_requests WHERE id = 'a1340000-0000-0000-0000-000000000002')
  AND (SELECT count(*) = 2 FROM security_audit.audit_log WHERE action = 'ai_helper_requests_purged'
       AND organization_id IN ('a0000000-0000-0000-0000-000000000134', 'b0000000-0000-0000-0000-000000000134'));

-- No widening.
INSERT INTO r(name, ok) SELECT '133''s ai_helper_reserve still refuses the feature ''assistant'' (22023)',
  pg_temp.as_person('office', $$public.ai_helper_reserve('assistant', 1, repeat('a', 64), 100)$$) = '{"error": "22023"}';
INSERT INTO r(name, ok) SELECT 'the two new functions: signed-in only (not anon, not PUBLIC); settle and purge still the service role''s only',
  NOT has_function_privilege('anon', 'public.ai_helper_reserve_assistant(integer,text,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.ai_helper_set_assistant(boolean)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.ai_helper_reserve_assistant(integer,text,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.ai_helper_settle(uuid,text,text,integer,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.ai_helper_purge_requests(integer)', 'EXECUTE');
INSERT INTO r(name, ok) SELECT '133''s reserve, settle and purge bodies are untouched by 134',
  (SELECT array_agg(md5(regexp_replace(prosrc, '\s', '', 'g')) ORDER BY proname) FROM pg_proc
   WHERE oid IN (to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'), to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)'),
                 to_regprocedure('public.ai_helper_purge_requests(integer)')))
  = ARRAY['c4b0d7f39cec1f23c6bd1d5e31e59fa9', '972540e833a42bbb35ac5b670c56daa8', '7e04d0ab645ec24dc0f0acb78c222702'];
\unset QUIET
SELECT CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || n || ' ' || name FROM r ORDER BY n;
SELECT 'TOTAL ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM r;
ROLLBACK;

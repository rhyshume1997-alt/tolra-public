-- Local proof for migration 133 (AI-PRE: E9 Q4 stale sweep charges in full, Q6 12-month purge across companies). Run on a COPY of a
-- database with the chain applied plus 133:
--   createdb e_133 -T base; psql -d e_133 -f supabase/release/133_ai_helper_pre_enable.release.sql; psql -X -d e_133 -f this
-- One transaction, rolled back. Prints one PASS or FAIL line per check, then TOTAL n/m. The same through vitest (also run on the
-- stand-in): tests/db/ai-helper-pre-enable-133.test.ts and tests/db/ai-helper-101.test.ts (the sweep, through reserve).
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
CREATE TEMP TABLE r(n serial, name text, ok boolean);
GRANT ALL ON r TO PUBLIC; GRANT ALL ON SEQUENCE r_n_seq TO PUBLIC;
INSERT INTO public.organizations(id, name, slug, status) VALUES
  ('a0000000-0000-0000-0000-000000000133', 'Alpha 133', 'alpha-133', 'active'), ('b0000000-0000-0000-0000-000000000133', 'Beta 133', 'beta-133', 'active');
INSERT INTO auth.users (id, email) VALUES ('a0000000-0000-0000-0000-0000000001a1', 'office.a133@example.test');
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password)
VALUES ('a0000000-0000-0000-0000-0000000001a1', 'office.a133@example.test', 'Office A', 'office', 'a0000000-0000-0000-0000-000000000133', TRUE, FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, active = TRUE, must_change_password = FALSE;
INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES ('a0000000-0000-0000-0000-0000000001a1', 'a0000000-0000-0000-0000-000000000133', 'office', TRUE);
INSERT INTO auth.sessions (id, user_id) VALUES ('a0000000-0000-0000-0000-00000000005e', 'a0000000-0000-0000-0000-0000000001a1');
INSERT INTO security_audit.session_company (session_id, user_id, organization_id) VALUES ('a0000000-0000-0000-0000-00000000005e', 'a0000000-0000-0000-0000-0000000001a1', 'a0000000-0000-0000-0000-000000000133');
INSERT INTO public.ai_helper_settings (organization_id, rfq_enabled, roundup_enabled, monthly_cap_pence) VALUES ('a0000000-0000-0000-0000-000000000133', TRUE, TRUE, 500);
INSERT INTO public.ai_helper_secrets (organization_id, api_key_enc) VALUES ('a0000000-0000-0000-0000-000000000133', 'v1.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb.cccccccccccc');

-- One function call as the office user (aal2, its session) or as the service role; the answer, or {"error": SQLSTATE}.
CREATE FUNCTION pg_temp.as_office(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', 'a0000000-0000-0000-0000-0000000001a1', 'role', 'authenticated', 'aal', 'aal2',
    'email', 'office.a133@example.test', 'session_id', 'a0000000-0000-0000-0000-00000000005e')::text, true);
  PERFORM set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000001a1', true);
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
CREATE FUNCTION pg_temp.ledger() RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('reserved', reserved_pence, 'spent', spent_pence) FROM public.ai_helper_usage WHERE organization_id = 'a0000000-0000-0000-0000-000000000133'
$f$;

-- Q4: a reservation nobody settled within 10 minutes is CHARGED IN FULL by the next reserve.
INSERT INTO ids SELECT 'first', (pg_temp.as_office($$public.ai_helper_reserve('rfq', 40, repeat('a', 64), 100)$$) ->> 'request_id')::uuid;
INSERT INTO r(name, ok) SELECT 'reserve 40p: reserved 40, spent 0', pg_temp.ledger() = '{"reserved": 40, "spent": 0}';
UPDATE public.ai_helper_requests SET created_at = now() - interval '11 minutes' WHERE id = (SELECT id FROM ids WHERE name = 'first');
INSERT INTO ids SELECT 'second', (pg_temp.as_office($$public.ai_helper_reserve('rfq', 10, repeat('a', 64), 100)$$) ->> 'request_id')::uuid;
INSERT INTO r(name, ok) SELECT 'the next reserve: the stale 40p moves into spent (not released); only the new 10p is reserved',
  pg_temp.ledger() = '{"reserved": 10, "spent": 40}';
INSERT INTO r(name, ok) SELECT 'the stale request is expired with cost 40 (its full reservation)',
  (SELECT status = 'expired' AND cost_pence = 40 FROM public.ai_helper_requests WHERE id = (SELECT id FROM ids WHERE name = 'first'));
-- (Each action runs in its own statement, so the check after it sees what it did.)
CREATE TEMP TABLE got(name text PRIMARY KEY, v jsonb);
GRANT ALL ON got TO PUBLIC;
INSERT INTO got SELECT 'late', pg_temp.as_service(format($$public.ai_helper_settle(%L, 'suggested', NULL, 3, 'claude-opus-5-5', '{"kind":"rfq","lines":[]}'::jsonb)$$, (SELECT id FROM ids WHERE name = 'first')));
INSERT INTO r(name, ok) SELECT 'its late answer (cost 3) is recorded as suggested, the charge stays 40, the ledger does not move',
  (SELECT v FROM got WHERE name = 'late') = '""'::jsonb
  AND pg_temp.ledger() = '{"reserved": 10, "spent": 40}'
  AND (SELECT status = 'suggested' AND cost_pence = 40 FROM public.ai_helper_requests WHERE id = (SELECT id FROM ids WHERE name = 'first'));
INSERT INTO r(name, ok) SELECT 'a second settle of it is refused (42501)',
  pg_temp.as_service(format($$public.ai_helper_settle(%L, 'failed', 'invalid', 0, NULL, NULL)$$, (SELECT id FROM ids WHERE name = 'first'))) = '{"error": "42501"}';
INSERT INTO r(name, ok) SELECT 'a normal settle still works as 103: the failed 10p request at full reservation (the app''s uncertain case) spends 10',
  pg_temp.as_service(format($$public.ai_helper_settle(%L, 'failed', 'unavailable', 10, 'claude-opus-5-5', NULL)$$, (SELECT id FROM ids WHERE name = 'second'))) = '""'::jsonb
  AND pg_temp.ledger() = '{"reserved": 0, "spent": 50}';
INSERT INTO r(name, ok) SELECT 'settle never charges above the reservation (asked 999 on a 5p request: 5)',
  (SELECT pg_temp.as_service(format($$public.ai_helper_settle(%L, 'failed', 'unavailable', 999, NULL, NULL)$$,
     (pg_temp.as_office($$public.ai_helper_reserve('rfq', 5, repeat('a', 64), 100)$$) ->> 'request_id'))) = '""'::jsonb)
  AND pg_temp.ledger() = '{"reserved": 0, "spent": 55}';

-- Q6: the purge, across companies.
SET LOCAL session_replication_role = replica;
INSERT INTO public.ai_helper_requests (id, organization_id, user_id, feature, month, status, input_digest, input_bytes, reserved_pence, cost_pence, model, output, created_at)
SELECT v.id::uuid, v.org::uuid, gen_random_uuid(), 'rfq', date_trunc('month', now() - v.age)::date, 'suggested', repeat('a', 64), 10, 5, 3, 'claude-opus-5-5', '{"kind":"rfq","lines":[]}', now() - v.age
FROM (VALUES ('a1330000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000133', interval '13 months'),
             ('a1330000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000133', interval '12 months 1 day'),
             ('a1330000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000133', interval '11 months 29 days'),
             ('b1330000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000133', interval '24 months'),
             ('b1330000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000133', interval '6 months')) AS v(id, org, age);
SET LOCAL session_replication_role = origin;
INSERT INTO r(name, ok) SELECT 'purge refused to a signed-in user (42501) and for a bad limit (22023)',
  pg_temp.as_office($$public.ai_helper_purge_requests(10)$$) = '{"error": "42501"}' AND pg_temp.as_service($$public.ai_helper_purge_requests(0)$$) = '{"error": "22023"}';
INSERT INTO got SELECT 'purge2', pg_temp.as_service($$public.ai_helper_purge_requests(2)$$);
INSERT INTO r(name, ok) SELECT 'purge(2): the two oldest of ALL companies (Beta 24 months, Alpha 13 months)',
  (SELECT v FROM got WHERE name = 'purge2') = '2'
  AND NOT EXISTS (SELECT 1 FROM public.ai_helper_requests WHERE id IN ('b1330000-0000-0000-0000-000000000001', 'a1330000-0000-0000-0000-000000000001'));
INSERT INTO r(name, ok) SELECT 'purge(1000): the last one past 12 months (12 months 1 day); a run after finds nothing',
  pg_temp.as_service($$public.ai_helper_purge_requests(1000)$$) = '1' AND pg_temp.as_service($$public.ai_helper_purge_requests(1000)$$) = '0';
INSERT INTO r(name, ok) SELECT 'younger rows stay in both companies (11 months 29 days, 6 months, and this proof''s own requests)',
  (SELECT count(*) = 2 FROM public.ai_helper_requests WHERE id IN ('a1330000-0000-0000-0000-000000000003', 'b1330000-0000-0000-0000-000000000002'))
  AND (SELECT count(*) = 3 FROM public.ai_helper_requests WHERE organization_id = 'a0000000-0000-0000-0000-000000000133' AND created_at > now() - interval '1 hour');
INSERT INTO r(name, ok) SELECT 'one audit row per company per run that deleted from it: counts only (Beta 1, Alpha 1, Alpha 1), no actor, no content',
  (SELECT array_agg(organization_id::text || ':' || (metadata ->> 'deleted') ORDER BY id) FROM security_audit.audit_log WHERE action = 'ai_helper_requests_purged')
    @> ARRAY['b0000000-0000-0000-0000-000000000133:1', 'a0000000-0000-0000-0000-000000000133:1']
  AND (SELECT count(*) = 3 AND bool_and(actor_user_id IS NULL AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(metadata) k) = ARRAY['created_before', 'deleted', 'source'])
       FROM security_audit.audit_log WHERE action = 'ai_helper_requests_purged');
\unset QUIET
SELECT CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || n || ' ' || name FROM r ORDER BY n;
SELECT 'TOTAL ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM r;
ROLLBACK;

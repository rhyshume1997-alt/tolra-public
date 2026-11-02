-- =====================================================================================================================================
-- Migration 136 proof (opening WIP from SliQ: public.opening_wip). Plain SQL (no psql meta-commands). By hand, against a DISPOSABLE database
-- with the chain applied through 136 (never production):
--
--   PGPASSWORD=... psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d <disposable> -f tests/scripts/opening-wip-136.proof.sql
--
-- ONE transaction, ROLLED BACK at the end: no company, login, job or WIP row is left behind. Every property prints "ok ..." (NOTICE); the
-- first one that does not hold raises "FAIL ...". The last result row is the summary: result = 'PASS opening wip 136 proof'.
-- Signed-in calls run as PostgREST runs them: role authenticated with request.jwt.claims (sub, email, session_id, aal).
--
-- Proves, with two companies: A's admin and office read A's WIP rows and none of B's; B's admin reads B's only; A's workshop person and
-- viewer read nothing (as job prices, 009); anon reads nothing; no signed-in person (admin included) can insert, change or delete a row; the
-- owner (the importer) can write; a link to another company's job is refused; the same source key twice in one company is refused but the
-- same key in another company is fine; deleting the job keeps the row (link cleared, SliQ job number kept); every write is in the audit log;
-- a blank value stays NULL; nothing in invoices changes.
-- =====================================================================================================================================
BEGIN;

CREATE TEMP TABLE proof_people (key TEXT PRIMARY KEY, id UUID NOT NULL, email TEXT NOT NULL, session UUID, aal TEXT NOT NULL DEFAULT 'aal2') ON COMMIT DROP;
CREATE TEMP TABLE proof_count (n INTEGER NOT NULL) ON COMMIT DROP;
INSERT INTO proof_count VALUES (0);

INSERT INTO public.organizations (id, name, slug, status) VALUES
  ('13600000-0000-4000-8000-0000000000a0', 'WIP Proof A', 'proof136-a', 'active'),
  ('13600000-0000-4000-8000-0000000000b0', 'WIP Proof B', 'proof136-b', 'active');
INSERT INTO proof_people (key, id, email, session) VALUES
  ('adminA',    '13600000-0000-4000-8000-00000000a001', 'admin.a.136@example.test', '13600000-0000-4000-8000-0000000005a1'),
  ('officeA',   '13600000-0000-4000-8000-00000000a002', 'office.a.136@example.test', NULL),
  ('workshopA', '13600000-0000-4000-8000-00000000a003', 'workshop.a.136@example.test', NULL),
  ('viewerA',   '13600000-0000-4000-8000-00000000a004', 'viewer.a.136@example.test', NULL),
  ('adminB',    '13600000-0000-4000-8000-00000000b001', 'admin.b.136@example.test', '13600000-0000-4000-8000-0000000005b1');
INSERT INTO auth.users (id, email) SELECT id, email FROM proof_people;
INSERT INTO public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) VALUES
  ('13600000-0000-4000-8000-00000000a001', 'admin.a.136@example.test', 'Admin A', 'admin', '13600000-0000-4000-8000-0000000000a0', TRUE, FALSE),
  ('13600000-0000-4000-8000-00000000a002', 'office.a.136@example.test', 'Office A', 'office', '13600000-0000-4000-8000-0000000000a0', TRUE, FALSE),
  ('13600000-0000-4000-8000-00000000a003', 'workshop.a.136@example.test', 'Workshop A', 'workshop', '13600000-0000-4000-8000-0000000000a0', TRUE, FALSE),
  ('13600000-0000-4000-8000-00000000a004', 'viewer.a.136@example.test', 'Viewer A', 'viewer', '13600000-0000-4000-8000-0000000000a0', TRUE, FALSE),
  ('13600000-0000-4000-8000-00000000b001', 'admin.b.136@example.test', 'Admin B', 'admin', '13600000-0000-4000-8000-0000000000b0', TRUE, FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, active = TRUE, must_change_password = FALSE;
INSERT INTO public.organization_members (user_id, organization_id, role, active) VALUES
  ('13600000-0000-4000-8000-00000000a001', '13600000-0000-4000-8000-0000000000a0', 'admin', TRUE),
  ('13600000-0000-4000-8000-00000000a002', '13600000-0000-4000-8000-0000000000a0', 'office', TRUE),
  ('13600000-0000-4000-8000-00000000a003', '13600000-0000-4000-8000-0000000000a0', 'workshop', TRUE),
  ('13600000-0000-4000-8000-00000000a004', '13600000-0000-4000-8000-0000000000a0', 'viewer', TRUE),
  ('13600000-0000-4000-8000-00000000b001', '13600000-0000-4000-8000-0000000000b0', 'admin', TRUE)
ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active;
INSERT INTO auth.sessions (id, user_id) VALUES
  ('13600000-0000-4000-8000-0000000005a1', '13600000-0000-4000-8000-00000000a001'), ('13600000-0000-4000-8000-0000000005b1', '13600000-0000-4000-8000-00000000b001');
INSERT INTO security_audit.session_company (session_id, user_id, organization_id) VALUES
  ('13600000-0000-4000-8000-0000000005a1', '13600000-0000-4000-8000-00000000a001', '13600000-0000-4000-8000-0000000000a0'),
  ('13600000-0000-4000-8000-0000000005b1', '13600000-0000-4000-8000-00000000b001', '13600000-0000-4000-8000-0000000000b0');

-- One job in each company, and WIP rows written as the importer writes them (the owner).
INSERT INTO public.jobs (id, organization_id, job_no, customer, description) VALUES
  ('13600000-0000-4000-8000-00000000c0a1', '13600000-0000-4000-8000-0000000000a0', 'J-1501', 'Proof Customer A', 'Proof job A'),
  ('13600000-0000-4000-8000-00000000c0b1', '13600000-0000-4000-8000-0000000000b0', 'J-1501', 'Proof Customer B', 'Proof job B');
INSERT INTO public.opening_wip (organization_id, job_id, source_job_ref, description, quantity, value, as_of, source_key) VALUES
  ('13600000-0000-4000-8000-0000000000a0', '13600000-0000-4000-8000-00000000c0a1', 'J-1501', 'Material issued', 2.5, 125.40, '2026-10-30', 'k1'),
  ('13600000-0000-4000-8000-0000000000a0', '13600000-0000-4000-8000-00000000c0a1', 'J-1501', 'Labour to date', NULL, NULL, '2026-10-30', 'k2'),
  ('13600000-0000-4000-8000-0000000000a0', NULL, 'J-1450', 'WIP on a job not in the file', NULL, 80.00, '2026-10-30', 'k3'),
  ('13600000-0000-4000-8000-0000000000b0', '13600000-0000-4000-8000-00000000c0b1', 'J-1501', 'B material', NULL, 10.00, '2026-10-30', 'k1');

-- Runs one SELECT as a signed-in person; returns its single value as text, or 'ERR:<sqlstate>'. The role and claims are reset after.
CREATE FUNCTION pg_temp.as_(p_key TEXT, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE p RECORD; v TEXT; v_state TEXT;
BEGIN
  SELECT * INTO p FROM proof_people WHERE key = p_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL proof: no person %', p_key; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p.id, 'email', p.email, 'role', 'authenticated', 'aud', 'authenticated',
                                                              'aal', p.aal, 'session_id', p.session)::TEXT, TRUE);
  PERFORM set_config('role', 'authenticated', TRUE);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v := 'ERR:' || v_state;
  END;
  PERFORM set_config('role', 'postgres', TRUE);
  PERFORM set_config('request.jwt.claims', '', TRUE);
  RETURN v;
END $$;

-- The same as anon (no claims).
CREATE FUNCTION pg_temp.anon_(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v TEXT; v_state TEXT;
BEGIN
  PERFORM set_config('role', 'anon', TRUE);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v := 'ERR:' || v_state;
  END;
  PERFORM set_config('role', 'postgres', TRUE);
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.ok(p_label TEXT, p_got TEXT, p_want TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want AND NOT (p_want LIKE '%\%%' AND p_got LIKE p_want) THEN
    RAISE EXCEPTION 'FAIL %: got %, want %', p_label, coalesce(p_got, 'NULL'), p_want;
  END IF;
  UPDATE proof_count SET n = n + 1;
  RAISE NOTICE 'ok %', p_label;
END $$;

CREATE FUNCTION pg_temp.owner_try(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_state TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    RETURN 'ERR:' || v_state;
  END;
  RETURN 'ok';
END $$;

DO $$
DECLARE
  v_a CONSTANT TEXT := '13600000-0000-4000-8000-0000000000a0';
  v_b CONSTANT TEXT := '13600000-0000-4000-8000-0000000000b0';
  v_inv TEXT;
BEGIN
  SELECT coalesce(sum(total), 0)::TEXT || '/' || count(*) INTO v_inv FROM public.invoices;

  -- ===== 1. Reads: admin and office of A see A's three rows and none of B's; B's admin sees B's one row only =====
  PERFORM pg_temp.ok('A admin reads A''s WIP rows', pg_temp.as_('adminA', 'SELECT count(*)::text FROM public.opening_wip'), '3');
  PERFORM pg_temp.ok('A admin reads none of B''s', pg_temp.as_('adminA', format('SELECT count(*)::text FROM public.opening_wip WHERE organization_id = %L', v_b)), '0');
  PERFORM pg_temp.ok('A office reads A''s WIP rows', pg_temp.as_('officeA', 'SELECT count(*)::text FROM public.opening_wip'), '3');
  PERFORM pg_temp.ok('A office reads the stated total (blank value stays NULL)', pg_temp.as_('officeA', 'SELECT sum(value)::text || ''/'' || count(*) FILTER (WHERE value IS NULL) FROM public.opening_wip'), '205.40/1');
  PERFORM pg_temp.ok('B admin reads only B''s row', pg_temp.as_('adminB', 'SELECT string_agg(organization_id::text || '':'' || description, '','') FROM public.opening_wip'), v_b || ':B material');
  PERFORM pg_temp.ok('A workshop reads nothing (as job prices)', pg_temp.as_('workshopA', 'SELECT count(*)::text FROM public.opening_wip'), '0');
  PERFORM pg_temp.ok('A viewer reads nothing', pg_temp.as_('viewerA', 'SELECT count(*)::text FROM public.opening_wip'), '0');
  PERFORM pg_temp.ok('anon cannot read', pg_temp.anon_('SELECT count(*)::text FROM public.opening_wip'), 'ERR:42501');

  -- ===== 2. Writes: nobody signed in may insert, change or delete a row =====
  PERFORM pg_temp.ok('A admin cannot insert', pg_temp.as_('adminA', format(
    'INSERT INTO public.opening_wip (organization_id, source_key, value) VALUES (%L, %L, 1) RETURNING id::text', v_a, 'x1')), 'ERR:42501');
  PERFORM pg_temp.ok('A office cannot insert', pg_temp.as_('officeA', format(
    'INSERT INTO public.opening_wip (organization_id, source_key, value) VALUES (%L, %L, 1) RETURNING id::text', v_a, 'x2')), 'ERR:42501');
  PERFORM pg_temp.ok('A admin cannot change a value', pg_temp.as_('adminA', 'WITH u AS (UPDATE public.opening_wip SET value = 1 RETURNING 1) SELECT count(*)::text FROM u'), 'ERR:42501');
  PERFORM pg_temp.ok('A office cannot delete', pg_temp.as_('officeA', 'WITH d AS (DELETE FROM public.opening_wip RETURNING 1) SELECT count(*)::text FROM d'), 'ERR:42501');
  PERFORM pg_temp.ok('B admin cannot change A''s rows', pg_temp.as_('adminB', format('WITH u AS (UPDATE public.opening_wip SET value = 1 WHERE organization_id = %L RETURNING 1) SELECT count(*)::text FROM u', v_a)), 'ERR:42501');
  PERFORM pg_temp.ok('anon cannot insert', pg_temp.anon_(format('INSERT INTO public.opening_wip (organization_id, source_key) VALUES (%L, %L) RETURNING id::text', v_a, 'x3')), 'ERR:42501');
  PERFORM pg_temp.ok('the rows are unchanged after the refused writes', (SELECT sum(value)::TEXT || '/' || count(*) FROM public.opening_wip), '215.40/4');

  -- ===== 3. Owner writes: same-company link, repeat key =====
  PERFORM pg_temp.ok('a link to another company''s job is refused', pg_temp.owner_try(format(
    'INSERT INTO public.opening_wip (organization_id, job_id, source_key) VALUES (%L, %L, %L)', v_a, '13600000-0000-4000-8000-00000000c0b1', 'x4')), 'ERR:23514');
  PERFORM pg_temp.ok('the same source key twice in one company is refused', pg_temp.owner_try(format(
    'INSERT INTO public.opening_wip (organization_id, source_key) VALUES (%L, %L)', v_a, 'k1')), 'ERR:23505');
  PERFORM pg_temp.ok('the source must be sliq', pg_temp.owner_try(format(
    'INSERT INTO public.opening_wip (organization_id, source_key, source) VALUES (%L, %L, %L)', v_a, 'x5', 'other')), 'ERR:23514');

  -- ===== 4. The job goes: the WIP row stays, unlinked, with the SliQ job number =====
  DELETE FROM public.jobs WHERE id = '13600000-0000-4000-8000-00000000c0a1';
  PERFORM pg_temp.ok('deleting the job keeps its WIP rows, unlinked, SliQ number kept',
    (SELECT count(*) FILTER (WHERE job_id IS NULL AND source_job_ref = 'J-1501')::TEXT FROM public.opening_wip WHERE organization_id = v_a::UUID), '2');

  -- ===== 5. Audit, and nothing else touched =====
  PERFORM pg_temp.ok('every WIP insert is in the row audit log', (SELECT count(*)::TEXT FROM security_audit.audit_log
    WHERE entity_table = 'opening_wip' AND action = 'INSERT' AND organization_id IN (v_a::UUID, v_b::UUID)), '4');
  PERFORM pg_temp.ok('the job link cleared by the delete is audited', (SELECT (count(*) >= 2)::TEXT FROM security_audit.audit_log
    WHERE entity_table = 'opening_wip' AND action = 'UPDATE' AND organization_id = v_a::UUID), 'true');
  PERFORM pg_temp.ok('invoices are untouched (WIP is not revenue)', (SELECT coalesce(sum(total), 0)::TEXT || '/' || count(*) FROM public.invoices), v_inv);
END
$$;

SELECT 'PASS opening wip 136 proof' AS result, n AS checks FROM proof_count;

ROLLBACK;

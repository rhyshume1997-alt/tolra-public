-- Local proof for migration 132 (the dashboard's tile figures in the database). Run on a COPY of a database with the chain plus 132:
--   createdb e_132 -T base; psql -d e_132 -f supabase/release/132_dashboard_tile_figures.release.sql; psql -X -d e_132 -f this
-- One transaction, rolled back. Seed: 132_dashboard_tile_figures.seed.sql (hand counts below are worked out from its comments).
-- Prints one PASS or FAIL line per check, then TOTAL n/m. The parity with the page's old arithmetic (same figures to the last bit) is
-- tests/unit/dashboard-tile-figures.test.ts over the fixture this seed produces (132_dashboard_tile_figures.fixture.sql).
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
SET LOCAL TIME ZONE 'UTC';
\ir 132_dashboard_tile_figures.seed.sql
CREATE TEMP TABLE r(n serial, name text, ok boolean);
GRANT ALL ON r TO PUBLIC; GRANT ALL ON SEQUENCE r_n_seq TO PUBLIC;
-- p_sql (one jsonb expression) as the signed-in p_user (aal2), or as anon when p_user is NULL; the answer, or {"error": SQLSTATE}.
CREATE FUNCTION pg_temp.as_user(p_user uuid, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb; v_state text;
BEGIN
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    SET LOCAL ROLE anon;
  ELSE
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    SET LOCAL ROLE authenticated;
  END IF;
  BEGIN
    EXECUTE 'SELECT ' || p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    v := jsonb_build_object('error', v_state);
  END;
  RESET ROLE;
  RETURN v;
END $f$;
\set A '''a0000000-0000-0000-0000-0000000001a1'''
\set O '''a0000000-0000-0000-0000-0000000001a2'''
\set W '''a0000000-0000-0000-0000-0000000001a3'''
\set B '''b0000000-0000-0000-0000-0000000001b1'''

-- Alpha admin: every figure against the hand count.
INSERT INTO r(name, ok) SELECT 'alpha open quotes: 6 sent and valid (incl. SENT, valid today, no date, v2), 1235128.19, 3 accepted (ACCEPTED, not "Accepted ")',
  pg_temp.as_user(:A, $$public.dashboard_open_quotes('2026-10-20')$$) = '{"open_count": 6, "open_pence": 123512819, "accepted_count": 3}';
INSERT INTO r(name, ok) SELECT 'alpha quotes sent this month: 8 (QUO-0100 and v2 once; 23:30 UTC 30 Sep not counted; "" once)',
  pg_temp.as_user(:A, $$public.dashboard_quotes_sent('2026-10-01')$$) = '{"count": 8}';
INSERT INTO r(name, ok) SELECT 'alpha quotes won this month: 2 ("Accepted " trimmed; 23:30 UTC 30 Sep = 1 Oct London), 1 undated; 22:30 UTC 30 Sep not counted',
  pg_temp.as_user(:A, $$public.dashboard_quotes_won('2026-10-01')$$) = '{"count": 2, "undated": 1}';
INSERT INTO r(name, ok) SELECT 'alpha quotes last 90 days: 2 accepted, 6 awaiting, 1 expired (sent), 1 rejected',
  pg_temp.as_user(:A, $$public.dashboard_quote_outcomes('2026-07-22', '2026-10-20')$$) = '{"accepted": 2, "sent": 6, "expired": 1, "rejected": 1, "expired_sent": 1}';
INSERT INTO r(name, ok) SELECT 'alpha RFQs to quote: 4 (blank, null, new, "Quoted"; not quoted, not linked)',
  pg_temp.as_user(:A, $$public.dashboard_rfqs_to_quote()$$) = '{"outstanding": 4}';
INSERT INTO r(name, ok) SELECT 'alpha money owed: 49 invoices, 2 to confirm, buckets 197.87 / 153.05 / 143.40 / 140.00 (60 late is 31-60, 61 is 60+)',
  pg_temp.as_user(:A, $$public.dashboard_money_owed('2026-10-20') - 'owed'$$)
    = '{"invoices": 49, "to_confirm": 2, "not_due": 19787, "late_1_30": 15305, "late_31_60": 14340, "late_60_plus": 14000}';
INSERT INTO r(name, ok) SELECT 'alpha money owed total is the pounds added in id order (634.3200000000002, not 634.32)',
  (pg_temp.as_user(:A, $$public.dashboard_money_owed('2026-10-20')$$) ->> 'owed') = '634.3200000000002';
-- Row-level security applies (SECURITY INVOKER): Quotes hidden from the office login -> no quote counted, and every RFQ looks unquoted.
INSERT INTO r(name, ok) SELECT 'alpha office with Quotes hidden: 0 open, 0 sent, 0 won, 5 RFQs to quote (no quote it may see is linked)',
  pg_temp.as_user(:O, $$public.dashboard_open_quotes('2026-10-20') || public.dashboard_quotes_won('2026-10-01')$$) = '{"open_count": 0, "open_pence": 0, "accepted_count": 0, "count": 0, "undated": 0}'
  AND pg_temp.as_user(:O, $$public.dashboard_quotes_sent('2026-10-01')$$) = '{"count": 0}'
  AND pg_temp.as_user(:O, $$public.dashboard_rfqs_to_quote()$$) = '{"outstanding": 5}';
-- Each figure equals the same count over the rows that person can read directly (so the function never sees more than a SELECT would).
INSERT INTO r(name, ok) SELECT 'workshop: each figure is what its own reads of quotes / RFQs / invoices give',
  (pg_temp.as_user(:W, $$public.dashboard_open_quotes('2026-10-20') -> 'open_count'$$))::int
     = (pg_temp.as_user(:W, $$to_jsonb((SELECT count(*) FROM public.quotes WHERE lower(status) = 'sent' AND (valid_until IS NULL OR valid_until >= '2026-10-20')))$$))::int
  AND (pg_temp.as_user(:W, $$public.dashboard_money_owed('2026-10-20') -> 'to_confirm'$$))::int
     = (pg_temp.as_user(:W, $$to_jsonb((SELECT count(*) FROM public.invoices WHERE status <> 'paid' AND payment_unverified))$$))::int
  AND (pg_temp.as_user(:W, $$public.dashboard_rfqs_to_quote() -> 'outstanding'$$))::int
     = (pg_temp.as_user(:W, $$to_jsonb((SELECT count(*) FROM public.rfqs r WHERE coalesce(nullif(r.status, ''), 'new') <> 'quoted' AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.rfq_id = r.id)))$$))::int;
-- Company isolation: Beta sees only Beta's rows, Alpha's figures above hold none of Beta's (999.99 x2, 5000.00).
INSERT INTO r(name, ok) SELECT 'beta admin: only Beta (2 open 1999.98, 1 accepted, 3 sent, 1 won, 1 RFQ, 1 invoice 5000.00 60+ late)',
  pg_temp.as_user(:B, $$public.dashboard_open_quotes('2026-10-20')$$) = '{"open_count": 2, "open_pence": 199998, "accepted_count": 1}'
  AND pg_temp.as_user(:B, $$public.dashboard_quotes_sent('2026-10-01')$$) = '{"count": 3}'
  AND pg_temp.as_user(:B, $$public.dashboard_quotes_won('2026-10-01')$$) = '{"count": 1, "undated": 0}'
  AND pg_temp.as_user(:B, $$public.dashboard_rfqs_to_quote()$$) = '{"outstanding": 1}'
  AND pg_temp.as_user(:B, $$public.dashboard_money_owed('2026-10-20')$$)
      = '{"invoices": 1, "to_confirm": 0, "owed": 5000, "not_due": 0, "late_1_30": 0, "late_31_60": 0, "late_60_plus": 500000}';
-- Not signed in: refused, every one.
INSERT INTO r(name, ok) SELECT 'anon: all six refused (42501)',
  pg_temp.as_user(NULL, $$public.dashboard_open_quotes('2026-10-20')$$) = '{"error": "42501"}'
  AND pg_temp.as_user(NULL, $$public.dashboard_quotes_sent('2026-10-01')$$) = '{"error": "42501"}'
  AND pg_temp.as_user(NULL, $$public.dashboard_quotes_won('2026-10-01')$$) = '{"error": "42501"}'
  AND pg_temp.as_user(NULL, $$public.dashboard_quote_outcomes('2026-07-22', '2026-10-20')$$) = '{"error": "42501"}'
  AND pg_temp.as_user(NULL, $$public.dashboard_rfqs_to_quote()$$) = '{"error": "42501"}'
  AND pg_temp.as_user(NULL, $$public.dashboard_money_owed('2026-10-20')$$) = '{"error": "42501"}';
-- The shape: six functions, all SECURITY INVOKER, STABLE, search_path pinned; only authenticated (and the owner) may run them.
INSERT INTO r(name, ok) SELECT 'six functions, invoker, stable, search_path pinned, EXECUTE authenticated only',
  (SELECT count(*) = 6 AND bool_and(NOT p.prosecdef AND p.provolatile = 's' AND p.proconfig = '{"search_path=pg_catalog, public"}'
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('dashboard_open_quotes', 'dashboard_quotes_sent', 'dashboard_quotes_won', 'dashboard_quote_outcomes', 'dashboard_rfqs_to_quote', 'dashboard_money_owed'));
\unset QUIET
SELECT CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || n || ' ' || name FROM r ORDER BY n;
SELECT 'TOTAL ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM r;
ROLLBACK;

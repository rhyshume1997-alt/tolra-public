-- Parity fixture for migration 132: for each of five signed-in people (Alpha admin, Alpha office with Quotes hidden, Beta admin, Gamma
-- admin, Delta admin) the rows the dashboard's OLD reads fetch (same columns, filters and order as lib/dashboard-tile-figures.ts's legacy
-- reads, as PostgREST returns them: json of the row) and the six NEW functions' answers, on the seed (132_dashboard_tile_figures.seed.sql).
-- The unit test tests/unit/dashboard-tile-figures.test.ts works the figures out both ways with the app's own code and requires them
-- identical (the money-owed total: identical on screen, exact in pence; Delta is the one case where the old float sum showed a pound less).
-- Run on a COPY of a database with the chain plus 132 (one transaction, rolled back; prints one JSON line):
--   psql -X -At -d e_132 -f tests/scripts/sql/132_dashboard_tile_figures.fixture.sql > tests/fixtures/dashboard-tiles-132.json
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
SET LOCAL TIME ZONE 'UTC';
\ir 132_dashboard_tile_figures.seed.sql
CREATE TEMP TABLE out(n int, who text, doc jsonb);
GRANT ALL ON out TO PUBLIC;
CREATE FUNCTION pg_temp.capture(p_n int, p_who text, p_user uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  SET LOCAL ROLE authenticated;
  SELECT jsonb_build_object(
    'rows', jsonb_build_object(
      'quotes', (SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM (SELECT id, quote_ref, version, status, valid_until, total_value, vat_enabled, sent_at, accepted_at, rfq_id, created_at FROM public.quotes) t),
      'declined', (SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM (SELECT id, quote_id, quantity, unit_price, vat_pct, vat_exempt FROM public.quote_line_items WHERE declined = TRUE) t),
      'rfqs', (SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM (SELECT id, status FROM public.rfqs) t),
      'unpaid', (SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM (SELECT id, invoice_ref, customer, total, status, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified FROM public.invoices WHERE status <> 'paid') t)),
    'rpc', jsonb_build_object(
      'open', public.dashboard_open_quotes('2026-10-20'),
      'sent', public.dashboard_quotes_sent('2026-10-01'),
      'won', public.dashboard_quotes_won('2026-10-01'),
      'outcomes', public.dashboard_quote_outcomes('2026-07-22', '2026-10-20'),
      'rfqs', public.dashboard_rfqs_to_quote(),
      'owed', public.dashboard_money_owed('2026-10-20'))) INTO v;
  RESET ROLE;
  INSERT INTO out VALUES (p_n, p_who, v);
END $f$;
\o /dev/null
SELECT pg_temp.capture(1, 'alpha_admin', 'a0000000-0000-0000-0000-0000000001a1');
SELECT pg_temp.capture(2, 'alpha_office_quotes_hidden', 'a0000000-0000-0000-0000-0000000001a2');
SELECT pg_temp.capture(3, 'beta_admin', 'b0000000-0000-0000-0000-0000000001b1');
SELECT pg_temp.capture(4, 'gamma_admin', 'c0000000-0000-0000-0000-0000000001c1');
SELECT pg_temp.capture(5, 'delta_admin', 'd0000000-0000-0000-0000-0000000001d1');
\pset tuples_only on
\pset format unaligned
\o
SELECT jsonb_pretty(jsonb_build_object(
  'source', 'tests/scripts/sql/132_dashboard_tile_figures.fixture.sql',
  'dates', jsonb_build_object('today', '2026-10-20', 'monthStart', '2026-10-01', 'ninetyDaysAgo', '2026-07-22'),
  'people', (SELECT jsonb_object_agg(who, doc) FROM out)));
ROLLBACK;

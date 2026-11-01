-- Before/after measure for migration 132 (E6): what the dashboard's quote and money tiles cost on a big company, the old way (every
-- quote, declined line, RFQ and unpaid invoice read 1,000 rows a request, as lib/fetch-all pages them, plus the last empty page) and
-- the new way (six calls). The old reads are run page by page as PostgREST runs them (ORDER BY id OFFSET n LIMIT 1000 until an
-- empty page), so their database time includes the rows each later page skips. Run on a COPY of a database with the chain plus 132; one transaction, rolled back. Prints one line per read.
-- Bytes are the JSON PostgREST would send (row_to_json of the selected columns; the declined lines also carry id here); ms is database
-- time as the signed-in admin (RLS on), the best of 5 runs, without network; the old reads' pages are one after another. The company: 3,000 quotes, 300 declined lines, 600 RFQs, 5,000 unpaid invoices.
\set ON_ERROR_STOP 1
\set QUIET 1
BEGIN;
SET LOCAL TIME ZONE 'UTC';
INSERT INTO public.organizations(id, name, slug) VALUES ('c0000000-0000-0000-0000-000000000132', 'Big 132', 'big-132');
INSERT INTO auth.users (id, email) VALUES ('c0000000-0000-0000-0000-0000000001c1', 'admin.c132@example.test');
INSERT INTO public.user_profiles (id, email, role, organization_id, active, must_change_password)
VALUES ('c0000000-0000-0000-0000-0000000001c1', 'admin.c132@example.test', 'admin', 'c0000000-0000-0000-0000-000000000132', TRUE, FALSE)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, active = TRUE, must_change_password = FALSE;
INSERT INTO public.organization_members (user_id, organization_id, role, hidden_sections, active)
VALUES ('c0000000-0000-0000-0000-0000000001c1', 'c0000000-0000-0000-0000-000000000132', 'admin', '{}', TRUE);
SET LOCAL session_replication_role = replica;
INSERT INTO public.rfqs(id, organization_id, customer, status)
SELECT md5('132-rfq-' || g)::uuid, 'c0000000-0000-0000-0000-000000000132', 'Customer ' || (g % 40), (ARRAY['new', 'clarification', 'ready', 'quoted'])[1 + g % 4] FROM generate_series(1, 600) g;
INSERT INTO public.quotes(id, organization_id, quote_ref, version, customer, status, valid_until, total_value, vat_enabled, sent_at, accepted_at, rfq_id, created_at)
SELECT md5('132-q-' || g)::uuid, 'c0000000-0000-0000-0000-000000000132', 'QUO-' || lpad(g::text, 5, '0'), 1, 'Customer ' || (g % 40),
       (ARRAY['draft', 'sent', 'accepted', 'rejected'])[1 + g % 4], DATE '2026-10-20' + (g % 90) - 45, round((g * 37.13)::numeric % 20000, 2), TRUE,
       TIMESTAMPTZ '2026-10-20 12:00+00' - (g % 365) * INTERVAL '1 day', CASE WHEN g % 4 = 2 THEN TIMESTAMPTZ '2026-10-20 12:00+00' - (g % 60) * INTERVAL '1 day' END,
       CASE WHEN g <= 600 AND g % 2 = 0 THEN md5('132-rfq-' || g)::uuid END, TIMESTAMPTZ '2026-10-20 12:00+00' - (g % 365) * INTERVAL '1 day'
FROM generate_series(1, 3000) g;
INSERT INTO public.quote_line_items(organization_id, quote_id, description, quantity, unit_price, vat_pct, vat_exempt, declined)
SELECT 'c0000000-0000-0000-0000-000000000132', md5('132-q-' || (g * 10))::uuid, 'Declined line ' || g, 1 + g % 5, 12.50, 20, FALSE, TRUE FROM generate_series(1, 300) g;
INSERT INTO public.invoices(id, organization_id, invoice_ref, customer, status, total, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified)
SELECT md5('132-i-' || g)::uuid, 'c0000000-0000-0000-0000-000000000132', 'INV-' || lpad(g::text, 5, '0'), 'Customer ' || (g % 40),
       (ARRAY['issued', 'partial', 'sent', 'overdue', 'draft'])[1 + g % 5], round((g * 19.37)::numeric % 9000, 2), CASE WHEN g % 5 = 1 THEN 10 ELSE 0 END, 0, 0,
       DATE '2026-10-20' - (g % 120) + 30, g % 97 = 0
FROM generate_series(1, 5000) g;
SET LOCAL session_replication_role = origin;
ANALYZE public.quotes; ANALYZE public.rfqs; ANALYZE public.invoices; ANALYZE public.quote_line_items;
SELECT set_config('request.jwt.claims', '{"sub":"c0000000-0000-0000-0000-0000000001c1","role":"authenticated","aal":"aal2"}', true),
       set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-0000000001c1', true) \g /dev/null
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE m(n int, way text, what text, requests int, bytes bigint, ms numeric);
-- The best of 5 runs; requests and bytes. p_paged: p_sql is a SELECT ... (no ORDER BY) read page by page like lib/fetch-all; otherwise
-- p_sql is one call returning one text value.
CREATE FUNCTION pg_temp.measure(p_n int, p_way text, p_what text, p_sql text, p_paged boolean) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE t0 timestamptz; best numeric := NULL; v text; i int; v_requests int; v_bytes bigint; v_page int; v_rows int;
BEGIN
  FOR i IN 1..5 LOOP
    t0 := clock_timestamp();
    v_requests := 0; v_bytes := 0;
    IF p_paged THEN
      v_page := 0;
      LOOP
        EXECUTE format('SELECT coalesce(json_agg(t), ''[]'')::text, count(*) FROM (%s ORDER BY id OFFSET %s LIMIT 1000) t', p_sql, v_page * 1000) INTO v, v_rows;
        v_requests := v_requests + 1; v_bytes := v_bytes + length(v);
        EXIT WHEN v_rows = 0;
        v_page := v_page + 1;
      END LOOP;
    ELSE
      EXECUTE p_sql INTO v;
      v_requests := 1; v_bytes := length(v);
    END IF;
    best := least(coalesce(best, 1e9), extract(epoch FROM clock_timestamp() - t0) * 1000);
  END LOOP;
  INSERT INTO m VALUES (p_n, p_way, p_what, v_requests, v_bytes, round(best, 2));
END $f$;
\o /dev/null
SELECT pg_temp.measure(1, 'before', 'quotes (all)', 'SELECT id, quote_ref, version, status, valid_until, total_value, vat_enabled, sent_at, accepted_at, rfq_id, created_at FROM public.quotes', TRUE);
SELECT pg_temp.measure(2, 'before', 'declined quote lines (all)', 'SELECT id, quote_id, quantity, unit_price, vat_pct, vat_exempt FROM public.quote_line_items WHERE declined = TRUE', TRUE);
SELECT pg_temp.measure(3, 'before', 'rfqs (all)', 'SELECT id, status FROM public.rfqs', TRUE);
SELECT pg_temp.measure(4, 'before', 'unpaid invoices (all)', $$SELECT id, invoice_ref, customer, total, status, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified FROM public.invoices WHERE status <> 'paid'$$, TRUE);
SELECT pg_temp.measure(11, 'after', 'dashboard_open_quotes', $$SELECT public.dashboard_open_quotes('2026-10-20')::text$$, FALSE);
SELECT pg_temp.measure(12, 'after', 'dashboard_quotes_sent', $$SELECT public.dashboard_quotes_sent('2026-10-01')::text$$, FALSE);
SELECT pg_temp.measure(13, 'after', 'dashboard_quotes_won', $$SELECT public.dashboard_quotes_won('2026-10-01')::text$$, FALSE);
SELECT pg_temp.measure(14, 'after', 'dashboard_quote_outcomes', $$SELECT public.dashboard_quote_outcomes('2026-07-22', '2026-10-20')::text$$, FALSE);
SELECT pg_temp.measure(15, 'after', 'dashboard_rfqs_to_quote', $$SELECT public.dashboard_rfqs_to_quote()::text$$, FALSE);
SELECT pg_temp.measure(16, 'after', 'dashboard_money_owed', $$SELECT public.dashboard_money_owed('2026-10-20')::text$$, FALSE);
\o
\unset QUIET
\pset footer off
SELECT way, what, requests, bytes, ms FROM m ORDER BY n;
SELECT way, sum(requests) AS requests, sum(bytes) AS bytes, sum(ms) AS ms FROM m GROUP BY way ORDER BY way DESC;
ROLLBACK;

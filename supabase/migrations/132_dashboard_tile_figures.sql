-- =====================================================================================================
-- 132: the dashboard's tile figures counted and added up in the database (E6, ISO 9001 item: dashboard speed).
-- NUMBERING (provisional): 132 is a working number (Design owns 130+); the final number is given at merge.
-- Needs 027 (payment_unverified), 034 (credited_amount, refunded_amount), 058/020 (accepted_at) and 068 (quote versions).
-- Touches no existing object.
--
-- BEFORE: to show Open quotes, Quotes sent, Quotes won, Quotes last 90 days, RFQs to quote, the quote pipeline, Money owed, Money owed
-- by age and the "payment to confirm" item, the page read EVERY quote, every declined quote line, every RFQ and every unpaid invoice
-- into the browser, 1,000 rows per request (lib/fetch-all), and counted and added them up there; past 20,000 rows a figure was blanked.
-- AFTER: one call per tile. Six read-only functions return the same counts and sums (whole pence), a few dozen bytes each, whatever
-- the company's size. lib/dashboard-tile-figures.ts turns them into the figures the page showed (same rules, same rounding on screen);
-- until 132 is applied the page uses the old reads (moved verbatim to the same file), so it works on either side of the release.
-- Every figure is a whole number (counts, pence), never a float: a float's text in JSON depends on the session's extra_float_digits
-- (Supabase's server sets 0, PostgreSQL's default is 1), so the same sum could print as 634.32 or 634.3200000000002.
--
-- WHAT CHANGES. Six new functions, nothing else: no table, column, row, policy, trigger or existing function is changed.
--   public.dashboard_open_quotes(today)          Open quotes tile + pipeline: sent and undecided, their value; accepted count.
--   public.dashboard_quotes_sent(since)          Quotes sent tile: quotes sent since the first of the month, each quote once.
--   public.dashboard_quotes_won(since)           Quotes won tile: accepted since the first of the month (London date), and undated.
--   public.dashboard_quote_outcomes(since, today) Quotes, last 90 days: how the quotes sent since then ended.
--   public.dashboard_rfqs_to_quote()             RFQs to quote tile + pipeline: RFQs with no quote and not marked quoted.
--   public.dashboard_money_owed(today)           Money owed tile, Money owed by age, payment-to-confirm count.
-- All six are SECURITY INVOKER (never definer), STABLE and read only: they read the tables as the caller, so every row-level rule
-- (company, role, hidden sections) applies exactly as it did to the browser's own reads; a company only ever counts its own rows.
-- EXECUTE: authenticated only (revoked from PUBLIC and anon).
-- Each rule is the app's (named beside it). Text is trimmed and compared as JavaScript does (String.prototype.trim's whitespace).
-- Timestamps the app cut to their first ten characters (sent_at) are cut in the session's time zone, as PostgREST prints them; dates
-- the app read in London (accepted_at, lib/dates calendarDate) are read in Europe/London.
-- GUARD (section 1): the columns read exist; each function is absent or already 132's. Safe to run again.
-- Rollback: supabase/release/132_dashboard_tile_figures.rollback.sql (only with Rhys's approval). Verify: supabase/verify/dashboard_tiles_132.sql.
-- =====================================================================================================

-- 1. The guard.
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT string_agg(want.t || '.' || want.c, ', ') INTO v_missing
  FROM (VALUES ('quotes', 'status'), ('quotes', 'valid_until'), ('quotes', 'total_value'), ('quotes', 'sent_at'), ('quotes', 'accepted_at'),
               ('quotes', 'quote_ref'), ('quotes', 'version'), ('quotes', 'rfq_id'), ('rfqs', 'status'),
               ('invoices', 'status'), ('invoices', 'total'), ('invoices', 'amount_paid'), ('invoices', 'credited_amount'),
               ('invoices', 'refunded_amount'), ('invoices', 'due_date'), ('invoices', 'payment_unverified')) AS want(t, c)
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = want.t AND i.column_name = want.c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '132: columns the dashboard tiles read are missing (%); apply 027, 034 and 068 first', v_missing;
  END IF;
  -- 132's bodies, md5 with every whitespace character removed (section 2): open_quotes, quotes_sent, quotes_won, quote_outcomes,
  -- rfqs_to_quote, money_owed.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proname IN ('dashboard_open_quotes', 'dashboard_quotes_sent', 'dashboard_quotes_won', 'dashboard_quote_outcomes',
                                 'dashboard_rfqs_to_quote', 'dashboard_money_owed')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) NOT IN (
                 'd2c5bd23f4c46c421b989012e74c2e80', '308be040514eab13aca8cf86dd7f2c63', 'd2ca2c957383ede97833c95b84b0f8fa',
                 '774a67cfe0e7fd2f013f7fd3abcc7dad', 'feb2db260235700a2166bb4c1a550467', '214295752bb751f03a74c767b090e8c0')) THEN
    RAISE EXCEPTION '132: a dashboard tile function already exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The functions.

-- Open quotes (lib/quote-status quoteFigures over every quote: open = sent, still valid, no decision), the pipeline's accepted count.
-- storedQuoteStatus: lower-cased, anything unknown is a draft; effectiveQuoteStatus: an undecided quote past valid_until is expired.
CREATE OR REPLACE FUNCTION public.dashboard_open_quotes(p_today DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH s AS (
    SELECT CASE WHEN lower(coalesce(x.status, 'draft')) IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded')
                THEN lower(coalesce(x.status, 'draft')) ELSE 'draft' END AS stored,
           x.valid_until, round(coalesce(x.total_value, 0) * 100)::BIGINT AS pence
    FROM public.quotes x
  ),
  q AS (SELECT CASE WHEN s.stored IN ('sent', 'draft') AND s.valid_until < p_today THEN 'expired' ELSE s.stored END AS status, s.pence FROM s)
  SELECT jsonb_build_object(
    'open_count', count(*) FILTER (WHERE q.status = 'sent'),
    'open_pence', coalesce(sum(q.pence) FILTER (WHERE q.status = 'sent'), 0),
    'accepted_count', count(*) FILTER (WHERE q.status = 'accepted'))
  FROM q
$$;

-- Quotes sent since p_since (lib/quote-status sentSince): each quote once however many versions were sent ("QUO-1" and "QUO-1 v2",
-- lib/quote-versions baseQuoteRef: version > 1 drops a trailing " vN"); a quote with no reference counts on its own.
CREATE OR REPLACE FUNCTION public.dashboard_quotes_sent(p_since DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH s AS (
    SELECT x.quote_ref IS NOT NULL AND x.quote_ref <> '' AS has_ref,
           CASE WHEN coalesce(nullif(x.version, 0), 1) > 1
                THEN regexp_replace(x.quote_ref, '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+v[0-9]+[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$', '')
                ELSE x.quote_ref END AS base
    FROM public.quotes x
    WHERE x.sent_at::DATE >= p_since
  )
  SELECT jsonb_build_object('count', count(DISTINCT s.base) FILTER (WHERE s.has_ref) + count(*) FILTER (WHERE NOT s.has_ref))
  FROM s
$$;

-- Quotes won since p_since (lib/overview-metrics quotesWon): status accepted (trimmed, any case), counted by the London date of
-- accepted_at; accepted with no date is undated (shown, not counted).
CREATE OR REPLACE FUNCTION public.dashboard_quotes_won(p_since DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH s AS (
    SELECT x.accepted_at FROM public.quotes x
    WHERE lower(regexp_replace(coalesce(x.status, ''), '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')) = 'accepted'
  )
  SELECT jsonb_build_object(
    'count', count(*) FILTER (WHERE (s.accepted_at AT TIME ZONE 'Europe/London')::DATE >= p_since),
    'undated', count(*) FILTER (WHERE s.accepted_at IS NULL))
  FROM s
$$;

-- Quotes sent since p_since, by how they ended (lib/dashboard-analytics quoteOutcomes over lib/quote-status quoteFigures); expired_sent
-- (expired after being sent) is what the win rate's denominator needs.
CREATE OR REPLACE FUNCTION public.dashboard_quote_outcomes(p_since DATE, p_today DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH s AS (
    SELECT CASE WHEN lower(coalesce(x.status, 'draft')) IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded')
                THEN lower(coalesce(x.status, 'draft')) ELSE 'draft' END AS stored,
           x.valid_until
    FROM public.quotes x
    WHERE x.sent_at::DATE >= p_since
  ),
  q AS (SELECT s.stored, CASE WHEN s.stored IN ('sent', 'draft') AND s.valid_until < p_today THEN 'expired' ELSE s.stored END AS status FROM s)
  SELECT jsonb_build_object(
    'accepted', count(*) FILTER (WHERE q.status = 'accepted'),
    'sent', count(*) FILTER (WHERE q.status = 'sent'),
    'expired', count(*) FILTER (WHERE q.status = 'expired'),
    'rejected', count(*) FILTER (WHERE q.status = 'rejected'),
    'expired_sent', count(*) FILTER (WHERE q.status = 'expired' AND q.stored = 'sent'))
  FROM q
$$;

-- RFQs to quote (lib/rfq-stage rfqFigures outstanding): no quote linked to it (any the caller can see) and not marked quoted
-- (a blank status is new).
CREATE OR REPLACE FUNCTION public.dashboard_rfqs_to_quote()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object('outstanding', count(*))
  FROM public.rfqs r
  WHERE coalesce(nullif(r.status, ''), 'new') <> 'quoted'
    AND NOT EXISTS (SELECT 1 FROM public.quotes x WHERE x.rfq_id = r.id)
$$;

-- Money owed (lib/receivables owed, lib/dashboard-analytics owedByAge), over the invoices whose stored status is not 'paid':
--   to_confirm: those whose payment is still to be confirmed (payment_unverified, 027), whatever their status;
--   invoices / owed: the collectible ones (trimmed, lower-cased status, blank = draft; not paid, draft, void, voided, cancelled,
--     canceled, credited or written_off) with payment confirmed, and what is owed on them: total - paid - credited + refunded, never
--     below zero. owed_pence is that total in whole pence, exact (the page added pounds as floats, so its total could be a hair off
--     the exact pence; on screen, in whole pounds, the two are the same except where the exact total ends in exactly 50p and the float
--     sum fell just below it: there the page showed a pound less than the exact total rounds to, and now shows the exact rounding);
--   the age buckets: those with something owed, in whole pence, by days past the due date (none = not due).
CREATE OR REPLACE FUNCTION public.dashboard_money_owed(p_today DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH r AS (
    SELECT x.id, x.due_date, coalesce(x.payment_unverified, FALSE) AS unverified,
           nullif(lower(regexp_replace(coalesce(x.status, ''), '^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')), '') AS status,
           greatest(0, round(coalesce(x.total, 0) * 100)::BIGINT - round(coalesce(x.amount_paid, 0) * 100)::BIGINT
                       - round(coalesce(x.credited_amount, 0) * 100)::BIGINT + round(coalesce(x.refunded_amount, 0) * 100)::BIGINT) AS pence
    FROM public.invoices x
    WHERE x.status <> 'paid'
  ),
  o AS (
    SELECT r.id, r.pence, CASE WHEN r.due_date IS NULL THEN 0 ELSE p_today - r.due_date END AS late
    FROM r
    WHERE NOT r.unverified AND coalesce(r.status, 'draft') NOT IN ('paid', 'draft', 'void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off')
  )
  SELECT jsonb_build_object(
    'to_confirm', (SELECT count(*) FROM r WHERE r.unverified),
    'invoices', count(*),
    'owed_pence', coalesce(sum(o.pence), 0),
    'not_due', coalesce(sum(o.pence) FILTER (WHERE o.pence > 0 AND o.late <= 0), 0),
    'late_1_30', coalesce(sum(o.pence) FILTER (WHERE o.pence > 0 AND o.late BETWEEN 1 AND 30), 0),
    'late_31_60', coalesce(sum(o.pence) FILTER (WHERE o.pence > 0 AND o.late BETWEEN 31 AND 60), 0),
    'late_60_plus', coalesce(sum(o.pence) FILTER (WHERE o.pence > 0 AND o.late > 60), 0))
  FROM o
$$;

-- -----------------------------------------------------------------------------------------------------
-- 3. Who may call them: signed-in users only (each reads as the caller, so row-level security decides what is counted).
REVOKE ALL ON FUNCTION public.dashboard_open_quotes(DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_quotes_sent(DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_quotes_won(DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_quote_outcomes(DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_rfqs_to_quote() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_money_owed(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_open_quotes(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_quotes_sent(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_quotes_won(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_quote_outcomes(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_rfqs_to_quote() TO authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_money_owed(DATE) TO authenticated;

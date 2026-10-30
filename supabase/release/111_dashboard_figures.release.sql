-- 111_dashboard_figures.sql: applied as ONE transaction. Run the whole text; if anything fails, nothing of this file is kept.
BEGIN;

-- =====================================================================================================
-- 111: the dashboard's figures worked out in the database (E6, ISO 9001 item: the owner's Overview and the office dashboard were
-- slow). NUMBERING (provisional): numbers are settled at merge. Needs 032 (invoice_payments), 034 (credited_amount), 068 (quote
-- versions) and 081 (job flow). Touches no object of 000 to 101.
--
-- Before 111 the dashboard read every quote, RFQ, open job, job finished in six months, inspection, unpaid invoice, paid invoice and
-- payment in six months into the browser, 1,000 rows per request (lib/fetch-all), to count and add them up there; past 20,000 rows a
-- figure was blanked. 111 adds two read-only functions that return the same counts and sums, so the page makes two requests and
-- receives a few hundred bytes, whatever the company's size. lib/dashboard-figures.ts turns them into the page's figures with the
-- same arithmetic as before (rounding, labels, traffic lights); before 111 is applied it falls back to the old reads
-- (lib/dashboard-figures-legacy.ts), so the page works on either side of the release.
--
-- WHAT CHANGES. Two new functions, nothing else: no table, column, row, policy, trigger or existing function is changed.
--   public.dashboard_work_figures(...)  quotes, RFQs, jobs, inspections, machine load and e-mails awaiting approval;
--   public.dashboard_money_figures(...) invoices and payments (the owner's dashboard only; the office one does not ask).
-- Both are SECURITY INVOKER (never definer), STABLE and read only: they read the tables as the caller, so every row-level rule
-- (company, role, hidden sections) applies exactly as it did to the browser's own reads, and a company only ever counts its own rows.
-- EXECUTE: authenticated only (revoked from PUBLIC and anon).
-- Each rule is the one the app used (named beside it): lib/quote-status, lib/rfq-stage, lib/job-flow, lib/job-status,
-- lib/receivables and lib/dashboard-analytics. Dates the browser works out (today in the UK, the week, the six months) are passed in.
-- GUARD (section 1): the columns the functions read exist; each function is absent or already 111's. Safe to run again.
-- SELF-CHECK (section 4). Rollback: supabase/release/111_dashboard_figures.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- 1. The guard: what the functions read is there, and neither function exists with another body.
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT string_agg(want.t || '.' || want.c, ', ') INTO v_missing
  FROM (VALUES ('quotes', 'status'), ('quotes', 'valid_until'), ('quotes', 'total_value'), ('quotes', 'sent_at'), ('quotes', 'quote_ref'),
               ('quotes', 'version'), ('quotes', 'rfq_id'), ('rfqs', 'status'), ('jobs', 'stage'), ('jobs', 'started_at'), ('jobs', 'finished_at'),
               ('jobs', 'inspected_at'), ('jobs', 'date_required'), ('jobs', 'due_date'), ('job_inspections', 'job_id'), ('job_inspections', 'result'),
               ('job_inspections', 'inspected_at'), ('machines', 'hours_per_day'), ('machines', 'working_days'), ('machine_bookings', 'machine_id'),
               ('machine_bookings', 'start_at'), ('machine_bookings', 'estimated_hours'), ('email_history', 'status'), ('email_history', 'skipped_until'),
               ('invoices', 'status'), ('invoices', 'total'), ('invoices', 'amount_paid'), ('invoices', 'credited_amount'), ('invoices', 'refunded_amount'),
               ('invoices', 'due_date'), ('invoices', 'payment_unverified'), ('invoices', 'paid_at'), ('invoices', 'invoice_date'), ('invoices', 'customer'),
               ('invoice_payments', 'amount'), ('invoice_payments', 'paid_on')) AS want(t, c)
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns i WHERE i.table_schema = 'public' AND i.table_name = want.t AND i.column_name = want.c);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '111: columns the dashboard figures read are missing (%); apply 032, 034, 068 and 081 first', v_missing;
  END IF;
  -- 111's bodies, md5 with every whitespace character removed: 8d4725ea... dashboard_work_figures (section 2), d57a0bd6... dashboard_money_figures (section 3).
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname IN ('dashboard_work_figures', 'dashboard_money_figures')
               AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) NOT IN ('8d4725ea13d23d27ae0be5cbfbfd012d', 'd57a0bd65b8669a48e171dbe49bd95ab')) THEN
    RAISE EXCEPTION '111: a dashboard figures function already exists with another body; stop and compare it first';
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The work figures. p_today: today in the UK (lib/dates dueWindow); p_week_end: the last day of "due within 7 days"; p_since: the
-- first day of the six months; p_month_start: the first of this month; p_quotes_since: 90 days ago; p_week_start / p_week_stop: this
-- week, Monday 00:00 to the next Monday, for machine load; p_now: now, for e-mails skipped until later.
CREATE OR REPLACE FUNCTION public.dashboard_work_figures(
  p_today DATE, p_week_end DATE, p_since DATE, p_month_start DATE, p_quotes_since DATE,
  p_week_start TIMESTAMPTZ, p_week_stop TIMESTAMPTZ, p_now TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH
  -- Each table is read once (every row the caller may see, as the page read them); the figures are counted from that.
  -- lib/quote-status storedQuoteStatus and effectiveQuoteStatus: an undecided quote past its valid-until date is expired.
  q AS MATERIALIZED (
    SELECT s.*, CASE WHEN s.stored IN ('sent', 'draft') AND s.valid_until < p_today THEN 'expired' ELSE s.stored END AS status
    FROM (
      SELECT x.quote_ref, x.version, x.sent_at, x.valid_until, x.rfq_id, round(coalesce(x.total_value, 0) * 100) AS pence,
             CASE WHEN lower(coalesce(x.status, 'draft')) IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded')
                  THEN lower(coalesce(x.status, 'draft')) ELSE 'draft' END AS stored
      FROM public.quotes x
    ) s
  ),
  -- Quotes sent in the last 90 days, by how they ended (lib/dashboard-analytics quoteOutcomes).
  q90 AS (SELECT * FROM q WHERE q.sent_at::DATE >= p_quotes_since),
  -- Quotes sent this month, each quote once however many of its versions went (lib/quote-status sentSince, lib/quote-versions baseQuoteRef).
  qmonth AS (
    SELECT coalesce(q.quote_ref, '') <> '' AS has_ref,
           CASE WHEN coalesce(nullif(q.version, 0), 1) > 1 THEN regexp_replace(q.quote_ref, '\s+v\d+\s*$', '') ELSE q.quote_ref END AS base
    FROM q WHERE q.sent_at::DATE >= p_month_start
  ),
  j AS MATERIALIZED (
    SELECT x.stage, x.started_at, x.finished_at, x.inspected_at, x.date_required, x.due_date,
           coalesce(x.date_required, x.due_date) AS required,
           -- Open: not Complete (lib/job-flow OPEN_JOBS_FILTER).
           (x.stage = 'rework' OR x.inspected_at IS NULL) AS open
    FROM public.jobs x
    -- Only the jobs a figure counts (open, unfinished, or finished in the six months), so older Complete jobs are never read.
    WHERE x.stage = 'rework' OR x.inspected_at IS NULL OR x.finished_at IS NULL OR x.finished_at >= p_since::TIMESTAMPTZ
  ),
  -- The first inspection of each job inspected in the six months (lib/dashboard-analytics rightFirstTime).
  first_inspection AS (
    SELECT DISTINCT ON (i.job_id) i.result
    FROM public.job_inspections i
    WHERE i.inspected_at >= p_since::TIMESTAMPTZ
    ORDER BY i.job_id, i.inspected_at, i.id
  )
  SELECT jsonb_build_object(
    'quotes', (SELECT jsonb_build_object(
      'open_count', count(*) FILTER (WHERE q.status = 'sent'),
      'open_pence', coalesce(sum(q.pence) FILTER (WHERE q.status = 'sent'), 0),
      'accepted_count', count(*) FILTER (WHERE q.status = 'accepted')) FROM q),
    'quotes_90', (SELECT jsonb_build_object(
      'accepted', count(*) FILTER (WHERE q90.status = 'accepted'),
      'sent', count(*) FILTER (WHERE q90.status = 'sent'),
      'expired', count(*) FILTER (WHERE q90.status = 'expired'),
      'rejected', count(*) FILTER (WHERE q90.status = 'rejected'),
      'expired_sent', count(*) FILTER (WHERE q90.status = 'expired' AND q90.stored = 'sent')) FROM q90),
    'quotes_sent_this_month', (SELECT count(DISTINCT qmonth.base) FILTER (WHERE qmonth.has_ref)
                                      + count(*) FILTER (WHERE NOT qmonth.has_ref) FROM qmonth),
    -- Outstanding: no quote yet and not marked quoted (lib/rfq-stage rfqStage, rfqFigures).
    'rfqs_outstanding', (SELECT count(*) FROM public.rfqs r
                         WHERE coalesce(nullif(r.status, ''), 'new') <> 'quoted'
                           AND NOT EXISTS (SELECT 1 FROM q WHERE q.rfq_id = r.id)),
    'jobs', (SELECT jsonb_build_object(
      'open', count(*) FILTER (WHERE j.open),
      -- lib/job-flow openJobsDueFilter: open, and the required date or the due date from today to the week's end.
      'due_week', count(*) FILTER (WHERE j.open AND ((j.date_required >= p_today AND j.date_required <= p_week_end)
                                                    OR (j.due_date >= p_today AND j.due_date <= p_week_end))),
      -- lib/job-status: late = unfinished and the required date before today; dated = unfinished with a required date.
      'late', count(*) FILTER (WHERE j.finished_at IS NULL AND (j.date_required < p_today OR (j.date_required IS NULL AND j.due_date < p_today))),
      'dated', count(*) FILTER (WHERE j.finished_at IS NULL AND (j.date_required IS NOT NULL OR j.due_date IS NOT NULL)),
      -- lib/job-flow jobStatusOf over the open jobs; lib/dashboard-analytics jobsByStatus (late and due soon: unfinished only).
      'not_started', count(*) FILTER (WHERE j.open AND j.stage IS DISTINCT FROM 'rework' AND j.finished_at IS NULL AND j.started_at IS NULL),
      'running', count(*) FILTER (WHERE j.open AND (j.stage = 'rework' OR (j.finished_at IS NULL AND j.started_at IS NOT NULL))),
      'waiting', count(*) FILTER (WHERE j.open AND j.stage IS DISTINCT FROM 'rework' AND j.finished_at IS NOT NULL),
      'overdue', count(*) FILTER (WHERE j.open AND j.finished_at IS NULL AND j.required < p_today),
      'due_soon', count(*) FILTER (WHERE j.open AND j.finished_at IS NULL AND j.required >= p_today AND j.required <= p_today + 7)) FROM j),
    -- Open jobs coming due on each of the next 14 days (lib/dashboard-analytics workloadDue).
    'due_days', (SELECT coalesce(jsonb_object_agg(d.day, d.n), '{}'::JSONB) FROM (
      SELECT to_char(j.required, 'YYYY-MM-DD') AS day, count(*) AS n FROM j
      WHERE j.open AND j.required >= p_today AND j.required <= p_today + 13 GROUP BY j.required) d),
    -- Jobs finished in each month of the six, with a required date, and how many by that date (lib/dashboard-analytics onTimeByMonth).
    'finished_by_month', (SELECT coalesce(jsonb_object_agg(m.month, jsonb_build_object('dated', m.dated, 'on_time', m.on_time)), '{}'::JSONB) FROM (
      SELECT to_char(j.finished_at, 'YYYY-MM') AS month, count(*) FILTER (WHERE j.required IS NOT NULL) AS dated,
             count(*) FILTER (WHERE j.required IS NOT NULL AND j.finished_at::DATE <= j.required) AS on_time
      FROM j WHERE j.finished_at >= p_since::TIMESTAMPTZ GROUP BY 1) m),
    'right_first_time', (SELECT jsonb_build_object('jobs', count(*), 'passed', count(*) FILTER (WHERE f.result = 'pass')) FROM first_inspection f),
    -- Each machine (by name) with the hours booked on it this week (lib/dashboard-analytics machineLoad works out the share).
    'machines', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'hours_per_day', m.hours_per_day,
                                                               'working_days', m.working_days, 'booked', m.booked) ORDER BY m.name, m.id), '[]'::JSONB) FROM (
      SELECT x.id, x.name, x.hours_per_day, x.working_days,
             (SELECT coalesce(sum(coalesce(b.estimated_hours, 0)), 0) FROM public.machine_bookings b
              WHERE b.machine_id = x.id AND b.start_at >= p_week_start AND b.start_at < p_week_stop) AS booked
      FROM public.machines x) m),
    -- E-mails drafted and waiting for approval, not skipped until later (lib/approval-queue awaitingApproval).
    'drafts', (SELECT count(*) FROM public.email_history e WHERE e.status = 'drafted' AND (e.skipped_until IS NULL OR e.skipped_until < p_now))
  )
$$;
REVOKE ALL ON FUNCTION public.dashboard_work_figures(DATE, DATE, DATE, DATE, DATE, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_work_figures(DATE, DATE, DATE, DATE, DATE, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 3. The money figures (lib/receivables invoiceLifecycle and owed; lib/dashboard-analytics owedByAge and topCustomers). p_today: today
-- in the UK; p_since: the first day of the six months. Amounts are whole pence.
CREATE OR REPLACE FUNCTION public.dashboard_money_figures(p_today DATE, p_since DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH
  -- Every invoice the caller may see, read once.
  inv AS MATERIALIZED (
    SELECT x.id, x.status AS raw_status, x.payment_unverified, x.due_date, x.customer, x.total, x.paid_at, x.invoice_date, x.created_at,
           x.amount_paid, x.credited_amount, x.refunded_amount
    FROM public.invoices x
  ),
  -- Every invoice not marked paid (the dashboard's read: status <> 'paid', so an invoice with no status is not in it).
  unpaid AS (
    SELECT x.payment_unverified,
           coalesce(nullif(lower(regexp_replace(x.raw_status, '^\s+|\s+$', '', 'g')), ''), 'draft') AS status,
           x.due_date,
           greatest(0, round(coalesce(x.total, 0) * 100) - round(coalesce(x.amount_paid, 0) * 100)
                       - round(coalesce(x.credited_amount, 0) * 100) + round(coalesce(x.refunded_amount, 0) * 100)) AS owed
    FROM inv x WHERE x.raw_status <> 'paid'
  ),
  -- Collectible (not paid, not closed) and its payment confirmed: what counts as owed.
  owing AS (
    SELECT u.owed, CASE WHEN u.due_date IS NULL THEN 0 ELSE p_today - u.due_date END AS late
    FROM unpaid u
    WHERE u.status <> 'paid' AND u.status NOT IN ('draft', 'void', 'voided', 'cancelled', 'canceled', 'credited', 'written_off')
      AND NOT coalesce(u.payment_unverified, FALSE)
  ),
  -- Paid invoices paid, dated or made in the six months (the same read as before).
  paid AS (
    SELECT x.id, x.customer, x.total, x.paid_at, x.invoice_date
    FROM inv x
    WHERE x.raw_status = 'paid' AND (x.paid_at >= p_since::TIMESTAMPTZ OR x.invoice_date >= p_since OR x.created_at >= p_since::TIMESTAMPTZ)
  )
  SELECT jsonb_build_object(
    'to_confirm', (SELECT count(*) FROM unpaid u WHERE u.payment_unverified),
    'unpaid_count', (SELECT count(*) FROM owing),
    'owed_pence', (SELECT coalesce(sum(o.owed), 0) FROM owing o),
    'owed_by_age', (SELECT jsonb_build_object(
      'not_due', coalesce(sum(o.owed) FILTER (WHERE o.late <= 0), 0),
      'late_1_30', coalesce(sum(o.owed) FILTER (WHERE o.late BETWEEN 1 AND 30), 0),
      'late_31_60', coalesce(sum(o.owed) FILTER (WHERE o.late BETWEEN 31 AND 60), 0),
      'late_60_plus', coalesce(sum(o.owed) FILTER (WHERE o.late > 60), 0)) FROM owing o WHERE o.owed > 0),
    'paid_count', (SELECT count(*) FROM inv x WHERE x.raw_status = 'paid'),
    -- Invoice date (midnight UTC, as the browser reads a date) to the time it was paid, in days, summed, and how many.
    'days_to_pay', (SELECT jsonb_build_object(
      'sum', coalesce(sum((extract(EPOCH FROM p.paid_at) - extract(EPOCH FROM p.invoice_date::TIMESTAMP AT TIME ZONE 'UTC')) / 86400), 0),
      'count', count(*)) FROM paid p WHERE p.paid_at IS NOT NULL AND p.invoice_date IS NOT NULL),
    -- The five customers with the most paid in the six months (by the date paid), largest first; on a tie, the one met first.
    'top_customers', (SELECT coalesce(jsonb_agg(jsonb_build_object('customer', c.customer, 'pence', c.pence) ORDER BY c.pence DESC, c.first_id), '[]'::JSONB) FROM (
      SELECT t.customer, sum(t.pence) AS pence, min(t.id::TEXT) AS first_id FROM (
        SELECT p.id, coalesce(nullif(regexp_replace(p.customer, '^\s+|\s+$', '', 'g'), ''), 'No customer') AS customer,
               round(coalesce(p.total, 0) * 100) AS pence
        FROM paid p WHERE p.paid_at IS NOT NULL AND p.paid_at::DATE >= p_since) t
      GROUP BY t.customer ORDER BY sum(t.pence) DESC, min(t.id::TEXT) LIMIT 5) c),
    -- Money received in each month, from the payment rows by the date received, reversals included (migration 032).
    'received_by_month', (SELECT coalesce(jsonb_object_agg(r.month, r.pence), '{}'::JSONB) FROM (
      SELECT to_char(x.paid_on, 'YYYY-MM') AS month, sum(round(coalesce(x.amount, 0) * 100)) AS pence
      FROM public.invoice_payments x WHERE x.paid_on >= p_since GROUP BY 1) r)
  )
$$;
REVOKE ALL ON FUNCTION public.dashboard_money_figures(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_money_figures(DATE, DATE) TO authenticated;

-- -----------------------------------------------------------------------------------------------------
-- 4. Self-check before COMMIT (the same checks as supabase/verify/dashboard_figures_111.sql).
DO $$
DECLARE
  v_fn REGPROCEDURE;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[to_regprocedure('public.dashboard_work_figures(date,date,date,date,date,timestamp with time zone,timestamp with time zone,timestamp with time zone)'),
                              to_regprocedure('public.dashboard_money_figures(date,date)')] LOOP
    IF v_fn IS NULL THEN
      RAISE EXCEPTION '111: a dashboard figures function is missing';
    END IF;
    IF (SELECT p.prosecdef OR p.provolatile <> 's' FROM pg_proc p WHERE p.oid = v_fn) THEN
      RAISE EXCEPTION '111: % must be SECURITY INVOKER and STABLE', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '111: % must be callable by authenticated only', v_fn;
    END IF;
  END LOOP;
END
$$;

COMMIT;

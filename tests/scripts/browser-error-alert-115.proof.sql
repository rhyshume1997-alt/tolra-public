-- Proof for migration 115 (browser error alert budget, finding S4-F1). Run by tests/scripts/browser-error-alert-115.test.sh on a COPY
-- of a database with 000..101 + 115 applied. Every check RAISEs on failure (psql stops with ON_ERROR_STOP); the last line printed is PROOF OK.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

CREATE FUNCTION pg_temp.must(label TEXT, ok BOOLEAN) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'PROOF FAILED: %', label; END IF;
  RAISE NOTICE 'ok  %', label;
END
$$;
-- Distinct valid fingerprints (12 hex characters) by number.
CREATE FUNCTION pg_temp.fp(n INT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT lpad(to_hex(n), 12, '0') $$;
CREATE FUNCTION pg_temp.u(n INT) RETURNS UUID LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.bclaim(f INT, u INT, c INT DEFAULT NULL) RETURNS BOOLEAN LANGUAGE sql AS $$
  SELECT public.claim_browser_error_alert(pg_temp.fp(f), pg_temp.u(u), CASE WHEN c IS NULL THEN NULL ELSE pg_temp.u(1000 + c) END) $$;
CREATE FUNCTION pg_temp.sclaim(f INT) RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT public.claim_error_alert(pg_temp.fp(f)) $$;
CREATE FUNCTION pg_temp.reset() RETURNS VOID LANGUAGE sql AS $$ DELETE FROM security_audit.browser_error_alerts; DELETE FROM security_audit.error_alerts $$;

-- 1. One signed-in person: five different browser errors claim, the sixth does not (company unknown / one company, same result).
SELECT pg_temp.reset();
DO $$
DECLARE i INT; r BOOLEAN;
BEGIN
  FOR i IN 1..5 LOOP
    PERFORM pg_temp.must('user 1 browser report ' || i || ' claims', pg_temp.bclaim(i, 1, 1));
  END LOOP;
  PERFORM pg_temp.must('user 1 sixth browser report in a day does NOT claim', pg_temp.bclaim(6, 1, 1) = FALSE);
  PERFORM pg_temp.must('user 1 seventh still does not', pg_temp.bclaim(7, 1, 1) = FALSE);
  PERFORM pg_temp.must('a refused claim records nothing', (SELECT count(*) FROM security_audit.browser_error_alerts) = 5);
  -- Another person is not affected by user 1's spent budget.
  PERFORM pg_temp.must('user 2 can still claim', pg_temp.bclaim(8, 2, 1));
END
$$;

-- 2. The same error again within the hour does not claim, whoever posts it, and does not use the poster's budget.
SELECT pg_temp.reset();
DO $$
BEGIN
  PERFORM pg_temp.must('first report of fingerprint 1 claims', pg_temp.bclaim(1, 1, 1));
  PERFORM pg_temp.must('same fingerprint, same person, within the hour: no claim', pg_temp.bclaim(1, 1, 1) = FALSE);
  PERFORM pg_temp.must('same fingerprint, other person, within the hour: no claim', pg_temp.bclaim(1, 2, 1) = FALSE);
  PERFORM pg_temp.must('repeats did not use user 2''s budget', (SELECT count(*) FROM security_audit.browser_error_alerts WHERE user_id = pg_temp.u(2)) = 0);
  UPDATE security_audit.browser_error_alerts SET claimed_at = now() - interval '61 minutes';
  PERFORM pg_temp.must('same fingerprint after an hour claims again', pg_temp.bclaim(1, 1, 1));
END
$$;

-- 3. A company: ten in all (two people, five each); a third person of that company gets none; a person of another company still does;
--    a report with no company known is limited by the person budget only.
SELECT pg_temp.reset();
DO $$
DECLARE i INT;
BEGIN
  FOR i IN 1..5 LOOP PERFORM pg_temp.must('company 1 user 1 report ' || i, pg_temp.bclaim(i, 1, 1)); END LOOP;
  FOR i IN 6..10 LOOP PERFORM pg_temp.must('company 1 user 2 report ' || i, pg_temp.bclaim(i, 2, 1)); END LOOP;
  PERFORM pg_temp.must('company 1 third person: company budget (10) spent, no claim', pg_temp.bclaim(11, 3, 1) = FALSE);
  PERFORM pg_temp.must('company 2 person still claims', pg_temp.bclaim(12, 4, 2));
  PERFORM pg_temp.must('no company known: person budget only', pg_temp.bclaim(13, 5, NULL));
END
$$;

-- 4. THE FINDING: all browser budgets spent platform-wide (4 people x 5 = 20) leaves the server and cron budget whole, and the server's
--    own 20 a day still stop at 20. Browser rows are never counted by claim_error_alert.
SELECT pg_temp.reset();
DO $$
DECLARE i INT; u INT; n INT := 0;
BEGIN
  FOR u IN 1..4 LOOP
    FOR i IN 1..5 LOOP n := n + 1; PERFORM pg_temp.must('browser claim ' || n, pg_temp.bclaim(n, u, u)); END LOOP;
  END LOOP;
  PERFORM pg_temp.must('browser budget platform-wide (20) spent: a fifth person gets none', pg_temp.bclaim(100, 5, 5) = FALSE);
  FOR i IN 1..20 LOOP PERFORM pg_temp.must('server alert ' || i || ' still claims after 20 browser claims', pg_temp.sclaim(200 + i)); END LOOP;
  PERFORM pg_temp.must('server alert 21 stops at the server''s own 20 a day', pg_temp.sclaim(300) = FALSE);
  PERFORM pg_temp.must('server alerts wrote only to their own table', (SELECT count(*) FROM security_audit.error_alerts) = 20 AND (SELECT count(*) FROM security_audit.browser_error_alerts) = 20);
END
$$;
-- ... and the other way round: a full server day does not stop a browser person's first report.
SELECT pg_temp.reset();
DO $$
DECLARE i INT;
BEGIN
  FOR i IN 1..20 LOOP PERFORM pg_temp.must('server alert ' || i, pg_temp.sclaim(i)); END LOOP;
  PERFORM pg_temp.must('server day full: browser report still has its own budget', pg_temp.bclaim(500, 1, 1));
END
$$;

-- 5. Next day resets: claims older than 24 hours stop counting, older than 2 days are removed.
SELECT pg_temp.reset();
DO $$
DECLARE i INT;
BEGIN
  FOR i IN 1..5 LOOP PERFORM pg_temp.must('day 1 claim ' || i, pg_temp.bclaim(i, 1, 1)); END LOOP;
  PERFORM pg_temp.must('day 1 sixth: no claim', pg_temp.bclaim(6, 1, 1) = FALSE);
  UPDATE security_audit.browser_error_alerts SET claimed_at = now() - interval '23 hours';
  PERFORM pg_temp.must('23 hours later: still no claim', pg_temp.bclaim(7, 1, 1) = FALSE);
  UPDATE security_audit.browser_error_alerts SET claimed_at = now() - interval '25 hours';
  PERFORM pg_temp.must('25 hours later: the person claims again', pg_temp.bclaim(8, 1, 1));
  UPDATE security_audit.browser_error_alerts SET claimed_at = now() - interval '3 days';
  PERFORM pg_temp.must('3 days later: the person claims', pg_temp.bclaim(9, 1, 1));
  PERFORM pg_temp.must('3 days later: the old rows are gone', (SELECT count(*) FROM security_audit.browser_error_alerts) = 1);
END
$$;

-- 6. Bad input is refused; nothing is recorded.
SELECT pg_temp.reset();
DO $$
BEGIN
  BEGIN PERFORM public.claim_browser_error_alert('not-a-hash', pg_temp.u(1), NULL); RAISE EXCEPTION 'PROOF FAILED: bad fingerprint accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  BEGIN PERFORM public.claim_browser_error_alert(pg_temp.fp(1), NULL, NULL); RAISE EXCEPTION 'PROOF FAILED: missing person accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  PERFORM pg_temp.must('bad input recorded nothing', (SELECT count(*) FROM security_audit.browser_error_alerts) = 0);
END
$$;

-- 7. Only the service role can ask (the app's admin client); a signed-in person or an anonymous caller cannot, and cannot read the table.
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r);
      PERFORM public.claim_browser_error_alert(pg_temp.fp(1), pg_temp.u(1), NULL);
      RESET ROLE;
      RAISE EXCEPTION 'PROOF FAILED: % can call claim_browser_error_alert', r;
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; RAISE NOTICE 'ok  % cannot call it', r; END;
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r);
      PERFORM 1 FROM security_audit.browser_error_alerts;
      RESET ROLE;
      RAISE EXCEPTION 'PROOF FAILED: % can read the table', r;
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; RAISE NOTICE 'ok  % cannot read the table', r; END;
  END LOOP;
  SET LOCAL ROLE service_role;
  PERFORM public.claim_browser_error_alert(pg_temp.fp(77), pg_temp.u(1), NULL);
  RESET ROLE;
  RAISE NOTICE 'ok  service_role can call it';
END
$$;

SELECT 'PROOF OK';

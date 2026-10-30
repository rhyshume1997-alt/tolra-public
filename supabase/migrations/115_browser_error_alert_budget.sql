-- =====================================================================================================
-- 115: browser-reported errors get their own, smaller e-mail budget (finding S4-F1, Low).
-- Before: app/api/report-error/route.ts (any signed-in person) and server alerts shared ONE budget, claim_error_alert (033): 20 e-mails
-- a day in all. A signed-in person could post 20 different error messages and use the whole day's budget up, so a real server or cron
-- failure that day would send no e-mail. (The error itself is still logged; only the e-mail was lost.)
-- After: a browser report is claimed with public.claim_browser_error_alert(fingerprint, user, company), counted in its own table.
--   * one e-mail per error fingerprint per hour (as before);
--   * at most 5 a day per signed-in person, 10 a day per company, and 20 a day for all browser reports together;
--   * server and cron alerts keep claim_error_alert and its 20 a day, untouched: browser rows are never counted there.
-- When a browser budget is spent the function answers FALSE; the app still logs the report, sends no e-mail and answers 200 exactly as
-- before, so the caller never learns the budget state.
-- Needs 033 (claim_error_alert, security_audit.error_alerts). Replaces no existing object (033's function and table are unchanged). Safe to
-- run again. Until this is applied the app falls back to claim_error_alert (the old shared budget), so deploy order does not matter.
-- NUMBERING: 115 is a working number. The table holds a fingerprint, the reporting person's and company's ids and a time; no message.
-- =====================================================================================================

DO $$
BEGIN
  IF to_regprocedure('public.claim_error_alert(text)') IS NULL OR to_regclass('security_audit.error_alerts') IS NULL THEN
    RAISE EXCEPTION '115 needs 033 (claim_error_alert, security_audit.error_alerts)';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS security_audit.browser_error_alerts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{12,64}$'),
  user_id     UUID NOT NULL,
  company_id  UUID,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS browser_error_alerts_fingerprint_time ON security_audit.browser_error_alerts (fingerprint, claimed_at DESC);
CREATE INDEX IF NOT EXISTS browser_error_alerts_user_time ON security_audit.browser_error_alerts (user_id, claimed_at DESC);
CREATE INDEX IF NOT EXISTS browser_error_alerts_company_time ON security_audit.browser_error_alerts (company_id, claimed_at DESC) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS browser_error_alerts_time ON security_audit.browser_error_alerts (claimed_at DESC);
REVOKE ALL ON security_audit.browser_error_alerts FROM PUBLIC, anon, authenticated, service_role;

-- TRUE when an e-mail for this browser-reported error may be sent now (and records it); FALSE when this fingerprint was already sent in
-- the last hour, or this person has had 5, this company 10, or all browser reports 20 e-mails in the last 24 hours.
CREATE OR REPLACE FUNCTION public.claim_browser_error_alert(p_fingerprint TEXT, p_user_id UUID, p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{12,64}$' OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Invalid browser error alert claim' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('browser-error-alert', 0));
  DELETE FROM security_audit.browser_error_alerts WHERE claimed_at < now() - INTERVAL '2 days';
  IF EXISTS (SELECT 1 FROM security_audit.browser_error_alerts WHERE fingerprint = p_fingerprint AND claimed_at > now() - INTERVAL '1 hour') THEN
    RETURN FALSE;
  END IF;
  IF (SELECT count(*) FROM security_audit.browser_error_alerts WHERE user_id = p_user_id AND claimed_at > now() - INTERVAL '1 day') >= 5 THEN
    RETURN FALSE;
  END IF;
  IF p_company_id IS NOT NULL
     AND (SELECT count(*) FROM security_audit.browser_error_alerts WHERE company_id = p_company_id AND claimed_at > now() - INTERVAL '1 day') >= 10 THEN
    RETURN FALSE;
  END IF;
  IF (SELECT count(*) FROM security_audit.browser_error_alerts WHERE claimed_at > now() - INTERVAL '1 day') >= 20 THEN
    RETURN FALSE;
  END IF;
  INSERT INTO security_audit.browser_error_alerts (fingerprint, user_id, company_id) VALUES (p_fingerprint, p_user_id, p_company_id);
  RETURN TRUE;
END
$$;
REVOKE ALL ON FUNCTION public.claim_browser_error_alert(TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_browser_error_alert(TEXT, UUID, UUID) TO service_role;

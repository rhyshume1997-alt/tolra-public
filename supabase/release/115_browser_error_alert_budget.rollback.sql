-- 115 rollback: ONLY with Rhys's approval. Removes the browser error alert budget (the function and its table of claims). Nothing else is
-- touched: 115 replaced no existing object, and server and cron alerts keep claim_error_alert and its 20 a day. The app then falls back to
-- claim_error_alert for browser reports too (the old shared budget), so no alert stops working. Run the whole text as one transaction, then
-- the release preflight (marker 115 shows "not applied").
BEGIN;

DROP FUNCTION IF EXISTS public.claim_browser_error_alert(TEXT, UUID, UUID);
DROP TABLE IF EXISTS security_audit.browser_error_alerts;

DO $$
BEGIN
  IF to_regprocedure('public.claim_browser_error_alert(text,uuid,uuid)') IS NOT NULL OR to_regclass('security_audit.browser_error_alerts') IS NOT NULL THEN
    RAISE EXCEPTION '115 rollback: the browser error alert budget is still there';
  END IF;
  IF to_regprocedure('public.claim_error_alert(text)') IS NULL THEN
    RAISE EXCEPTION '115 rollback: 033''s claim_error_alert is missing';
  END IF;
END
$$;

COMMIT;

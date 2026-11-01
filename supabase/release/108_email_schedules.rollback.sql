-- 108 rollback: ONLY with Rhys's approval. Removes the e-mail schedules (invoice reminders and timesheet e-mails): every company's
-- schedule settings, the run records and the reminder and timesheet records go with them. The app then shows "Not available until database update 108
-- is applied" and the cron route answers 200 with skipped. E-mails already sent stay sent. 108 replaced no existing object. Run the
-- whole text as one transaction, then the release preflight (marker 108 shows "not applied").
BEGIN;

DROP TABLE IF EXISTS public.timesheet_sends;
DROP TABLE IF EXISTS public.invoice_reminder_sends;
DROP TABLE IF EXISTS public.email_schedule_runs;
DROP TABLE IF EXISTS public.email_schedules;
DROP FUNCTION IF EXISTS public.email_schedules_guard();

DO $$
BEGIN
  IF to_regclass('public.email_schedules') IS NOT NULL OR to_regclass('public.email_schedule_runs') IS NOT NULL
     OR to_regclass('public.invoice_reminder_sends') IS NOT NULL OR to_regclass('public.timesheet_sends') IS NOT NULL OR to_regprocedure('public.email_schedules_guard()') IS NOT NULL THEN
    RAISE EXCEPTION '108 rollback: an e-mail schedule table or function is still there';
  END IF;
END
$$;

COMMIT;

-- 142 rollback: ONLY with Rhys's approval. Takes email_schedules back to 108's shape: drops 142's two checks and the weekdays column, after
-- turning every timesheet schedule on days back into one 108 can run:
--   all seven days            -> 'daily' (every day), as before 142;
--   one to six days           -> 'weekly' on the FIRST chosen day (Monday first; ISO 7 = Sunday becomes 0). Lossy: a schedule on several
--                                days keeps only that one day (108 has no "several days");
--   no days (only when it is off) -> stays 'daily', off.
-- 'once' rows and invoice reminders are not touched. A changed row's updated_at moves to now (108's row trigger), as in 142. Deploy the app
-- from before 142 with this rollback (the 142 app only shows timesheet e-mails once the weekdays column is there; its cron reads either).
-- Run the whole text as one transaction, then the release preflight (marker 142 shows "not applied").
BEGIN;
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  IF to_regclass('public.email_schedules') IS NULL THEN
    RAISE EXCEPTION '142 rollback: public.email_schedules (108) is missing; stop and compare';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.email_schedules_guard()') INTO v_md5;
  -- 3a93d38488b7c0cc50e419dc74125d9d: 108's email_schedules_guard (142 does not replace it).
  IF v_md5 IS DISTINCT FROM '3a93d38488b7c0cc50e419dc74125d9d' THEN
    RAISE EXCEPTION '142 rollback: public.email_schedules_guard is not 108''s (md5 without whitespace %); stop and compare', coalesce(v_md5, 'missing');
  END IF;
END
$$;

-- Timesheet schedules on days back to 108's daily / weekly (a second run finds no weekdays column and changes nothing).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_schedules' AND column_name = 'weekdays') THEN
    EXECUTE $q$
      UPDATE public.email_schedules
      SET frequency = 'weekly', weekday = (SELECT min(d) FROM unnest(weekdays) AS d) % 7
      WHERE kind = 'timesheet' AND frequency = 'daily' AND weekdays IS NOT NULL AND cardinality(weekdays) BETWEEN 1 AND 6
    $q$;
  END IF;
END
$$;

ALTER TABLE public.email_schedules DROP CONSTRAINT IF EXISTS email_schedules_timesheet_days;
ALTER TABLE public.email_schedules DROP CONSTRAINT IF EXISTS email_schedules_weekdays_valid;
ALTER TABLE public.email_schedules DROP COLUMN IF EXISTS weekdays;

COMMIT;

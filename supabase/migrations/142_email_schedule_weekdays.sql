-- =====================================================================================================
-- 142 (provisional number; the final one is given at merge): timesheet e-mails on chosen days of the week (E13, Rhys, 2 Nov).
-- Needs 108 (public.email_schedules and its row trigger email_schedules_guard, unchanged since 108). Touches no other migration's objects:
-- no function, policy, grant or trigger changes. RLS UNCHANGED: the company reads its schedules, only an admin writes them (108).
--
-- WHAT CHANGES.
--   a. public.email_schedules.weekdays SMALLINT[]: the days a timesheet schedule runs, ISO 8601 (1 = Monday ... 7 = Sunday), any of the
--      seven, each at most once. Used for kind 'timesheet' only (invoice reminders keep frequency / weekday / run_at exactly as before and
--      leave this NULL). A timesheet schedule on days is stored as frequency 'daily' with its weekdays: the cron sends it on those days at
--      time_of_day, once per local day (108's one run per schedule per period key; the key of a 'daily' schedule is the local date).
--   b. Two checks: email_schedules_weekdays_valid (NULL, or a one-dimensional list of distinct values in 1..7 with no NULL in it) and
--      email_schedules_timesheet_days (an enabled timesheet schedule that is not 'once' has at least one day).
--   c. Existing timesheet rows (the data change):
--        daily                -> weekdays {1,2,3,4,5,6,7} (frequency stays 'daily'): every day, as before;
--        weekly on weekday d  -> frequency 'daily', weekdays {d as ISO: Sunday 0 becomes 7, else the same number}, weekday NULL;
--        once                 -> unchanged (weekdays NULL): the once path keeps working for these old rows until an admin saves the card.
--      Invoice reminder rows are not touched. The update goes through 108's row trigger, so a changed row's updated_at moves to now: the cron
--      never sends an occurrence from before a schedule was last changed, so no period is sent twice under its new (date) key; an occurrence
--      that fell between its time and the next daily pass on the day this file runs is not sent (see the release note in the report).
-- GUARD (section 1): 108's table and checks are there and email_schedules_guard is 108's body (md5 with every whitespace character
-- removed), because section 4 relies on it. Safe to run again. SELF-CHECK (section 5).
-- Verify: supabase/verify/email_schedule_weekdays_142.sql (every row TRUE).
-- Rollback: supabase/release/142_email_schedule_weekdays.rollback.sql (only with Rhys's approval).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- 1. The guard.
DO $$
DECLARE
  v_md5 TEXT;
BEGIN
  IF to_regclass('public.email_schedules') IS NULL THEN
    RAISE EXCEPTION '142: public.email_schedules (108) is missing; apply 108 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.email_schedules'::regclass AND conname = 'email_schedules_frequency_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.email_schedules'::regclass AND conname = 'email_schedules_weekly_has_weekday') THEN
    RAISE EXCEPTION '142: 108''s frequency checks on public.email_schedules are missing; stop and compare';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_schedules' AND column_name = 'weekdays'
             AND udt_name <> '_int2') THEN
    RAISE EXCEPTION '142: public.email_schedules.weekdays exists with another type; stop and compare';
  END IF;
  SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.email_schedules_guard()') INTO v_md5;
  -- 3a93d38488b7c0cc50e419dc74125d9d: 108's email_schedules_guard (142 does not replace it).
  IF v_md5 IS DISTINCT FROM '3a93d38488b7c0cc50e419dc74125d9d' THEN
    RAISE EXCEPTION '142: public.email_schedules_guard is not 108''s (md5 without whitespace %); stop and compare it first', coalesce(v_md5, 'missing');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------------------------------
-- 2. The column.
ALTER TABLE public.email_schedules ADD COLUMN IF NOT EXISTS weekdays SMALLINT[];
COMMENT ON COLUMN public.email_schedules.weekdays IS
  'Timesheet schedules (142): the ISO days of the week it runs (1 = Monday ... 7 = Sunday), with frequency daily. NULL for invoice reminders and old once rows.';

-- -----------------------------------------------------------------------------------------------------
-- 3. Existing timesheet rows: daily is every day; weekly on a day is that one day. Once rows and invoice reminders are left alone.
UPDATE public.email_schedules SET weekdays = '{1,2,3,4,5,6,7}'::SMALLINT[]
WHERE kind = 'timesheet' AND frequency = 'daily' AND weekdays IS NULL;

UPDATE public.email_schedules SET frequency = 'daily', weekdays = ARRAY[CASE WHEN weekday = 0 THEN 7 ELSE weekday END]::SMALLINT[], weekday = NULL
WHERE kind = 'timesheet' AND frequency = 'weekly' AND weekday BETWEEN 0 AND 6;

-- -----------------------------------------------------------------------------------------------------
-- 4. The checks (after the rows above, so they hold for every row there is).
ALTER TABLE public.email_schedules DROP CONSTRAINT IF EXISTS email_schedules_weekdays_valid;
ALTER TABLE public.email_schedules ADD CONSTRAINT email_schedules_weekdays_valid CHECK (
  CASE
    WHEN weekdays IS NULL OR cardinality(weekdays) = 0 THEN TRUE
    WHEN array_ndims(weekdays) <> 1 OR array_position(weekdays, NULL::SMALLINT) IS NOT NULL THEN FALSE
    ELSE weekdays <@ '{1,2,3,4,5,6,7}'::SMALLINT[]
      AND cardinality(array_positions(weekdays, 1::SMALLINT)) <= 1 AND cardinality(array_positions(weekdays, 2::SMALLINT)) <= 1
      AND cardinality(array_positions(weekdays, 3::SMALLINT)) <= 1 AND cardinality(array_positions(weekdays, 4::SMALLINT)) <= 1
      AND cardinality(array_positions(weekdays, 5::SMALLINT)) <= 1 AND cardinality(array_positions(weekdays, 6::SMALLINT)) <= 1
      AND cardinality(array_positions(weekdays, 7::SMALLINT)) <= 1
  END
);
ALTER TABLE public.email_schedules DROP CONSTRAINT IF EXISTS email_schedules_timesheet_days;
ALTER TABLE public.email_schedules ADD CONSTRAINT email_schedules_timesheet_days CHECK (
  kind <> 'timesheet' OR NOT enabled OR frequency = 'once' OR coalesce(cardinality(weekdays), 0) > 0
);

-- -----------------------------------------------------------------------------------------------------
-- 5. Self-check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.email_schedules WHERE kind = 'timesheet' AND frequency = 'weekly') THEN
    RAISE EXCEPTION '142 self-check: a weekly timesheet schedule is left';
  END IF;
  IF EXISTS (SELECT 1 FROM public.email_schedules WHERE kind = 'timesheet' AND frequency = 'daily' AND weekdays IS NULL) THEN
    RAISE EXCEPTION '142 self-check: a daily timesheet schedule has no days';
  END IF;
END
$$;

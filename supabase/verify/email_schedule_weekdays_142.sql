-- Migration 142 (timesheet e-mails on chosen days of the week). Read only: every row should be TRUE (7). The two checks are compared as
-- Postgres prints them (pg_get_constraintdef) with every whitespace character removed; local proof ran on PG16. A FALSE on
-- checks_are_142s only: send the two printed definitions back for comparison before anything else.
WITH c AS (
  SELECT conname, convalidated, md5(regexp_replace(pg_get_constraintdef(oid), '\s', '', 'g')) AS def FROM pg_constraint
  WHERE conrelid = 'public.email_schedules'::regclass AND contype = 'c'
)
-- The column: SMALLINT[], nullable, no default.
SELECT 'weekdays_column' AS check_name,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_schedules' AND column_name = 'weekdays'
          AND udt_name = '_int2' AND is_nullable = 'YES' AND column_default IS NULL) AS ok
-- The two checks, validated, exactly 142's (values 1..7, no repeats, no NULL, one dimension; an enabled timesheet that is not once has a day).
UNION ALL SELECT 'checks_are_142s',
  (SELECT count(*) = 2 AND bool_and(convalidated) FROM c WHERE (conname, def) IN (('email_schedules_weekdays_valid', '98a89ae187facee1c1c7156198c935f7'),
                                                                                ('email_schedules_timesheet_days', '99a2cb584dcc84d76623250772ece178')))
-- 108's checks are all still there (142 adds two and drops none).
UNION ALL SELECT 'checks_108_kept',
  (SELECT count(*) = 6 FROM c WHERE conname IN ('email_schedules_frequency_check', 'email_schedules_kind_check', 'email_schedules_once_has_time',
                                                'email_schedules_timezone_check', 'email_schedules_weekday_check', 'email_schedules_weekly_has_weekday'))
-- No timesheet schedule is left weekly (142 moved them to days), and every daily timesheet schedule has its days.
UNION ALL SELECT 'timesheet_rows_on_days',
  NOT EXISTS (SELECT 1 FROM public.email_schedules WHERE kind = 'timesheet' AND (frequency = 'weekly' OR (frequency = 'daily' AND weekdays IS NULL)))
-- Invoice reminders carry no days (142 is for timesheets only).
UNION ALL SELECT 'reminders_have_no_days',
  NOT EXISTS (SELECT 1 FROM public.email_schedules WHERE kind = 'invoice_reminder' AND weekdays IS NOT NULL)
-- The row trigger is still 108's (142 replaces no function).
UNION ALL SELECT 'guard_is_108s',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '3a93d38488b7c0cc50e419dc74125d9d' FROM pg_proc p WHERE p.oid = to_regprocedure('public.email_schedules_guard()')), FALSE)
-- Row security unchanged: on, the company reads, only an admin writes (108's four policies, as 131 wrapped them), nothing for anon.
UNION ALL SELECT 'rls_unchanged',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.email_schedules'::regclass)
  AND (SELECT count(*) = 4 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_schedules'
       AND policyname IN ('email_schedules member select', 'email_schedules admin insert', 'email_schedules admin update', 'email_schedules admin delete'))
  AND (SELECT count(*) = 4 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_schedules')
  AND NOT has_table_privilege('anon', 'public.email_schedules', 'SELECT');

-- Migration 108 (e-mail schedules). Read only: every row should be TRUE (9).
WITH t AS (
  SELECT c.oid FROM pg_class c WHERE c.oid IN ('public.email_schedules'::regclass, 'public.email_schedule_runs'::regclass, 'public.invoice_reminder_sends'::regclass)
)
-- Three tables, row security on, nothing for anon.
SELECT 'tables_rls_on_closed_to_anon' AS check_name,
       (SELECT count(*) = 3 AND bool_and(relrowsecurity) FROM pg_class WHERE oid IN (SELECT oid FROM t))
       AND NOT has_table_privilege('anon', 'public.email_schedules', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.email_schedule_runs', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.invoice_reminder_sends', 'SELECT') AS ok
-- Runs and sends are written by the server only: signed-in users can read, never write.
UNION ALL SELECT 'runs_and_sends_read_only_for_members',
  has_table_privilege('authenticated', 'public.email_schedule_runs', 'SELECT') AND has_table_privilege('authenticated', 'public.invoice_reminder_sends', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.email_schedule_runs', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.email_schedule_runs', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.email_schedule_runs', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.invoice_reminder_sends', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.invoice_reminder_sends', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.invoice_reminder_sends', 'DELETE')
-- Schedules: members read (one SELECT policy, company only); only an admin writes (insert, update, delete policies all name admin).
UNION ALL SELECT 'schedules_member_read_admin_write',
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_schedules' AND cmd = 'SELECT' AND qual LIKE '%current_user_organization_id()%' AND qual NOT LIKE '%has_org_role%') = 1
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_schedules' AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
         AND coalesce(qual, with_check) LIKE '%has_org_role%' AND coalesce(qual, with_check) LIKE '%admin%' AND coalesce(qual, with_check) NOT LIKE '%office%') = 3
-- Runs and sends: SELECT policies only, admin and office, scoped through the schedule's company.
UNION ALL SELECT 'runs_and_sends_policies_select_only',
  (SELECT count(*) = 2 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('email_schedule_runs', 'invoice_reminder_sends') AND cmd = 'SELECT'
     AND qual LIKE '%current_user_organization_id()%' AND qual LIKE '%admin%office%')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('email_schedule_runs', 'invoice_reminder_sends') AND cmd <> 'SELECT')
-- Off by default.
UNION ALL SELECT 'off_by_default',
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_schedules' AND column_name = 'enabled' AND column_default = 'false')
-- One run per schedule per period; one reminder per invoice per schedule per period; one schedule per company per kind.
UNION ALL SELECT 'unique_keys',
  (SELECT count(*) FROM pg_constraint WHERE contype = 'u' AND conrelid = 'public.email_schedules'::regclass AND pg_get_constraintdef(oid) = 'UNIQUE (organization_id, kind)') = 1
  AND (SELECT count(*) FROM pg_constraint WHERE contype = 'u' AND conrelid = 'public.email_schedule_runs'::regclass AND pg_get_constraintdef(oid) = 'UNIQUE (schedule_id, period_key)') = 1
  AND (SELECT count(*) FROM pg_constraint WHERE contype = 'u' AND conrelid = 'public.invoice_reminder_sends'::regclass AND pg_get_constraintdef(oid) = 'UNIQUE (invoice_id, schedule_id, period_key)') = 1
-- The schedule's own guards: support read-only, admin second step, and the row trigger.
UNION ALL SELECT 'guards_on_schedules',
  (SELECT count(*) = 3 FROM pg_trigger WHERE tgrelid = 'public.email_schedules'::regclass AND NOT tgisinternal AND tgname IN ('support_read_only', 'admin_mfa', 'email_schedules_guard'))
-- The trigger function is internal: callable by no signed-in user, no definer rights.
UNION ALL SELECT 'guard_function_internal',
  to_regprocedure('public.email_schedules_guard()') IS NOT NULL
  AND NOT has_function_privilege('authenticated', 'public.email_schedules_guard()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.email_schedules_guard()', 'EXECUTE')
  AND NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.email_schedules_guard()'))
-- The checks that make a row mean something: weekly needs a weekday, once needs a moment.
UNION ALL SELECT 'weekly_and_once_checks',
  (SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'public.email_schedules'::regclass AND conname IN ('email_schedules_weekly_has_weekday', 'email_schedules_once_has_time'));

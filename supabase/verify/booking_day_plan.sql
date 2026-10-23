-- READ ONLY. Booking day plan migration (split a machine booking by day): run in a read-only transaction AFTER applying it on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 7 are facts about the schema and the data and must be "true". Rows 8 to 10 are informational:
-- how many bookings there are, how many are split by day, and how many of those include a Saturday or Sunday.
WITH
fn AS (SELECT p.proname, p.prosecdef, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
SELECT * FROM (
  SELECT 1 AS n, 'machine_bookings.day_plan exists, is jsonb and may be empty (NULL = the default rule)' AS check_name,
      (SELECT count(*) = 1 AND bool_and(data_type = 'jsonb' AND is_nullable = 'YES' AND column_default IS NULL)
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machine_bookings' AND column_name = 'day_plan')::text AS value, 'true' AS expected
  UNION ALL SELECT 2, 'The plan check is one validated constraint that uses booking_day_plan_ok',
      (SELECT count(*) = 1 AND bool_and(convalidated AND pg_get_constraintdef(oid) LIKE '%booking_day_plan_ok(day_plan, estimated_hours)%')
       FROM pg_constraint WHERE conrelid = 'public.machine_bookings'::regclass AND conname = 'machine_bookings_day_plan_check')::text, 'true'
  UNION ALL SELECT 3, 'booking_day_plan_ok exists once, is not SECURITY DEFINER, and is closed to anon',
      (SELECT count(*) = 1 AND NOT bool_or(prosecdef) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
       FROM fn WHERE proname = 'booking_day_plan_ok')::text, 'true'
  UNION ALL SELECT 4, 'Every stored plan passes the check (no bad plan can be in the table)',
      (SELECT count(*) = 0 FROM public.machine_bookings WHERE day_plan IS NOT NULL AND NOT public.booking_day_plan_ok(day_plan, estimated_hours))::text, 'true'
  UNION ALL SELECT 5, 'machine_bookings keeps row-level security and exactly its four tenant policies, none of them FOR ALL and none about day_plan',
      (SELECT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.machine_bookings'::regclass)
          AND (SELECT count(*) = 4 AND bool_and(cmd <> 'ALL' AND coalesce(qual, '') NOT LIKE '%day_plan%' AND coalesce(with_check, '') NOT LIKE '%day_plan%')
               FROM pg_policies WHERE schemaname = 'public' AND tablename = 'machine_bookings'
                 AND policyname IN ('machine_bookings tenant select', 'machine_bookings tenant insert', 'machine_bookings tenant update', 'machine_bookings tenant delete')))::text, 'true'
  UNION ALL SELECT 6, 'machine_bookings still carries the same-company, audit and read-only-support triggers',
      (SELECT count(*) = 4 FROM pg_trigger t WHERE t.tgrelid = 'public.machine_bookings'::regclass AND NOT t.tgisinternal
          AND t.tgname IN ('zz_same_org_job_id', 'zz_same_org_machine_id', 'audit_machine_bookings_changes', 'support_read_only'))::text, 'true'
  UNION ALL SELECT 7, 'anon and PUBLIC have no access to machine_bookings; authenticated can select (its writes go through the booking functions since 042; the rest of its grant list is pinned by the catalogue fingerprint)',
      (SELECT NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'machine_bookings' AND grantee IN ('anon', 'PUBLIC'))
          AND EXISTS (SELECT 1 FROM information_schema.role_table_grants
                      WHERE table_schema = 'public' AND table_name = 'machine_bookings' AND grantee = 'authenticated' AND privilege_type = 'SELECT'))::text, 'true'
  UNION ALL SELECT 8, 'Machine bookings', (SELECT count(*) FROM public.machine_bookings)::text, 'informational'
  UNION ALL SELECT 9, 'Bookings split by day', (SELECT count(*) FROM public.machine_bookings WHERE day_plan IS NOT NULL)::text, 'informational (0 until the first split)'
  UNION ALL SELECT 10, 'Split bookings with a Saturday or Sunday in the plan',
      -- CASE fixes the order: dates are only cast once the plan is known to be valid, so a bad row can't stop the whole report.
      (SELECT count(*) FROM public.machine_bookings b WHERE b.day_plan IS NOT NULL
         AND CASE WHEN public.booking_day_plan_ok(b.day_plan, b.estimated_hours)
                  THEN EXISTS (SELECT 1 FROM jsonb_array_elements(b.day_plan) e WHERE extract(isodow FROM (e.value ->> 'date')::date) IN (6, 7))
                  ELSE FALSE END)::text, 'informational'
) AS t
ORDER BY n;

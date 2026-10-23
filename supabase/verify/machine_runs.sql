-- READ ONLY. Machine runs migration (044): run in a read-only transaction AFTER applying it on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 13 are facts about the schema and the data and must be "true". Rows 14 to 17 are informational.
WITH
fn AS (SELECT p.proname, p.prosecdef, p.proconfig, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
SELECT * FROM (
  SELECT 1 AS n, 'machine_runs exists with the job, the machine, the operator, start, end, end reason, the displaced run and the client operation key' AS check_name,
      (SELECT count(*) = 9 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machine_runs'
          AND column_name IN ('job_id', 'machine_id', 'booking_id', 'operator_id', 'started_at', 'ended_at', 'end_reason', 'override_of', 'client_op_id'))::text AS value,
      'true' AS expected
  UNION ALL SELECT 2, 'one open run per machine is enforced by a unique partial index (ended_at IS NULL), and a client operation is one run per company and machine',
      ((SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'machine_runs' AND indexname = 'machine_runs_one_open_per_machine'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef ILIKE '%(machine_id)%' AND indexdef ILIKE '%ended_at IS NULL%')
       AND (SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'machine_runs' AND indexname = 'machine_runs_client_op' AND indexdef LIKE 'CREATE UNIQUE INDEX%'))::text, 'true'
  UNION ALL SELECT 3, 'machine_runs has row-level security with one select policy, and authenticated may only select (anon and PUBLIC nothing)',
      ((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.machine_runs'::regclass)
       AND (SELECT count(*) FILTER (WHERE cmd = 'SELECT') = 1 AND count(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'machine_runs')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'machine_runs' AND grantee IN ('anon', 'PUBLIC'))
       AND (SELECT array_agg(privilege_type::text) = ARRAY['SELECT'] FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'machine_runs' AND grantee = 'authenticated'))::text, 'true'
  UNION ALL SELECT 4, 'machine_runs carries the same-company (job, machine, booking, displaced run), audit, read-only-support and admin second-step triggers',
      (SELECT count(*) = 7 FROM pg_trigger WHERE tgrelid = 'public.machine_runs'::regclass AND NOT tgisinternal
         AND tgname IN ('zz_same_org_job_id', 'zz_same_org_machine_id', 'zz_same_org_booking_id', 'zz_same_org_override_of', 'audit_machine_runs_changes', 'support_read_only', 'admin_mfa'))::text, 'true'
  UNION ALL SELECT 5, 'jobs.assigned_to, assigned_at and assigned_by exist, kept by the assignment trigger; a plain finish of a job with open runs is refused by the guard trigger',
      ((SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'jobs' AND column_name IN ('assigned_to', 'assigned_at', 'assigned_by'))
       AND (SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND NOT tgisinternal AND tgname IN ('ab_assignment_keep', 'ac_finish_guard')))::text, 'true'
  UNION ALL SELECT 6, 'start_machine_run, pause_machine_run, finish_job, release_machine, assign_job, machines_in_use and assignable_people exist once each, SECURITY DEFINER with a pinned search_path, executable by authenticated and not by anon',
      (SELECT count(*) = 7 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
       FROM fn WHERE proname IN ('start_machine_run', 'pause_machine_run', 'finish_job', 'release_machine', 'assign_job', 'machines_in_use', 'assignable_people'))::text, 'true'
  UNION ALL SELECT 7, 'the internal pieces (machine_run_end, machine_booking_mirror, machine_run_client_time, jobs_finish_guard, jobs_assignment_keep) are not callable by the API roles; the old finish trigger is gone',
      ((SELECT count(*) = 5 AND NOT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE'))
        FROM fn WHERE proname IN ('machine_run_end', 'machine_booking_mirror', 'machine_run_client_time', 'jobs_finish_guard', 'jobs_assignment_keep'))
       AND NOT EXISTS (SELECT 1 FROM fn WHERE proname = 'jobs_finish_ends_runs'))::text, 'true'
  UNION ALL SELECT 8, 'No machine has two open runs, and every run is in its job''s and machine''s company',
      ((SELECT count(*) = 0 FROM (SELECT machine_id FROM public.machine_runs WHERE ended_at IS NULL AND machine_id IS NOT NULL GROUP BY machine_id HAVING count(*) > 1) d)
       AND (SELECT count(*) = 0 FROM public.machine_runs r JOIN public.jobs j ON j.id = r.job_id JOIN public.machines m ON m.id = r.machine_id
            WHERE j.organization_id <> r.organization_id OR m.organization_id <> r.organization_id))::text, 'true'
  UNION ALL SELECT 9, 'Every ended run ended at or after it started, with a reason; every open run has none',
      (SELECT count(*) = 0 FROM public.machine_runs WHERE (ended_at IS NOT NULL AND (ended_at < started_at OR end_reason IS NULL)) OR (ended_at IS NULL AND end_reason IS NOT NULL))::text, 'true'
  UNION ALL SELECT 10, 'no two runs of one machine overlap in time, open or closed: the exclusion constraint machine_runs_no_overlap (gist: machine =, [started_at, ended_at) &&) and the end-after-start check are in place (btree_gist installed)',
      ((SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_no_overlap' AND contype = 'x'
          AND pg_get_constraintdef(oid) ILIKE '%gist%machine_id WITH =%tstzrange(started_at, ended_at%&&%')
       AND (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_end_after_start' AND contype = 'c')
       AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'))::text, 'true'
  UNION ALL SELECT 11, 'machine_run_ops (the durable answer of a keyed Start or Pause) exists, keyed by company and client key, with row-level security, no policy and no grant to anon, authenticated or PUBLIC',
      ((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.machine_run_ops'::regclass)
       AND (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.machine_run_ops'::regclass AND contype = 'p'
              AND pg_get_constraintdef(oid) = 'PRIMARY KEY (organization_id, client_op_id)')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'machine_run_ops')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'machine_run_ops' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
       AND (SELECT count(*) = 3 FROM pg_trigger WHERE tgrelid = 'public.machine_run_ops'::regclass AND NOT tgisinternal AND tgname IN ('zz_same_org_job_id', 'support_read_only', 'admin_mfa')))::text, 'true'
  UNION ALL SELECT 12, 'No two runs of one machine overlap in the data, and every run with a device time kept aside started or ended at or after it would have',
      ((SELECT count(*) = 0 FROM public.machine_runs a JOIN public.machine_runs b ON a.machine_id = b.machine_id AND a.id < b.id
          AND tstzrange(a.started_at, a.ended_at, '[)') && tstzrange(b.started_at, b.ended_at, '[)'))
       AND (SELECT count(*) = 0 FROM public.machine_runs WHERE started_at < device_started_at OR ended_at < device_ended_at))::text, 'true'
  UNION ALL SELECT 13, 'machine_time (hours per machine, the union of its runs) is SECURITY DEFINER with a pinned search_path, executable by authenticated and not anon; tstz_union_hours and machine_run_end_conflicts are internal',
      ((SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
              AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) FROM fn WHERE proname = 'machine_time')
       AND (SELECT count(*) = 2 AND NOT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE'))
            FROM fn WHERE proname IN ('tstz_union_hours', 'machine_run_end_conflicts')))::text, 'true'
  UNION ALL SELECT 14, 'Machines in use now', (SELECT count(*) FROM public.machine_runs WHERE ended_at IS NULL AND machine_id IS NOT NULL)::text, 'informational'
  UNION ALL SELECT 15, 'Runs open for 12 hours or more (forgotten Finish or Pause; an admin can release the machine)', (SELECT count(*) FROM public.machine_runs WHERE ended_at IS NULL AND machine_id IS NOT NULL AND started_at < now() - interval '12 hours')::text, 'informational'
  UNION ALL SELECT 16, 'Jobs assigned to an operator', (SELECT count(*) FROM public.jobs WHERE assigned_to IS NOT NULL)::text, 'informational (0 until the first one)'
  UNION ALL SELECT 17, 'Runs whose device time could not be honoured (time conflicts: the server time was used, the device time kept on the row and audited MACHINE_RUN_TIME_CONFLICT)',
      (SELECT count(*) FROM public.machine_runs WHERE device_started_at IS NOT NULL OR device_ended_at IS NOT NULL)::text, 'informational'
) AS t
ORDER BY n;

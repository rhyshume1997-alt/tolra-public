-- READ ONLY. Migration 046 (Pause for bench jobs): run in a read-only transaction AFTER applying 046 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 12 are facts about the schema and the data and must be "true". Rows 13 and 14 are
-- informational. Rows 10 to 12: bench -> machine (a Start on a machine ends the job's bench run; no bench time beside machine time). supabase/verify/machine_runs.sql (044) stays true after 046 (its per-machine rows count machine runs only).
WITH
fn AS (SELECT p.proname, p.prosecdef, p.proconfig, p.provolatile, p.proacl, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
SELECT * FROM (
  SELECT 1 AS n, 'machine_runs.machine_id may be NULL (a bench run: the job worked with no machine)' AS check_name,
      (SELECT is_nullable = 'YES' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machine_runs' AND column_name = 'machine_id')::text AS value,
      'true' AS expected
  UNION ALL SELECT 2, 'A bench run has no booking and no override and ends only by a Pause, a Finish or a move to a machine (CHECK machine_runs_bench_shape)',
      (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_bench_shape' AND contype = 'c')::text, 'true'
  UNION ALL SELECT 3, 'One open bench run per job: unique partial index machine_runs_one_open_bench_per_job (job_id) WHERE machine_id IS NULL AND ended_at IS NULL',
      (SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'machine_runs' AND indexname = 'machine_runs_one_open_bench_per_job'
         AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexdef ILIKE '%(job_id)%' AND indexdef ILIKE '%machine_id IS NULL%' AND indexdef ILIKE '%ended_at IS NULL%')::text, 'true'
  UNION ALL SELECT 4, 'No two bench runs of one job overlap in time: exclusion constraint machine_runs_bench_no_overlap (gist: job =, [started_at, ended_at) &&, WHERE machine_id IS NULL); 044''s per-machine constraint still in place',
      ((SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_bench_no_overlap' AND contype = 'x'
          AND pg_get_constraintdef(oid) ILIKE '%gist%job_id WITH =%tstzrange(started_at, ended_at%&&%machine_id IS NULL%')
       AND (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_no_overlap' AND contype = 'x')
       AND (SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'machine_runs' AND indexname = 'machine_runs_one_open_per_machine'))::text, 'true'
  UNION ALL SELECT 5, 'A client key makes one bench run per company: unique partial index machine_runs_bench_client_op',
      (SELECT count(*) = 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'machine_runs' AND indexname = 'machine_runs_bench_client_op' AND indexdef LIKE 'CREATE UNIQUE INDEX%')::text, 'true'
  UNION ALL SELECT 6, 'machine_runs: row-level security with one select policy; authenticated may only select, anon and PUBLIC nothing (unchanged by 046)',
      ((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.machine_runs'::regclass)
       AND (SELECT count(*) FILTER (WHERE cmd = 'SELECT') = 1 AND count(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'machine_runs')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'machine_runs' AND grantee IN ('anon', 'PUBLIC'))
       AND (SELECT coalesce(array_agg(DISTINCT privilege_type::text), ARRAY[]::text[]) = ARRAY['SELECT'] FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'machine_runs' AND grantee = 'authenticated'))::text, 'true'
  UNION ALL SELECT 7, 'start_machine_run opens bench runs (calls bench_run_open), is SECURITY DEFINER with a pinned search_path and the second-step check, executable by authenticated and not anon',
      (SELECT count(*) = 1 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') AND bool_and(position('bench_run_open' IN pg_get_functiondef(oid)) > 0)
              AND bool_and(position('assert_privileged_aal' IN pg_get_functiondef(oid)) > 0)
              AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
       FROM fn WHERE proname = 'start_machine_run')::text, 'true'
  UNION ALL SELECT 8, 'bench_runs_state is SECURITY DEFINER, STABLE, pinned search_path, executable by authenticated only (not anon, not PUBLIC); bench_run_open is internal (no API role)',
      ((SELECT count(*) = 1 AND bool_and(prosecdef AND provolatile = 's' AND proconfig::text LIKE '%search_path=%') AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE'))
              AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND NOT bool_or(EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
        FROM fn WHERE proname = 'bench_runs_state')
       AND (SELECT count(*) = 1 AND NOT bool_or(prosecdef) AND NOT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE'))
            FROM fn WHERE proname = 'bench_run_open'))::text, 'true'
  UNION ALL SELECT 9, 'The data: no job has two open bench runs, no two bench runs of a job overlap, every bench run has no booking or override and is in its job''s company',
      ((SELECT count(*) = 0 FROM (SELECT job_id FROM public.machine_runs WHERE machine_id IS NULL AND ended_at IS NULL GROUP BY job_id HAVING count(*) > 1) d)
       AND (SELECT count(*) = 0 FROM public.machine_runs a JOIN public.machine_runs b ON a.job_id = b.job_id AND a.id < b.id AND a.machine_id IS NULL AND b.machine_id IS NULL
              AND tstzrange(a.started_at, a.ended_at, '[)') && tstzrange(b.started_at, b.ended_at, '[)'))
       AND (SELECT count(*) = 0 FROM public.machine_runs r JOIN public.jobs j ON j.id = r.job_id
              WHERE r.machine_id IS NULL AND (r.booking_id IS NOT NULL OR r.override_of IS NOT NULL OR j.organization_id <> r.organization_id)))::text, 'true'
  UNION ALL SELECT 10, 'No bench time beside machine time of one job: exclusion constraint machine_runs_bench_machine_no_overlap (gist: job =, bench-or-machine <>, [started_at, ended_at) &&); end reason ''to_machine'' allowed for bench runs only (machine_runs_end_reason_check)',
      ((SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_bench_machine_no_overlap' AND contype = 'x'
          AND pg_get_constraintdef(oid) ILIKE '%gist%job_id WITH =%machine_id IS NULL%WITH <>%tstzrange(started_at, ended_at%&&%')
       AND (SELECT count(*) = 1 FROM pg_constraint WHERE conrelid = 'public.machine_runs'::regclass AND conname = 'machine_runs_end_reason_check' AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%to_machine%' AND pg_get_constraintdef(oid) LIKE '%admin_released%' AND pg_get_constraintdef(oid) ILIKE '%machine_id IS NULL%'))::text, 'true'
  UNION ALL SELECT 11, 'start_machine_run ends the open bench run when the work moves to a machine (''to_machine'', audited BENCH_TO_MACHINE); bench_runs_state reports the job''s actual work (state, on_machine)',
      ((SELECT count(*) = 1 AND bool_and(position('''to_machine''' IN pg_get_functiondef(oid)) > 0) AND bool_and(position('BENCH_TO_MACHINE' IN pg_get_functiondef(oid)) > 0)
        FROM fn WHERE proname = 'start_machine_run')
       AND (SELECT count(*) = 1 AND bool_and(pg_get_function_result(oid) LIKE '%on_machine boolean%' AND pg_get_function_result(oid) LIKE '%state text%')
            FROM fn WHERE proname = 'bench_runs_state'))::text, 'true'
  UNION ALL SELECT 12, 'The data: no job has an open bench run and an open machine run, no bench run overlaps a machine run of its job, ''to_machine'' only on bench runs',
      ((SELECT count(*) = 0 FROM public.machine_runs b JOIN public.machine_runs m ON m.job_id = b.job_id AND b.machine_id IS NULL AND m.machine_id IS NOT NULL
          AND tstzrange(b.started_at, b.ended_at, '[)') && tstzrange(m.started_at, m.ended_at, '[)'))
       AND (SELECT count(*) = 0 FROM public.machine_runs WHERE end_reason = 'to_machine' AND machine_id IS NOT NULL))::text, 'true'
  UNION ALL SELECT 13, 'Jobs on the bench now (an open bench run)', (SELECT count(*) FROM public.machine_runs WHERE machine_id IS NULL AND ended_at IS NULL)::text, 'informational (0 until the first one)'
  UNION ALL SELECT 14, 'Bench runs recorded (all time)', (SELECT count(*) FROM public.machine_runs WHERE machine_id IS NULL)::text, 'informational (0 right after 046)'
) AS t
ORDER BY n;

-- Migration 051 (job labour: operator_sessions). Read only: every row should be TRUE.
SELECT 'tables_present' AS check_name,
  to_regclass('public.operator_sessions') IS NOT NULL AND to_regclass('public.labour_ops') IS NOT NULL AS ok
UNION ALL SELECT 'rls_enabled', (
  SELECT bool_and(c.relrowsecurity) AND count(*) = 2 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('operator_sessions', 'labour_ops'))
UNION ALL SELECT 'no_direct_api_writes', NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['operator_sessions', 'labour_ops']) t, unnest(ARRAY['anon', 'authenticated']) r,
                unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
  WHERE has_table_privilege(r, 'public.' || t, p))
  AND NOT has_table_privilege('authenticated', 'public.labour_ops', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.operator_sessions', 'SELECT')
UNION ALL SELECT 'one_open_per_person_and_job', to_regclass('public.operator_sessions_one_open') IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.operator_sessions'::regclass AND conname = 'operator_sessions_no_overlap' AND contype = 'x')
UNION ALL SELECT 'writers_signed_in_only', (
  SELECT bool_and(p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
         AND count(*) = 4
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('record_labour_event', 'add_labour_session', 'correct_labour_session', 'void_labour_session'))
UNION ALL SELECT 'internal_functions_only', NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('labour_lock', 'labour_lock_job_people', 'labour_answer', 'labour_open', 'labour_close', 'labour_close_all', 'labour_write_failed', 'labour_assert_week_open', 'machine_runs_labour', 'jobs_finish_labour', 'labour_may_change', 'labour_check_times')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')))
-- Start / Pause / Finish write labour in the same transaction (AFTER triggers on machine_runs and jobs).
UNION ALL SELECT 'board_triggers', EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.machine_runs'::regclass AND tgname = 'zz_machine_runs_labour' AND tgenabled = 'O')
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.jobs'::regclass AND tgname = 'zz_jobs_finish_labour' AND tgenabled = 'O')
-- Lock order: the company's audit-chain lock, then the person's labour lock, both taken BEFORE a labour write asks whether the week is
-- approved (approve_time_week, 052, takes the same locks): the sheet's Start/Stop, the board's Start (and its Pause/Finish, which lock
-- everyone with time open on the job), the plain Finish, and the person's add / correct / void (asked again under the lock).
UNION ALL SELECT 'lock_before_week_check', (
  SELECT position('time_company_lock(' IN p.prosrc) BETWEEN 1 AND position('''labour:''' IN p.prosrc)
  FROM pg_proc p WHERE p.oid = 'public.labour_lock(uuid, uuid)'::regprocedure)
  AND (SELECT position('labour_lock(' IN p.prosrc) BETWEEN 1 AND position('time_week_locked_at' IN p.prosrc)
       FROM pg_proc p WHERE p.oid = 'public.record_labour_event(uuid, uuid, text, timestamptz)'::regprocedure)
  AND (SELECT position('labour_lock(' IN p.prosrc) BETWEEN 1 AND position('labour_assert_week_open' IN p.prosrc)
              AND position('labour_lock_job_people(' IN p.prosrc) > 0
       FROM pg_proc p WHERE p.oid = 'public.machine_runs_labour()'::regprocedure)
  AND (SELECT position('labour_lock_job_people(' IN p.prosrc) BETWEEN 1 AND position('labour_assert_week_open' IN p.prosrc)
       FROM pg_proc p WHERE p.oid = 'public.jobs_finish_labour()'::regprocedure)
  AND (SELECT bool_and(position('labour_lock(' IN p.prosrc) > 0
                       AND position('labour_may_change(' IN substr(p.prosrc, position('labour_lock(' IN p.prosrc))) > 0) AND count(*) = 3
       FROM pg_proc p
       WHERE p.oid IN ('public.add_labour_session(uuid, uuid, uuid, timestamptz, timestamptz, text)'::regprocedure,
                       'public.correct_labour_session(uuid, timestamptz, timestamptz, text)'::regprocedure,
                       'public.void_labour_session(uuid, text)'::regprocedure))
UNION ALL SELECT 'record_guards', (
  SELECT count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.operator_sessions'::regclass AND tgenabled = 'O' AND tgname IN ('support_read_only', 'admin_mfa'))
-- Data: every session is a person of that company on a job of that company; a voided row has its reason; corrections keep a reason.
UNION ALL SELECT 'sessions_consistent', NOT EXISTS (
  SELECT 1 FROM public.operator_sessions s JOIN public.jobs j ON j.id = s.job_id WHERE j.organization_id <> s.organization_id)
  AND NOT EXISTS (SELECT 1 FROM public.operator_sessions s
                  WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id = s.organization_id AND m.user_id = s.user_id))
UNION ALL SELECT 'no_open_overlaps', NOT EXISTS (
  SELECT 1 FROM public.operator_sessions s WHERE s.voided_at IS NULL AND s.ended_at IS NULL
  GROUP BY s.user_id, s.job_id HAVING count(*) > 1);

-- Informational: sessions still open for more than 14 hours (someone forgot to Stop), newest first.
SELECT o.slug AS company, s.user_id, j.job_no, s.started_at, round(extract(epoch FROM now() - s.started_at) / 3600.0, 1) AS hours_open
FROM public.operator_sessions s JOIN public.jobs j ON j.id = s.job_id JOIN public.organizations o ON o.id = s.organization_id
WHERE s.ended_at IS NULL AND s.voided_at IS NULL AND s.started_at < now() - INTERVAL '14 hours'
ORDER BY s.started_at DESC LIMIT 50;

-- Boundary. Inputs: none. Output: one row per check, every ok must be true. Read only; changes nothing. Must not change: it proves release 158, it is
-- never edited to make a check pass.
-- Read only: after release 158 (machine run integrity: pause_machine_run and finish_job use the server's time whenever another operator has an open run or job
-- time on the job; registered in supabase/release-plan.json as phase 158, after 157), every row must say true. Proves: both functions are 158's, still
-- definer with the pinned search path, callable by signed-in users and not by anon; neither keeps a path where the device's time reaches a run or session
-- (no assignment of the device time to the effective time, no use of the supplied time when ending a run); the device time is still recorded in the audit
-- log; release preflight's 158 marker condition holds.
SELECT 'pause: pause_machine_run is 158''s body, SECURITY DEFINER, search_path = pg_catalog, public' AS check_name,
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
            AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b00c08c8ee4934428f278fa6beadde1b') AS ok
UNION ALL SELECT 'finish: finish_job is 158''s body, SECURITY DEFINER, search_path = pg_catalog, public',
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.finish_job(uuid,uuid,timestamptz)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
            AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '154bb3fff8179ce2f26c1810f054e18f')
UNION ALL SELECT 'grants: both are callable by signed-in users and not by anon',
  has_function_privilege('authenticated', 'public.pause_machine_run(uuid,uuid[],uuid,timestamptz)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.pause_machine_run(uuid,uuid[],uuid,timestamptz)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.finish_job(uuid,uuid,timestamptz)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.finish_job(uuid,uuid,timestamptz)', 'EXECUTE')
UNION ALL SELECT 'rule: both decide the server time from other people''s open runs and sessions, after their locks, and never assign the device time to the effective time',
  (SELECT count(*) = 2 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)'), to_regprocedure('public.finish_job(uuid,uuid,timestamptz)'))
     AND p.prosrc LIKE '%v_at := clock_timestamp()%' AND p.prosrc LIKE '%IS DISTINCT FROM auth.uid()%' AND p.prosrc LIKE '%public.operator_sessions s%'
     AND p.prosrc LIKE '%v_device_at := public.machine_run_client_time(p_%' AND p.prosrc NOT LIKE '%v_at := public.machine_run_client_time%'
     AND p.prosrc NOT LIKE '%machine_run_end(v_run.id, p_%' AND p.prosrc NOT LIKE '%finished_at = p_%')
UNION ALL SELECT 'audit: the device time is still recorded (client_ended_at, client_finished_at and the MACHINE_RUN_TIME_CONFLICT event when the server time is used)',
  (SELECT p.prosrc LIKE '%''client_ended_at'', p_ended_at%' AND p.prosrc LIKE '%''why'', ''other_operator_open''%' FROM pg_proc p WHERE p.oid = to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)'))
  AND (SELECT p.prosrc LIKE '%''client_finished_at'', p_finished_at%' AND p.prosrc LIKE '%''why'', ''other_operator_open''%' FROM pg_proc p WHERE p.oid = to_regprocedure('public.finish_job(uuid,uuid,timestamptz)'))
UNION ALL SELECT 'marker: release preflight''s "post-144 marker 158 machine_run_integrity" condition holds',
  coalesce((EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.pause_machine_run(uuid,uuid[],uuid,timestamptz)') AND p.prosecdef AND p.proconfig IS NOT NULL
             AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b00c08c8ee4934428f278fa6beadde1b')
      AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.finish_job(uuid,uuid,timestamptz)') AND p.prosecdef AND p.proconfig IS NOT NULL
             AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '154bb3fff8179ce2f26c1810f054e18f')), FALSE);

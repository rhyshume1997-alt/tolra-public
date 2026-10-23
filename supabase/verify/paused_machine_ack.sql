-- READ ONLY. Migration 049 (paused-machine acknowledgement, explicit bench Start, request-bound Start replay): run in a read-only transaction
-- AFTER applying 049 on a hosted project. Changes nothing.
--
--   begin transaction read only;  <this file>  commit;
--
-- Rows (n | check | value | expected). Rows 1 to 8 are facts about the schema and the data and must be "true". Rows 9 to 11 are
-- informational. supabase/verify/bench_pause.sql (046) stays true after 049 (rows 7 and 11: start_machine_run still opens bench runs and
-- ends them on a machine Start, one signature).
WITH
fn AS (SELECT p.proname, p.prosecdef, p.proconfig, p.provolatile, p.proacl, p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
SELECT * FROM (
  SELECT 1 AS n, 'start_machine_run exists ONCE, with 8 arguments (p_paused_ack jsonb, p_bench boolean after 046''s six)' AS check_name,
      ((SELECT count(*) = 1 FROM fn WHERE proname = 'start_machine_run')
       AND to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)') IS NOT NULL
       AND to_regprocedure('public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)') IS NULL)::text AS value,
      'true' AS expected
  UNION ALL SELECT 2, 'start_machine_run, paused_machines and acknowledge_paused_machine are SECURITY DEFINER with a pinned search_path and start with the second-step check (paused_machines: read-only, STABLE)',
      ((SELECT count(*) = 3 AND bool_and(prosecdef AND proconfig::text LIKE '%search_path=%') FROM fn WHERE proname IN ('start_machine_run', 'paused_machines', 'acknowledge_paused_machine'))
       AND (SELECT bool_and(position('assert_privileged_aal' IN pg_get_functiondef(oid)) > 0) FROM fn WHERE proname IN ('start_machine_run', 'acknowledge_paused_machine'))
       AND (SELECT bool_and(provolatile = 's') FROM fn WHERE proname = 'paused_machines'))::text, 'true'
  UNION ALL SELECT 3, 'Grants: the three API functions executable by authenticated, never by anon or PUBLIC; paused_machine_current and machine_run_request_sha256 by no API role',
      ((SELECT count(*) = 3 AND bool_and(has_function_privilege('authenticated', oid, 'EXECUTE')) AND NOT bool_or(has_function_privilege('anon', oid, 'EXECUTE'))
              AND NOT bool_or(EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
        FROM fn WHERE proname IN ('start_machine_run', 'paused_machines', 'acknowledge_paused_machine'))
       AND (SELECT count(*) = 2 AND NOT bool_or(prosecdef) AND NOT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE') OR has_function_privilege('anon', oid, 'EXECUTE'))
            FROM fn WHERE proname IN ('paused_machine_current', 'machine_run_request_sha256')))::text, 'true'
  UNION ALL SELECT 4, 'start_machine_run keeps 046''s bench rules (bench_run_open, ''to_machine'', BENCH_TO_MACHINE) and records START_OVER_PAUSED_JOB; its replay is bound to the person and the request (request_sha256)',
      (SELECT count(*) = 1 AND bool_and(position('bench_run_open' IN pg_get_functiondef(oid)) > 0) AND bool_and(position('''to_machine''' IN pg_get_functiondef(oid)) > 0)
              AND bool_and(position('BENCH_TO_MACHINE' IN pg_get_functiondef(oid)) > 0) AND bool_and(position('START_OVER_PAUSED_JOB' IN pg_get_functiondef(oid)) > 0)
              AND bool_and(position('request_sha256' IN pg_get_functiondef(oid)) > 0) AND bool_and(position('paused_machine_current' IN pg_get_functiondef(oid)) > 0)
       FROM fn WHERE proname = 'start_machine_run')::text, 'true'
  UNION ALL SELECT 5, 'machine_run_ops.request_sha256 exists (nullable: rows written before 049 keep NULL)',
      (SELECT is_nullable = 'YES' AND data_type = 'text' FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'machine_run_ops' AND column_name = 'request_sha256')::text, 'true'
  UNION ALL SELECT 6, 'paused_ack_ops: row-level security on, no policy, no grant to anon or authenticated; primary key (organization_id, client_op_id)',
      ((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.paused_ack_ops'::regclass)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'paused_ack_ops')
       AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = 'paused_ack_ops' AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
       AND (SELECT pg_get_constraintdef(c.oid) = 'PRIMARY KEY (organization_id, client_op_id)' FROM pg_constraint c WHERE c.conrelid = 'public.paused_ack_ops'::regclass AND c.contype = 'p'))::text, 'true'
  UNION ALL SELECT 7, 'paused_ack_ops triggers: same company for machine, job and run (zz_same_org_*), support_read_only and admin_mfa statement guards',
      (SELECT count(*) = 5 FROM pg_trigger WHERE tgrelid = 'public.paused_ack_ops'::regclass AND NOT tgisinternal
         AND tgname IN ('zz_same_org_machine_id', 'zz_same_org_job_id', 'zz_same_org_paused_run_id', 'support_read_only', 'admin_mfa'))::text, 'true'
  UNION ALL SELECT 8, 'The data: no paused_ack_ops row whose machine, job or paused run belongs to another company, or whose run is not a paused machine run',
      (SELECT count(*) = 0 FROM public.paused_ack_ops o
         LEFT JOIN public.machines m ON m.id = o.machine_id
         LEFT JOIN public.jobs j ON j.id = o.job_id
         LEFT JOIN public.machine_runs r ON r.id = o.paused_run_id
       WHERE m.organization_id IS DISTINCT FROM o.organization_id OR j.organization_id IS DISTINCT FROM o.organization_id
          OR r.organization_id IS DISTINCT FROM o.organization_id OR r.machine_id IS DISTINCT FROM o.machine_id OR r.end_reason IS DISTINCT FROM 'paused')::text, 'true'
  UNION ALL SELECT 9, 'Start keys recorded without a request hash (written before 049; each replays for its own person only)',
      (SELECT count(*) FROM public.machine_run_ops o WHERE o.request_sha256 IS NULL AND o.kind = 'start')::text, 'informational (the pre-049 Starts; does not grow after 049)'
  UNION ALL SELECT 10, 'Starts over a paused machine recorded: acknowledged / not acknowledged (START_OVER_PAUSED_JOB)',
      (SELECT count(*) FILTER (WHERE metadata ->> 'acknowledged' = 'true') || ' / ' || count(*) FILTER (WHERE metadata ->> 'acknowledged' = 'false')
       FROM security_audit.audit_log WHERE action = 'START_OVER_PAUSED_JOB'), 'informational (0 / 0 right after 049)'
  UNION ALL SELECT 11, 'Bookings over a paused machine recorded: acknowledged / superseded (BOOK_OVER_PAUSED_JOB)',
      (SELECT count(*) FILTER (WHERE metadata ->> 'acknowledged' = 'true') || ' / ' || count(*) FILTER (WHERE metadata ->> 'acknowledged' = 'false')
       FROM security_audit.audit_log WHERE action = 'BOOK_OVER_PAUSED_JOB'), 'informational (0 / 0 right after 049)'
) AS t
ORDER BY n;

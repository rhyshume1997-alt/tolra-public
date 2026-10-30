-- Migration 118 (parts done on a job, logged from My jobs). Read only: every row should be TRUE (9).
SELECT 'table_columns' AS check_name,
  (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_part_logs')
    = 'client_op_id,id,job_id,logged_at,logged_by,note,organization_id,quantity' AS ok
-- RLS on, and exactly one policy: every signed-in member of the company reads its log.
UNION ALL SELECT 'rls_on_one_read_policy',
  coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.job_part_logs')), FALSE)
  AND (SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd, ',' ORDER BY policyname) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'job_part_logs') = 'job_part_logs rbac select PERMISSIVE SELECT'
-- Signed-in people may only read; anon nothing. Only log_job_parts writes.
UNION ALL SELECT 'grants_read_only',
  coalesce((SELECT string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee, privilege_type) FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'job_part_logs' AND grantee IN ('PUBLIC', 'anon', 'authenticated')), '')
    = 'authenticated:SELECT'
UNION ALL SELECT 'support_read_only_and_mfa_triggers',
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.job_part_logs') AND NOT tgisinternal AND tgname IN ('support_read_only', 'admin_mfa', 'audit_job_part_logs_changes', 'zz_same_org_job_id')) = 4
-- log_job_parts: definer with a fixed search path, signed-in people only (not anon, not PUBLIC).
UNION ALL SELECT 'log_definer_signed_in_only',
  coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.log_job_parts(uuid,integer,text,uuid)')), FALSE)
-- job_parts_done: NOT definer (the caller's own row rules apply), signed-in people only.
UNION ALL SELECT 'totals_invoker_signed_in_only',
  coalesce((SELECT NOT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_parts_done(uuid[])')), FALSE)
-- A workshop person logs on an assigned job only; admin and office on any; the event is written.
UNION ALL SELECT 'log_assigned_only_and_audited',
  coalesce((SELECT position('assigned_to' IN prosrc) > 0 AND position('ARRAY[''admin'', ''office'']' IN prosrc) > 0 AND position('LOG_JOB_PARTS' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.log_job_parts(uuid,integer,text,uuid)')), FALSE)
-- The total is kept between 0 and the quantity required, one tap at a time per job.
UNION ALL SELECT 'log_total_kept_between_zero_and_quantity',
  coalesce((SELECT position('below 0' IN prosrc) > 0 AND position('above the quantity required' IN prosrc) > 0 AND position('pg_advisory_xact_lock' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.log_job_parts(uuid,integer,text,uuid)')), FALSE)
-- A correction is a negative entry that says why.
UNION ALL SELECT 'correction_needs_a_note',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.job_part_logs') AND conname = 'job_part_logs_correction_says_why' AND contype = 'c');

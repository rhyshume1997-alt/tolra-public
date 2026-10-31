-- Migration 117 (a Problem on a job, from My jobs). Read only: every row should be TRUE (8).
SELECT 'table_columns' AS check_name,
  (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_problems')
    = 'id,job_id,note,organization_id,reason,reported_at,reported_by,request_id,resolution_note,resolved_at,resolved_by,status' AS ok
-- RLS on, and exactly one policy: every signed-in member of the company reads its problems.
UNION ALL SELECT 'rls_on_one_read_policy',
  coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.job_problems')), FALSE)
  AND (SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd, ',' ORDER BY policyname) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'job_problems') = 'job_problems rbac select PERMISSIVE SELECT'
-- Signed-in people may only read; anon nothing. Only the two functions write.
UNION ALL SELECT 'grants_read_only',
  coalesce((SELECT string_agg(grantee || ':' || privilege_type, ',' ORDER BY grantee, privilege_type) FROM information_schema.role_table_grants
            WHERE table_schema = 'public' AND table_name = 'job_problems' AND grantee IN ('PUBLIC', 'anon', 'authenticated')), '')
    = 'authenticated:SELECT'
UNION ALL SELECT 'support_read_only_and_mfa_triggers',
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.job_problems') AND NOT tgisinternal AND tgname IN ('support_read_only', 'admin_mfa', 'audit_job_problems_changes', 'zz_same_org_job_id')) = 4
-- The two functions: definer with a fixed search path, signed-in people only (not anon, not PUBLIC).
UNION ALL SELECT 'report_definer_signed_in_only',
  coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.report_job_problem(uuid,text,text,uuid)')), FALSE)
UNION ALL SELECT 'resolve_definer_signed_in_only',
  coalesce((SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
                   AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.resolve_job_problem(uuid,text)')), FALSE)
-- Only admin and office clear a problem; a workshop person raises on an assigned job only; both write a named event on the job.
UNION ALL SELECT 'resolve_admin_office_only_and_audited',
  coalesce((SELECT position('ARRAY[''admin'', ''office'']' IN prosrc) > 0 AND position('RESOLVE_JOB_PROBLEM' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.resolve_job_problem(uuid,text)')), FALSE)
UNION ALL SELECT 'report_assigned_only_and_audited',
  coalesce((SELECT position('assigned_to' IN prosrc) > 0 AND position('REPORT_JOB_PROBLEM' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.report_job_problem(uuid,text,text,uuid)')), FALSE);

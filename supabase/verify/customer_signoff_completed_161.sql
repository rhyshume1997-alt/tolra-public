-- Read only: after release 161 (a customer's sign-off only on a released job, never for a revision ahead of the job's; registered in
-- supabase/release-plan.json as phase 161, after 156), every row must say true. Inputs: none. Outputs: one row per check (check_name, ok).
-- Proves: public.sign_off_job_customer (the only form) is 161's body, still definer with its pinned settings and callable by signed-in
-- users only; 081's release rule it asks (job_release_state, job_early_release_active) is in place with its grants; and release
-- preflight's 161 marker condition holds. Must not change: this file only reads.
SELECT 'function: sign_off_job_customer is 161''s body (asks job_release_state; refuses job_not_released and shown_revision_ahead)' AS check_name,
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)')
            AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b8b2a0f43fac263f8b913c2f9f1d8e9f'
            AND p.prosrc LIKE '%job_release_state%' AND p.prosrc LIKE '%job_not_released%' AND p.prosrc LIKE '%shown_revision_ahead%') AS ok
UNION ALL SELECT 'function: there is exactly one sign_off_job_customer (the 12-argument form)',
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'sign_off_job_customer') = 1
  AND to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)') IS NOT NULL
UNION ALL SELECT 'function: sign_off_job_customer is definer with search_path pg_catalog, public, security_audit, extensions and TimeZone UTC',
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)')
            AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, security_audit, extensions', 'TimeZone=UTC'])
UNION ALL SELECT 'grants: sign_off_job_customer is callable by signed-in users, not by anon and not by PUBLIC',
  coalesce(has_function_privilege('authenticated', to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)'), 'EXECUTE'), FALSE)
  AND NOT coalesce(has_function_privilege('anon', to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)'), 'EXECUTE'), TRUE)
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)') AND a.grantee = 0)
UNION ALL SELECT 'release rule: job_release_state is 081''s (asks job_early_release_active), definer, callable by signed-in users, not anon',
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.job_release_state(uuid)') AND p.prosecdef AND p.prosrc LIKE '%job_early_release_active%')
  AND coalesce(has_function_privilege('authenticated', to_regprocedure('public.job_release_state(uuid)'), 'EXECUTE'), FALSE)
  AND NOT coalesce(has_function_privilege('anon', to_regprocedure('public.job_release_state(uuid)'), 'EXECUTE'), TRUE)
UNION ALL SELECT 'release rule: job_early_release_active exists and is callable by no API role (anon, authenticated)',
  to_regprocedure('public.job_early_release_active(uuid)') IS NOT NULL
  AND NOT coalesce(has_function_privilege('anon', to_regprocedure('public.job_early_release_active(uuid)'), 'EXECUTE'), TRUE)
  AND NOT coalesce(has_function_privilege('authenticated', to_regprocedure('public.job_early_release_active(uuid)'), 'EXECUTE'), TRUE)
UNION ALL SELECT 'staff sign-off: 045''s sign_off_job is still there (161 does not touch it)',
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'sign_off_job')
UNION ALL SELECT 'marker: release preflight''s "post-144 marker 161 customer_signoff_completed" condition holds',
  coalesce((EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)')
                      AND md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b8b2a0f43fac263f8b913c2f9f1d8e9f' AND p.prosecdef)
      AND coalesce(has_function_privilege('authenticated', to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)'), 'EXECUTE'), FALSE)
      AND NOT coalesce(has_function_privilege('anon', to_regprocedure('public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)'), 'EXECUTE'), TRUE)), FALSE);

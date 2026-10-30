-- Migration 113 (reopen sign-off: reopen_requests, reopen_preview, reopen_record, decide_reopen_request). Read only: every row should
-- be TRUE (8).
WITH f AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.reopen_preview(text,uuid)'), to_regprocedure('public.reopen_record(text,uuid,text,text)'),
                  to_regprocedure('public.decide_reopen_request(uuid,text,text)'))
)
-- The table exists with row level security on.
SELECT 'table_rls_on' AS check_name, coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.reopen_requests')), FALSE) AS ok
-- Signed-in users may only read; anon nothing.
UNION ALL SELECT 'grants_select_only',
  to_regclass('public.reopen_requests') IS NOT NULL AND has_table_privilege('authenticated', 'public.reopen_requests', 'SELECT')
  AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name = 'reopen_requests'
                  AND (g.grantee = 'anon' OR (g.grantee = 'authenticated' AND g.privilege_type <> 'SELECT')))
-- One SELECT policy: the caller's company. No write policy.
UNION ALL SELECT 'select_policy_own_company',
  (SELECT count(*) = 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reopen_requests' AND cmd = 'SELECT'
     AND qual LIKE '%current_user_organization_id()%')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reopen_requests' AND cmd <> 'SELECT')
-- The mode, status and decision checks.
UNION ALL SELECT 'checks_mode_status_decision',
  (SELECT count(*) = 3 FROM pg_constraint WHERE conrelid = to_regclass('public.reopen_requests')
     AND conname IN ('reopen_requests_mode', 'reopen_requests_status', 'reopen_requests_decision'))
-- The support read-only and admin second-step guards, and nothing else.
UNION ALL SELECT 'guards_on_table',
  (SELECT count(*) = 2 FROM pg_trigger tg WHERE tg.tgrelid = to_regclass('public.reopen_requests') AND NOT tg.tgisinternal AND tg.tgname IN ('support_read_only', 'admin_mfa'))
  AND (SELECT count(*) = 2 FROM pg_trigger tg WHERE tg.tgrelid = to_regclass('public.reopen_requests') AND NOT tg.tgisinternal)
-- The three app functions: definer, pinned search_path, signed-in only.
UNION ALL SELECT 'functions_definer_signed_in_only',
  (SELECT count(*) = 3 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                                    AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')) FROM f)
-- The internal helpers (audit, and the signed-off reopen that may pass an issued invoice): callable by no signed-in user.
UNION ALL SELECT 'internal_helpers_closed',
  to_regprocedure('public._reopen_audit(uuid,text,uuid,jsonb)') IS NOT NULL AND to_regprocedure('public._reopen_job_signed_off(uuid,text)') IS NOT NULL
  AND NOT has_function_privilege('authenticated', 'public._reopen_audit(uuid,text,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public._reopen_job_signed_off(uuid,text)', 'EXECUTE')
-- Every reopen goes through 081's reopen_job, which 113 does not replace (081's body); only its invoice_issued refusal is passed, by
-- the signed-off helper.
UNION ALL SELECT 'reopen_job_still_081',
  coalesce((SELECT md5(regexp_replace(prosrc, '\s', '', 'g')) = '2fca7e7164a55f9f9e0744f8a0c6b50e' FROM pg_proc WHERE oid = to_regprocedure('public.reopen_job(uuid,text)')), FALSE)
  AND coalesce((SELECT position('public._reopen_job_signed_off(p_record_id, v_reason)' IN prosrc) > 0 FROM pg_proc WHERE oid = to_regprocedure('public.reopen_record(text,uuid,text,text)')), FALSE)
  AND coalesce((SELECT position('RETURN public.reopen_job(p_job, p_reason)' IN prosrc) > 0 AND position('''invoice_issued''' IN prosrc) > 0
                FROM pg_proc WHERE oid = to_regprocedure('public._reopen_job_signed_off(uuid,text)')), FALSE);

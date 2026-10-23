-- Migration 083 (ISO 9001 7.2: only authorised inspectors record a pass or co-sign as the inspector; the list's history; the
-- backfill; inspect_job's check; 8.2 / 8.5.1 the drawing revision where a job requires it). Read only: every row should be TRUE. Bodies are compared with every whitespace character removed (an SQL-editor paste
-- may store CRLF).
WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.set_authorised_inspector(uuid,boolean,text,text)'), to_regprocedure('public.inspection_pass_authorised()'),
                  to_regprocedure('public.organization_members_inspector_history()'), to_regprocedure('public.iso_083_record_immutable()'))
),
rpc AS (SELECT * FROM f WHERE oid = to_regprocedure('public.set_authorised_inspector(uuid,boolean,text,text)')),
pass AS (SELECT * FROM f WHERE oid = to_regprocedure('public.inspection_pass_authorised()')),
hist AS (SELECT * FROM f WHERE oid = to_regprocedure('public.organization_members_inspector_history()')),
immut AS (SELECT * FROM f WHERE oid = to_regprocedure('public.iso_083_record_immutable()')),
trg AS (
  SELECT t.tgname, t.tgrelid::regclass::TEXT AS rel, t.tgfoid
  FROM pg_trigger t WHERE NOT t.tgisinternal
    AND t.tgrelid IN ('public.job_inspections'::regclass, 'public.job_signoffs'::regclass, 'public.organization_members'::regclass, to_regclass('public.inspector_authorisations'))
)
SELECT 'set_authorised_inspector_is_083' AS check_name,
       (SELECT body = '3feb78aa2e974acc776b223963a8440e' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit'] FROM rpc) AS ok
-- Signed-in users only (it checks admin, two-step sign-in and the company inside).
UNION ALL SELECT 'set_authorised_inspector_signed_in_only', (SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                                                                 AND NOT has_function_privilege('public', oid, 'EXECUTE') FROM rpc)
UNION ALL SELECT 'pass_check_is_083', (SELECT body = 'a3280e8e083ff65f62334c60d78fd997' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM pass)
UNION ALL SELECT 'history_writer_is_083', (SELECT body = '6719f28c0191905b51448888d0916dca' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM hist)
UNION ALL SELECT 'record_guard_is_083', (SELECT body = '2908fd0ebbd6f135c2e15bd36c679b62' AND NOT prosecdef FROM immut)
-- The trigger functions can't be called from the API.
UNION ALL SELECT 'trigger_functions_internal', (SELECT count(*) = 3 AND bool_and(NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', oid, 'EXECUTE'))
                                                 FROM f WHERE oid <> to_regprocedure('public.set_authorised_inspector(uuid,boolean,text,text)'))
-- Every pass and every inspector co-signature is checked, and every change of the flag is written to the history.
UNION ALL SELECT 'pass_check_on_inspections_and_signoffs',
  (SELECT count(*) = 2 FROM trg WHERE tgname = 'zz_inspection_pass_authorised' AND tgfoid = to_regprocedure('public.inspection_pass_authorised()')
                                  AND rel IN ('job_inspections', 'job_signoffs'))
UNION ALL SELECT 'history_trigger_on_members',
  EXISTS (SELECT 1 FROM trg WHERE tgname = 'zz_inspector_history' AND rel = 'organization_members' AND tgfoid = to_regprocedure('public.organization_members_inspector_history()'))
-- The history: RLS on, admin and office of the company read it, nobody writes it through the API, never changed or removed, audited,
-- and the support read-only and admin two-step guards like every company table.
UNION ALL SELECT 'history_table_locked_down',
  (SELECT c.relrowsecurity AND has_table_privilege('authenticated', c.oid, 'SELECT')
          AND NOT has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
          AND NOT has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
   FROM pg_class c WHERE c.oid = to_regclass('public.inspector_authorisations'))
UNION ALL SELECT 'history_policy_admin_office_same_company',
  (SELECT count(*) = 1 AND bool_and(p.polcmd = 'r' AND p.polpermissive AND pg_get_expr(p.polqual, p.polrelid) LIKE '%current_user_organization_id()%'
                                    AND pg_get_expr(p.polqual, p.polrelid) LIKE '%ARRAY[''admin''::text, ''office''::text]%')
   FROM pg_policy p WHERE p.polrelid = to_regclass('public.inspector_authorisations'))
UNION ALL SELECT 'history_triggers',
  (SELECT count(*) = 4 FROM trg WHERE rel = 'inspector_authorisations'
     AND tgname IN ('inspector_authorisations_immutable', 'audit_inspector_authorisations_changes', 'support_read_only', 'admin_mfa'))
-- The backfill: every active admin is on the list, and everyone on it has a history row.
UNION ALL SELECT 'admins_on_list',
  NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.active AND NOT m.support AND NOT m.can_inspect AND 'admin' IN (m.role, coalesce(m.secondary_role, '')))
UNION ALL SELECT 'every_inspector_has_history',
  NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.can_inspect
              AND NOT EXISTS (SELECT 1 FROM public.inspector_authorisations a WHERE a.organization_id = m.organization_id AND a.user_id = m.user_id AND a.change = 'added'))
-- inspect_job is 081's but for its interim check (only the list, admins included); same security and grants.
UNION ALL SELECT 'inspect_job_is_083',
  (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b411b17ef7cb8a5f3700957d9a7a264f' AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.inspect_job(uuid,text,text,text,integer,text,text,text,text,text,jsonb,uuid)'))
-- The drawing revision: the columns (off by default), the check on jobs (internal), and the setter (signed-in only).
UNION ALL SELECT 'drawing_revision_columns',
  (SELECT count(*) = 2 FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = 'jobs'
     AND ((c.column_name = 'drawing_revision_required' AND c.column_default = 'false' AND c.is_nullable = 'NO') OR (c.column_name = 'drawing_revision' AND c.data_type = 'text')))
UNION ALL SELECT 'drawing_revision_check_on_jobs',
  (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '5594dd93affd98aa4428f980b97d33b2' AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'jobs_zz_drawing_revision' AND t.tgrelid = 'public.jobs'::regclass AND t.tgfoid = p.oid)
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.jobs_drawing_revision_guard()'))
UNION ALL SELECT 'set_job_drawing_revision_is_083',
  (SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = 'b51f521600f522860edfdcb6d22363df' AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
          AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
   FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_job_drawing_revision(uuid,boolean,text,text)'));

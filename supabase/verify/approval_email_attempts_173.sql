-- Read-only checks for exact approval attempt links and callable boundaries.
SELECT 'approval attempt ledger columns present' AS check_name, count(*) = 3 AS ok FROM pg_attribute
WHERE attrelid = 'security_audit.company_email_sends'::regclass AND NOT attisdropped
AND attname IN ('approval_draft_id', 'approval_attempt', 'approval_resolution')
UNION ALL SELECT 'exact attempt index present', to_regclass('security_audit.company_email_approval_attempt') IS NOT NULL
UNION ALL SELECT 'exact attempt RPC boundary', count(*) = 4 AND coalesce(bool_and(p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public']
  AND has_function_privilege('authenticated', p.oid, 'execute') AND NOT has_function_privilege('anon', p.oid, 'execute')
  AND NOT has_function_privilege('service_role', p.oid, 'execute')), false)
FROM pg_proc p WHERE p.oid IN (
  to_regprocedure('public.approval_email_attempt_status(uuid,uuid,uuid)'),
  to_regprocedure('public.reserve_approval_email(uuid,uuid,uuid,text,text,text,text,text,text)'),
  to_regprocedure('public.resolve_approval_email(uuid,uuid,uuid,text)'),
  to_regprocedure('public.approval_email_failed_drafts(uuid[])')
);

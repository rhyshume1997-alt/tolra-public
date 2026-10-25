-- Migration 094 (the Activity page shows one row per change). Read only: every row should be TRUE (6). Bodies are compared with every
-- whitespace character removed (an SQL-editor paste may store CRLF).
WITH org AS (
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig, p.prosrc, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.org_activity(timestamptz,timestamptz,uuid,text,timestamptz,uuid,integer)')
)
-- org_activity: 080's body plus the two 094 filters; definer, STABLE, 080's search_path.
SELECT 'org_activity_is_094' AS check_name,
       coalesce((SELECT body = 'a29b5655c21474b4b40d54760de5a9c4' AND prosecdef AND provolatile = 's'
                   AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit'] FROM org), FALSE) AS ok
-- Signed-in only: authenticated may call it; anon and PUBLIC may not (as 080).
UNION ALL SELECT 'org_activity_signed_in_only',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = org.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM org), FALSE)
-- Same arguments and result columns as 080 (the page's call and its fields are unchanged).
UNION ALL SELECT 'org_activity_signature_unchanged',
  coalesce((SELECT pg_get_function_identity_arguments(oid) = 'p_from timestamp with time zone, p_to timestamp with time zone, p_actor uuid, p_table text, p_before timestamp with time zone, p_before_id uuid, p_limit integer'
              AND pg_get_function_result(oid) = 'TABLE(id uuid, created_at timestamp with time zone, actor_user_id uuid, actor_name text, actor_email text, action text, entity_table text, entity_id text, record_table text, record_id text, record_label text, changes jsonb, snapshot jsonb, metadata jsonb)'
            FROM org), FALSE)
-- Both filters are in the body: (a) the app's CREATE / UPDATE notes on a row-audited table, (b) a row change its stamp event named.
UNION ALL SELECT 'filters_in_body',
  coalesce((SELECT position('a.entity_table = ANY (v_row_audited)' IN prosrc) > 0
              AND position('security_audit.log_row_change()' IN prosrc) > 0
              AND position('p.hash = a.previous_hash' IN prosrc) > 0
              AND position('''ISSUE'', ''MARK_PAID'', ''RESEND'', ''CONFIRM'', ''REOPEN''' IN prosrc) > 0 FROM org), FALSE)
-- The admin-only check comes first, as 080's (a signed-in non-admin, or no session, is refused 42501).
UNION ALL SELECT 'admin_check_unchanged',
  coalesce((SELECT position('IF v_org IS NULL OR NOT public.has_org_role(ARRAY[''admin'']) THEN' IN prosrc) BETWEEN 1 AND position('RETURN QUERY' IN prosrc) FROM org), FALSE)
-- record_activity (a record's own history) is as it was before 094, and the audit log keeps its append-only guard.
UNION ALL SELECT 'record_activity_and_audit_log_unchanged',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '77ea2326f270aaecd59367e52c8a1eb7' FROM pg_proc p WHERE p.oid = to_regprocedure('public.record_activity(text,uuid,integer)')), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'security_audit.audit_log'::regclass AND tgname = 'audit_log_prevent_mutation' AND tgenabled = 'O');

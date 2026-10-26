-- Migration 095 (the audit log accepts the finance check's four events). Read only: every row should be TRUE (7). Bodies are compared
-- with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH aea AS (
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig, p.prosrc, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.audit_event_allowed(text,text)')
), wa AS (
  SELECT p.oid, p.prosecdef, p.provolatile, p.proconfig, p.prosrc, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.write_audit(text,text,text,jsonb,jsonb,jsonb,text,text)')
)
-- audit_event_allowed: 076's body plus the 095 block; invoker, STABLE, 076's search_path.
SELECT 'audit_event_allowed_is_095' AS check_name,
       coalesce((SELECT body = '7e8d396511ddb056daa61953bfccd12b' AND NOT prosecdef AND provolatile = 's'
                   AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM aea), FALSE) AS ok
-- write_audit: 035's body plus the 095 metadata rule; definer, VOLATILE, 035's search_path.
UNION ALL SELECT 'write_audit_is_095',
  coalesce((SELECT body = 'a6531bb5559ae9936387729bb91071a0' AND prosecdef AND provolatile = 'v'
              AND proconfig = ARRAY['search_path=pg_catalog, public, security_audit'] FROM wa), FALSE)
-- write_audit is signed-in only (as 035): authenticated may call it; anon and PUBLIC may not.
UNION ALL SELECT 'write_audit_signed_in_only',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = wa.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM wa), FALSE)
-- Same arguments and results as before (every caller unchanged).
UNION ALL SELECT 'signatures_unchanged',
  coalesce((SELECT pg_get_function_identity_arguments(oid) = 'p_action text, p_table text' AND pg_get_function_result(oid) = 'boolean' FROM aea), FALSE)
  AND coalesce((SELECT pg_get_function_identity_arguments(oid) = 'p_action text, p_entity_table text, p_entity_id text, p_old jsonb, p_new jsonb, p_metadata jsonb, p_ip text, p_user_agent text'
                   AND pg_get_function_result(oid) = 'void' FROM wa), FALSE)
-- The allow-list names the four events on the three document tables only, for admin and office.
UNION ALL SELECT 'allow_list_four_events_three_tables',
  coalesce((SELECT position('IF p_action IN (''ai_finance_check_requested'', ''ai_finance_check_completed'', ''ai_suggestion_accepted'', ''ai_suggestion_rejected'') THEN' IN prosrc) > 0
              AND position('RETURN p_table IN (''invoices'', ''purchase_orders'', ''credit_notes'') AND public.has_org_role(ARRAY[''admin'', ''office'']);' IN prosrc) > 0
            FROM aea), FALSE)
-- write_audit holds the four events to the app's three metadata shapes.
UNION ALL SELECT 'metadata_shapes_in_write_audit',
  coalesce((SELECT position('ARRAY[''checker'', ''kind'']' IN prosrc) > 0 AND position('ARRAY[''checker'', ''codes'', ''count'', ''kind'']' IN prosrc) > 0
              AND position('ARRAY[''checker'', ''code'', ''kind'', ''suggestion_id'']' IN prosrc) > 0
              AND position('''"rules-v1"''::JSONB' IN prosrc) > 0 FROM wa), FALSE)
-- The audit log keeps its append-only guard.
UNION ALL SELECT 'audit_log_append_only',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'security_audit.audit_log'::regclass AND tgname = 'audit_log_prevent_mutation' AND tgenabled = 'O');

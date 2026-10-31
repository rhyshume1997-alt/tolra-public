-- Migration 120 (email_history.drafted_by can't be changed by a signed-in user). Read only: every row should be TRUE (5). Bodies are
-- compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.email_history_drafted_by_lock()')
)
SELECT 'drafted_by_lock_is_120' AS check_name,
       coalesce((SELECT body = '14f7b3e1e4488d7df58a5e72568d2e91' AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM fn), FALSE) AS ok
-- Not callable by the API roles or PUBLIC.
UNION ALL SELECT 'drafted_by_lock_not_callable',
  coalesce((SELECT NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn), FALSE)
-- The trigger: on email_history, enabled, row level, BEFORE UPDATE only, on the drafted_by column.
UNION ALL SELECT 'drafted_by_lock_trigger_row_before_update',
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.email_history'::regclass AND tgname = 'email_history_drafted_by_lock' AND tgenabled = 'O'
            AND tgfoid = to_regprocedure('public.email_history_drafted_by_lock()') AND (tgtype & 1) = 1 AND (tgtype & 2) = 2
            AND (tgtype & 28) = 16 AND pg_get_triggerdef(oid) LIKE '%UPDATE OF drafted_by ON%')
-- 006's insert rule is still there (drafted_by = auth.uid()), so INSERT needs no trigger.
UNION ALL SELECT 'insert_policy_requires_drafted_by_auth_uid',
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'email_history' AND cmd = 'INSERT' AND permissive = 'PERMISSIVE'
            AND with_check LIKE '%drafted_by = auth.uid()%')
-- anon has no access to the table.
UNION ALL SELECT 'anon_no_access',
  NOT has_table_privilege('anon', 'public.email_history', 'INSERT') AND NOT has_table_privilege('anon', 'public.email_history', 'UPDATE');

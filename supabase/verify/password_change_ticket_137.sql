-- Migration 137 (G1: a password is changed only through Tolra's own server routes). Read only: every row should be TRUE (6).
-- Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.auth_users_password_change_ticket()'), to_regprocedure('public.issue_password_change_ticket(uuid,text)'),
                  to_regprocedure('public.revoke_password_change_ticket(uuid)'))
)
-- The three functions are 137's: definers with a pinned search_path; the trigger function refuses with HINT password_change_ticket_required.
SELECT 'functions_are_137' AS check_name,
  coalesce((SELECT count(*) = 3 AND bool_and(prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'])
                   AND bool_and(CASE proname WHEN 'auth_users_password_change_ticket' THEN body = '5fa1d17f4950cdf4e41c8a6fea67b2c5' AND position('password_change_ticket_required' IN prosrc) > 0
                                             WHEN 'issue_password_change_ticket' THEN body = 'a2936196b138dd7dee76db6be3b8ed82' AND position('60 seconds' IN prosrc) > 0
                                             WHEN 'revoke_password_change_ticket' THEN body = '42f77209ec079fa354f54ef78784a4b4' END)
            FROM fn), FALSE) AS ok
-- The trigger function only runs as the trigger: no EXECUTE for PUBLIC, anon, authenticated or service_role.
UNION ALL SELECT 'trigger_function_not_callable',
  to_regprocedure('public.auth_users_password_change_ticket()') IS NOT NULL
  AND NOT has_function_privilege('authenticated', 'public.auth_users_password_change_ticket()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.auth_users_password_change_ticket()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.auth_users_password_change_ticket()', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('public.auth_users_password_change_ticket()') AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
-- Issuing and revoking a ticket: the service role only (not PUBLIC, anon or authenticated).
UNION ALL SELECT 'ticket_functions_service_role_only',
  to_regprocedure('public.issue_password_change_ticket(uuid,text)') IS NOT NULL AND to_regprocedure('public.revoke_password_change_ticket(uuid)') IS NOT NULL
  AND has_function_privilege('service_role', 'public.issue_password_change_ticket(uuid,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.revoke_password_change_ticket(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.issue_password_change_ticket(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.issue_password_change_ticket(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.revoke_password_change_ticket(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.revoke_password_change_ticket(uuid)', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid IN (to_regprocedure('public.issue_password_change_ticket(uuid,text)'), to_regprocedure('public.revoke_password_change_ticket(uuid)'))
                  AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
-- The trigger: enabled, BEFORE UPDATE (no column list), FOR EACH ROW, on auth.users, calling that function.
UNION ALL SELECT 'trigger_in_place',
  EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'password_change_ticket' AND NOT t.tgisinternal AND t.tgenabled = 'O'
          AND t.tgfoid = to_regprocedure('public.auth_users_password_change_ticket()') AND t.tgtype = 19 AND t.tgattr = ''::int2vector)
-- The tickets: row-level security on, no policy, no grant to anyone.
UNION ALL SELECT 'tickets_closed',
  to_regclass('security_audit.password_change_tickets') IS NOT NULL
  AND (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('security_audit.password_change_tickets'))
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'security_audit' AND p.tablename = 'password_change_tickets')
  AND NOT has_table_privilege('authenticated', 'security_audit.password_change_tickets', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND NOT has_table_privilege('anon', 'security_audit.password_change_tickets', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND NOT has_table_privilege('service_role', 'security_audit.password_change_tickets', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
-- Untouched by 137: the two triggers 007 and 012 put on auth.users are still there and enabled.
UNION ALL SELECT 'earlier_auth_triggers_unchanged',
  (SELECT count(*) = 2 FROM pg_trigger t WHERE t.tgrelid = 'auth.users'::regclass AND NOT t.tgisinternal AND t.tgenabled = 'O'
   AND t.tgname IN ('on_auth_user_created_apply_invite', 'on_auth_user_signed_in_sync_last_login'));

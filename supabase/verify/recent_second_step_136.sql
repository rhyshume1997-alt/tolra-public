-- Migration 136 (G1: a recent authenticator code for giving or taking admin, in the database). Read only: every row should be TRUE (6).
-- Bodies are compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.prosrc, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.organization_members_recent_second_step()'), to_regprocedure('public.set_member_access(uuid,text,boolean,text,boolean,text[])'),
                  to_regprocedure('public.admin_set_company_access(uuid,uuid,text,text,boolean,boolean)'), to_regprocedure('public.is_api_role()'),
                  to_regprocedure('public.assert_privileged_aal()'))
)
-- The trigger function is 136's: a definer with a pinned search_path, refusing with HINT mfa_recent_required, for the authenticated role only,
-- against the company's own switch (organizations.require_admin_mfa), with the 900-second window on a totp entry in the token's amr list.
SELECT 'trigger_function_is_136' AS check_name,
  coalesce((SELECT body = '2af8bea37c6c34ccaffb8188a199054c' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND position('mfa_recent_required' IN prosrc) > 0 AND position('require_admin_mfa' IN prosrc) > 0
                   AND position('v_now - 900 AND v_now + 60' IN prosrc) > 0 AND position('''totp''' IN prosrc) > 0
            FROM fn WHERE proname = 'organization_members_recent_second_step'), FALSE) AS ok
-- Nobody can call it: it only runs as the trigger (no EXECUTE for PUBLIC, anon, authenticated or service_role).
UNION ALL SELECT 'trigger_function_not_callable',
  to_regprocedure('public.organization_members_recent_second_step()') IS NOT NULL
  AND NOT has_function_privilege('authenticated', 'public.organization_members_recent_second_step()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.organization_members_recent_second_step()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.organization_members_recent_second_step()', 'EXECUTE')
  AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('public.organization_members_recent_second_step()') AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
-- The trigger: enabled, BEFORE INSERT OR UPDATE OR DELETE, FOR EACH ROW, on organization_members, calling that function.
UNION ALL SELECT 'trigger_in_place',
  EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.organization_members'::regclass AND t.tgname = 'organization_members_recent_second_step' AND NOT t.tgisinternal
          AND t.tgenabled = 'O' AND t.tgfoid = to_regprocedure('public.organization_members_recent_second_step()')
          AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 8 AND (t.tgtype & 16) = 16)
-- Untouched by 136: the two functions it protects are 093's and keep their signed-in grants; 033's admin_mfa statement trigger is still there.
UNION ALL SELECT 'protected_functions_unchanged',
  coalesce((SELECT body = '2fc2a6a96b80cc9f7a7f8baf9b67df04' AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            FROM fn WHERE proname = 'set_member_access'), FALSE)
  AND coalesce((SELECT body = '378818d240f26ff55595ff4168f7a40e' AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
            FROM fn WHERE proname = 'admin_set_company_access'), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.organization_members'::regclass AND t.tgname = 'admin_mfa' AND NOT t.tgisinternal AND t.tgenabled = 'O')
-- The helpers the rule is built on are as 033 / 019 left them.
UNION ALL SELECT 'helpers_unchanged',
  coalesce((SELECT body = '378138e680ab587adf27fabb26bf45a2' FROM fn WHERE proname = 'is_api_role'), FALSE)
  AND coalesce((SELECT body = '1bb51f93999e5e2432a12e0f1ebef49e' FROM fn WHERE proname = 'assert_privileged_aal'), FALSE)
-- No signed-in write path was opened: organization_members still grants a signed-in user SELECT only.
UNION ALL SELECT 'no_signed_in_write_grant',
  has_table_privilege('authenticated', 'public.organization_members', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.organization_members', 'INSERT,UPDATE,DELETE')
  AND NOT has_table_privilege('anon', 'public.organization_members', 'SELECT,INSERT,UPDATE,DELETE');

-- Migration 093 (a company admin can never act on the platform owner's login). Read only: every row should be TRUE (8). Bodies are
-- compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH sca AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)')
),
sma AS (
  SELECT p.oid, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_member_access(uuid, text, boolean, text, boolean, text[])')
),
alp AS (
  SELECT p.oid, p.prosecdef, p.proconfig, p.provolatile, p.prorettype, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_login_is_protected(uuid)')
)
-- admin_set_company_access: 066's body plus the protected_login refusal; definer, fixed search_path, signed-in only.
SELECT 'admin_set_company_access_is_093' AS check_name,
       coalesce((SELECT body = '378818d240f26ff55595ff4168f7a40e' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM sca), FALSE) AS ok
-- The refusal is in the body, with its hint, after 066's own refusals (unknown_login, support_membership) which are still there.
UNION ALL SELECT 'refusal_in_body',
  coalesce((SELECT position('''protected_login''' IN p.prosrc) > position('''support_membership''' IN p.prosrc)
              AND position('''support_membership''' IN p.prosrc) > position('''unknown_login''' IN p.prosrc)
              AND position('''unknown_login''' IN p.prosrc) > 0 AND position('''other_company_login''' IN p.prosrc) > 0
              AND position('security_audit.platform_admins a WHERE a.user_id = p_user' IN p.prosrc) > 0
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)')), FALSE)
-- set_member_access: 066's body plus the protected_login refusal (only a switch-off passes); definer, fixed search_path, signed-in only.
UNION ALL SELECT 'set_member_access_is_093',
  coalesce((SELECT body = '2fc2a6a96b80cc9f7a7f8baf9b67df04' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
              AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM sma), FALSE)
UNION ALL SELECT 'set_member_access_refusal_after_support_check',
  coalesce((SELECT position('''protected_login''' IN p.prosrc) > position('A support membership can only be switched off' IN p.prosrc)
              AND position('A support membership can only be switched off' IN p.prosrc) > 0
              AND position('p_active IS DISTINCT FROM FALSE)' IN p.prosrc) > 0 AND position('''last_company''' IN p.prosrc) > 0
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_member_access(uuid, text, boolean, text, boolean, text[])')), FALSE)
-- admin_login_is_protected: 093's body, STABLE, BOOLEAN, definer with the fixed search_path.
UNION ALL SELECT 'admin_login_is_protected_is_093',
  coalesce((SELECT body = 'a938b2269bd2554f36acf0beaf7bb8f3' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
              AND provolatile = 's' AND prorettype = 'boolean'::regtype FROM alp), FALSE)
-- Signed-in only: authenticated may call it; anon and PUBLIC may not.
UNION ALL SELECT 'admin_login_is_protected_signed_in_only',
  coalesce((SELECT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = alp.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM alp), FALSE)
-- Outside a signed-in admin's session (here: no token at all) it answers TRUE: fail closed, nothing revealed.
UNION ALL SELECT 'answers_true_without_a_session',
  CASE WHEN to_regprocedure('public.admin_login_is_protected(uuid)') IS NULL THEN FALSE
       ELSE coalesce((xpath('/row/v/text()', query_to_xml($q$SELECT public.admin_login_is_protected(NULL)
              AND public.admin_login_is_protected('00000000-0000-4000-8000-000000000000'::UUID) AS v$q$, FALSE, TRUE, '')))[1]::TEXT = 'true', FALSE) END
-- 066's other functions are as 066 left them (093 replaced only admin_set_company_access).
UNION ALL SELECT 'my_admin_companies_unchanged',
  coalesce((SELECT md5(regexp_replace(p.prosrc, '\s', '', 'g')) = '89170f5f4f9b798c6ccf8d0236f91975' FROM pg_proc p WHERE p.oid = to_regprocedure('public.my_admin_companies()')), FALSE);

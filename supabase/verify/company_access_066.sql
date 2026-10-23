-- Migration 066 (per-company access in Admin > Users; Deactivate keeps a login's last company). Read only: every row should be TRUE (7).
-- The second query lists logins that hold no active company at all today (already true before 066: e.g. people deactivated
-- everywhere); 066 never creates one. Emails only; nothing is changed.
SELECT 'functions_present' AS check_name, (
  to_regprocedure('public.my_admin_companies()') IS NOT NULL
  AND to_regprocedure('public.admin_company_access(uuid)') IS NOT NULL
  AND to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)') IS NOT NULL
) AS ok
-- SECURITY DEFINER with a fixed search_path, so nothing a caller puts on their path is ever used.
UNION ALL SELECT 'definer_fixed_search_path', (
  SELECT coalesce(bool_and(p.prosecdef AND coalesce(array_to_string(p.proconfig, ',') LIKE '%search_path=pg_catalog, public%', FALSE)), FALSE) AND count(*) = 3
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('my_admin_companies', 'admin_company_access', 'admin_set_company_access')
)
-- Signed-in only: authenticated may run them; anon and PUBLIC may not.
UNION ALL SELECT 'signed_in_only', (
  SELECT coalesce(bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                           AND p.proacl IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')), FALSE)
         AND count(*) = 3
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('my_admin_companies', 'admin_company_access', 'admin_set_company_access')
)
-- The function checks the target company's second-step rule, the session's (033) and every safeguard named in RELEASE.md "066".
UNION ALL SELECT 'safeguards_in_body', coalesce((
  SELECT position('assert_privileged_aal' IN p.prosrc) > 0 AND position('require_admin_mfa' IN p.prosrc) > 0
     AND position('''last_admin''' IN p.prosrc) > 0 AND position('''last_company''' IN p.prosrc) > 0
     AND position('''self_removal''' IN p.prosrc) > 0 AND position('''self_demotion''' IN p.prosrc) > 0
     AND position('''support_membership''' IN p.prosrc) > 0 AND position('FOR UPDATE' IN p.prosrc) > 0
     AND position('security_audit.audit_log' IN p.prosrc) > 0
     AND position('''unknown_login''' IN p.prosrc) > 0 AND position('''reactivated''' IN p.prosrc) > 0
     AND position('''other_company_login''' IN p.prosrc) > 0
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.admin_set_company_access(uuid, uuid, text, text, boolean, boolean)')
), FALSE)
-- Deactivate on the session's company (set_member_access) keeps a login's last company too, under the 066 lock; still SECURITY
-- DEFINER with the fixed search_path, signed-in only, and still the second-step check first (033).
UNION ALL SELECT 'set_member_access_keeps_last_company', coalesce((
  SELECT position('''last_company''' IN pg_get_functiondef(p.oid)) > 0
     AND position('ORDER BY x.organization_id, x.user_id' IN p.prosrc) > 0
     AND position('assert_privileged_aal' IN p.prosrc) > 0
     AND p.prosecdef AND coalesce(array_to_string(p.proconfig, ',') LIKE '%search_path=pg_catalog, public%', FALSE)
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.set_member_access(uuid, text, boolean, text, boolean, text[])')
), FALSE)
-- A client can't record the three events through write_audit: only the function writes them.
UNION ALL SELECT 'events_not_client_writable', NOT (
  public.audit_event_allowed('GRANT_COMPANY_ACCESS', 'user_profiles')
  OR public.audit_event_allowed('CHANGE_COMPANY_ROLE', 'user_profiles')
  OR public.audit_event_allowed('REMOVE_COMPANY_ACCESS', 'user_profiles')
)
-- What 066 relies on is in place: 065's enrolment flag trigger and 033's statement rule on memberships.
UNION ALL SELECT 'relies_on_065_and_033', (
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organization_members'::regclass AND tgname = 'organization_members_mfa_enrolment' AND tgenabled = 'O')
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organization_members'::regclass AND tgname = 'admin_mfa' AND tgenabled = 'O')
);

SELECT p.email AS login_without_active_company
FROM public.user_profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
  WHERE m.user_id = p.id AND m.active AND NOT m.support AND o.status = 'active')
ORDER BY p.email;

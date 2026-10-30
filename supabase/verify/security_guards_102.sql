-- Migration 102 (database guards: archive setting admin only; admins change only their own company's people; the AI key never reaches
-- a signed-in session and only the server settles; quote-attachments private). Read only: every row should be TRUE (10). Bodies are
-- compared with every whitespace character removed (an SQL-editor paste may store CRLF).
WITH fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, md5(regexp_replace(p.prosrc, '\s', '', 'g')) AS body
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.organization_settings_guard_nav()'), to_regprocedure('public.user_profiles_guard()'),
                  to_regprocedure('public.admin_may_edit_profile(uuid)'), to_regprocedure('public.admin_may_read_profile(uuid)'), to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'),
                  to_regprocedure('public.ai_helper_settle(uuid,text,text,integer,text,jsonb)'))
), pol AS (
  SELECT policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles'
)
-- Z4: organization_settings_guard_nav is 058's plus the archive_after_months check (admin only); definer, pinned, still on the table.
SELECT 'org_settings_guard_archive_admin_only' AS check_name,
  coalesce((SELECT body = '99579bb09f2fcf9458103b3128af20c8' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM fn WHERE proname = 'organization_settings_guard_nav'), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.organization_settings'::regclass AND tgname = 'organization_settings_guard_nav' AND tgenabled = 'O')
-- Z3: an admin updates only their own company's people (active, not support, no other company, not protected).
UNION ALL SELECT 'admin_update_policy_own_people_only',
  EXISTS (SELECT 1 FROM pol WHERE policyname = 'Admins update org members' AND cmd = 'UPDATE' AND roles = '{authenticated}'
            AND qual = 'admin_may_edit_profile(id)' AND with_check = 'admin_may_edit_profile(id)')
-- Z3: the helper the update policy reads: 102's body; definer, pinned; signed-in only.
UNION ALL SELECT 'admin_may_edit_profile_signed_in_only',
  coalesce((SELECT body = '3f00f1c6bf03c3b47fe5581cbb3cbf31' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = 'admin_may_edit_profile'), FALSE)
-- Z3 and T2: the read policy is 007's rule minus protected logins (the platform owner's, support logins) and shared logins.
UNION ALL SELECT 'admin_read_policy_own_people_only',
  EXISTS (SELECT 1 FROM pol WHERE policyname = 'Admins read org members' AND cmd = 'SELECT' AND roles = '{authenticated}'
            AND qual = 'admin_may_read_profile(id)' AND with_check IS NULL)
-- Z3 and T2: the helper the read policy reads: 102's body; definer, pinned; signed-in only.
UNION ALL SELECT 'admin_may_read_profile_signed_in_only',
  coalesce((SELECT body = '9a77654f7a587fe1bc3d0da2a8f5808d' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = 'admin_may_read_profile'), FALSE)
-- The user's own row stays theirs (000's policies, unchanged), and no other UPDATE policy on user_profiles.
UNION ALL SELECT 'user_profiles_update_policies_unchanged_otherwise',
  (SELECT count(*) = 2 FROM pol WHERE cmd = 'UPDATE') AND EXISTS (SELECT 1 FROM pol WHERE policyname = 'Users update own profile' AND qual = '(auth.uid() = id)')
-- T1: user_profiles_guard is 012's plus the other-company check on full_name, organization and workshop_email; definer, pinned.
UNION ALL SELECT 'user_profiles_guard_is_102',
  coalesce((SELECT body = '986ea8500279eb9724eae987797281a7' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public'] FROM fn WHERE proname = 'user_profiles_guard'), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.user_profiles'::regclass AND tgname = 'user_profiles_guard' AND tgenabled = 'O')
-- S2: ai_helper_reserve is 102's (101's without the key in its answer); still definer and signed-in only.
UNION ALL SELECT 'reserve_returns_no_key',
  coalesce((SELECT body = 'c75e470a73e4d0e7508a27125f6f9e9c' AND prosecdef AND has_function_privilege('authenticated', oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM fn WHERE proname = 'ai_helper_reserve'), FALSE)
-- S3: ai_helper_settle is 102's and callable by the service role only (not authenticated, anon or PUBLIC).
UNION ALL SELECT 'settle_service_role_only',
  coalesce((SELECT body = 'ca5166191666584107491f95ccce4702' AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public']
                   AND has_function_privilege('service_role', oid, 'EXECUTE')
                   AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE')
                   AND NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = fn.oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
            FROM fn WHERE proname = 'ai_helper_settle'), FALSE)
-- T3: the quote-attachments bucket is private.
UNION ALL SELECT 'quote_attachments_private',
  NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'quote-attachments' AND public);

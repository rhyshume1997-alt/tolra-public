-- Migration 129 ("Invite your accountant": an expiring, single-use viewer invite on organization_invites). Read only: every row should be TRUE (12).
SELECT 'five_columns_nullable' AS check_name,
  (SELECT string_agg(column_name || ':' || is_nullable, ',' ORDER BY column_name) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organization_invites' AND column_name IN ('created_by', 'expires_at', 'revoked_at', 'token_hash', 'used_at'))
    = 'created_by:YES,expires_at:YES,revoked_at:YES,token_hash:YES,used_at:YES' AS ok
-- An ordinary invite has none of the five; an accountant invite has a hash, the role viewer and an expiry.
UNION ALL SELECT 'shape_check',
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.organization_invites') AND conname = 'organization_invites_accountant_shape' AND convalidated)
UNION ALL SELECT 'token_hash_unique',
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'organization_invites' AND indexname = 'organization_invites_token_hash_uniq')
UNION ALL SELECT 'ordinary_invites_untouched',
  NOT EXISTS (SELECT 1 FROM public.organization_invites WHERE token_hash IS NULL AND (expires_at IS NOT NULL OR used_at IS NOT NULL OR revoked_at IS NOT NULL))
-- Same single read policy as 007 (admins of the company); signed-in people read every column but the token hash and write nothing.
UNION ALL SELECT 'policy_unchanged',
  coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass('public.organization_invites')), FALSE)
  AND (SELECT string_agg(policyname || ' ' || permissive || ' ' || cmd, ',' ORDER BY policyname) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'organization_invites') = 'organization_invites admins read PERMISSIVE SELECT'
UNION ALL SELECT 'token_hash_not_readable_no_writes',
  NOT has_column_privilege('authenticated', 'public.organization_invites', 'token_hash', 'SELECT')
  AND has_column_privilege('authenticated', 'public.organization_invites', 'email', 'SELECT')
  AND has_column_privilege('authenticated', 'public.organization_invites', 'expires_at', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.organization_invites', 'INSERT, UPDATE, DELETE, TRUNCATE')
  AND NOT has_table_privilege('anon', 'public.organization_invites', 'SELECT, INSERT, UPDATE, DELETE')
-- The three signed-in functions: definer with a fixed search path, signed-in people only (not anon, not PUBLIC).
UNION ALL SELECT 'create_redeem_revoke_definer_signed_in_only',
  (SELECT count(*) FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.create_accountant_invite(text,text)'), to_regprocedure('public.redeem_accountant_invite(text)'),
                                                  to_regprocedure('public.revoke_accountant_invite(uuid)'))
     AND p.prosecdef AND p.proconfig = ARRAY['search_path=pg_catalog, public, security_audit']
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) = 3
UNION ALL SELECT 'peek_server_only',
  coalesce((SELECT p.prosecdef AND has_function_privilege('service_role', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.accountant_invite_peek(text)')), FALSE)
-- Create: admin, second step always, role viewer, 7 days, audited.
UNION ALL SELECT 'create_admin_aal2_viewer_7_days_audited',
  coalesce((SELECT position('ARRAY[''admin'']' IN prosrc) > 0 AND position('''aal2''' IN prosrc) > 0 AND position('''viewer''' IN prosrc) > 0
                   AND position('interval ''7 days''' IN prosrc) > 0 AND position('ACCOUNTANT_INVITE_CREATED' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.create_accountant_invite(text,text)')), FALSE)
-- Redeem: open invites only, the invite's e-mail, viewer, never changes an existing membership, audited.
UNION ALL SELECT 'redeem_once_viewer_audited',
  coalesce((SELECT position('used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()' IN prosrc) > 0 AND position('invite_other_email' IN prosrc) > 0
                   AND position('ON CONFLICT (user_id, organization_id) DO NOTHING' IN prosrc) > 0 AND position('ACCOUNTANT_INVITE_USED' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.redeem_accountant_invite(text)')), FALSE)
UNION ALL SELECT 'revoke_admin_audited',
  coalesce((SELECT position('ARRAY[''admin'']' IN prosrc) > 0 AND position('ACCOUNTANT_INVITE_REVOKED' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.revoke_accountant_invite(uuid)')), FALSE)
-- The sign-up trigger skips used, revoked and expired accountant invites, deletes only ordinary ones, and is still on auth.users.
UNION ALL SELECT 'sign_up_trigger_skips_closed_accountant_invites',
  coalesce((SELECT position('i.token_hash IS NULL OR (i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now())' IN prosrc) > 0
                   AND position('AND token_hash IS NULL;' IN prosrc) > 0 AND position('ACCOUNTANT_INVITE_USED' IN prosrc) > 0
            FROM pg_proc WHERE oid = to_regprocedure('public.handle_new_auth_user()')), FALSE)
  AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('auth.users') AND tgname = 'on_auth_user_created_apply_invite' AND tgenabled <> 'D')
-- add_member (service role only) supersedes an accountant invite (audited) instead of failing on it, under create's lock.
UNION ALL SELECT 'add_member_supersedes_accountant_invite',
  coalesce((SELECT p.prosecdef AND position('ACCOUNTANT_INVITE_SUPERSEDED' IN p.prosrc) > 0 AND position('token_hash = NULL' IN p.prosrc) > 0
                   AND position('revoked_at = now()' IN p.prosrc) > 0 AND position('accountant_invite:' IN p.prosrc) > 0
                   AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = to_regprocedure('public.add_member(uuid,text,text)')), FALSE);
